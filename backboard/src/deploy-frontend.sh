#!/bin/bash
set -euo pipefail

# =============================================================================
# Backboard Frontend Deploy
# Reusable builder EC2 -> sync frontend -> AMI -> update LT -> ASG refresh
# Production instances are NEVER touched directly.
# Builder instance persists between deploys for speed.
# =============================================================================

ASG_NAME="Backboard-api-ASG"
SSH_KEY="${DEPLOY_SSH_KEY:-$HOME/.ssh/id_rsa}"
REMOTE_USER="ec2-user"
REMOTE_FRONTEND_PATH="/home/ec2-user/backboard-api/frontend/"
AMI_NAME_PREFIX="backboard-api-golden"
BUILDER_TAG="backboard-builder"
INSTANCE_REFRESH_MIN_HEALTHY=50
INSTANCE_REFRESH_MAX_HEALTHY=100
INSTANCE_REFRESH_WARMUP=60

BUILDER_ID=""
BUILDER_IP=""

load_env() {
    local f="${1:-.env}"
    [ -f "$f" ] || return 0
    while IFS= read -r line || [ -n "$line" ]; do
        line="${line#"${line%%[![:space:]]*}"}"
        line="${line%"${line##*[![:space:]]}"}"
        case "$line" in ""|\#*) continue ;; esac
        case "$line" in
            AWS_ACCESS_KEY_ID=*|AWS_SECRET_ACCESS_KEY=*|AWS_SESSION_TOKEN=*|AWS_REGION=*)
                local k="${line%%=*}" v="${line#*=}"
                v="${v#"${v%%[![:space:]]*}"}"; v="${v%"${v##*[![:space:]]}"}"
                v="${v%\"}"; v="${v#\"}"; v="${v%\'}"; v="${v#\'}"
                export "$k=$v" ;;
        esac
    done < "$f"
}
load_env ".env"
AWS_REGION="${AWS_REGION:-ca-central-1}"
export AWS_DEFAULT_REGION="$AWS_REGION"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; NC='\033[0m'
info()  { echo -e "${BLUE}[INFO]${NC} $1"; }
ok()    { echo -e "${GREEN}[OK]${NC} $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
err()   { echo -e "${RED}[ERROR]${NC} $1"; }
step()  { echo -e "\n${CYAN}==== $1 ====${NC}"; }

SSH_CMD="ssh -i $SSH_KEY -o StrictHostKeyChecking=no -o ConnectTimeout=10"

lt_id()      { aws autoscaling describe-auto-scaling-groups --region "$AWS_REGION" --auto-scaling-group-names "$ASG_NAME" --query "AutoScalingGroups[0].LaunchTemplate.LaunchTemplateId" --output text; }
lt_version() { aws autoscaling describe-auto-scaling-groups --region "$AWS_REGION" --auto-scaling-group-names "$ASG_NAME" --query "AutoScalingGroups[0].LaunchTemplate.Version" --output text; }
first_subnet() {
    aws autoscaling describe-auto-scaling-groups --region "$AWS_REGION" --auto-scaling-group-names "$ASG_NAME" \
        --query "AutoScalingGroups[0].VPCZoneIdentifier" --output text | awk -F',' '{print $1}'
}

wait_ssh() {
    local ip="$1" w=0
    info "Waiting for SSH on $ip..."
    while ! $SSH_CMD "$REMOTE_USER@$ip" "echo ok" >/dev/null 2>&1; do
        w=$((w+5)); [ "$w" -ge 300 ] && { err "SSH timeout"; exit 1; }
        sleep 5
    done
    ok "SSH ready"
}

find_existing_builder() {
    aws ec2 describe-instances --region "$AWS_REGION" \
        --filters "Name=tag:Name,Values=$BUILDER_TAG" "Name=instance-state-name,Values=running" \
        --query "Reservations[0].Instances[0].[InstanceId,PublicIpAddress]" \
        --output text 2>/dev/null || true
}

get_or_launch_builder() {
    step "Builder instance"

    local existing
    existing=$(find_existing_builder)
    local eid eip
    eid=$(echo "$existing" | awk '{print $1}')
    eip=$(echo "$existing" | awk '{print $2}')

    if [ -n "$eid" ] && [ "$eid" != "None" ] && [ "$eid" != "" ]; then
        BUILDER_ID="$eid"
        BUILDER_IP="$eip"
        ok "Reusing existing builder: $BUILDER_ID ($BUILDER_IP)"
        wait_ssh "$BUILDER_IP"
        return 0
    fi

    info "No existing builder found — launching new one"
    local id ver sub
    id=$(lt_id); ver=$(lt_version); sub=$(first_subnet)

    if [ -z "$id" ] || [ "$id" = "None" ]; then err "Launch template not found"; exit 1; fi
    if [ -z "$sub" ] || [ "$sub" = "None" ]; then err "Subnet not found"; exit 1; fi

    BUILDER_ID=$(aws ec2 run-instances --region "$AWS_REGION" \
        --launch-template "LaunchTemplateId=${id},Version=${ver}" \
        --subnet-id "$sub" \
        --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=${BUILDER_TAG}},{Key=Purpose,Value=Builder}]" \
        --query "Instances[0].InstanceId" --output text)
    BUILDER_ID="${BUILDER_ID//[$'\t\r\n ']}"
    [ -z "$BUILDER_ID" ] && { err "Failed to launch"; exit 1; }
    ok "Launched: $BUILDER_ID"

    aws ec2 wait instance-running --region "$AWS_REGION" --instance-ids "$BUILDER_ID"
    aws ec2 wait instance-status-ok --region "$AWS_REGION" --instance-ids "$BUILDER_ID"

    BUILDER_IP=$(aws ec2 describe-instances --region "$AWS_REGION" \
        --instance-ids "$BUILDER_ID" \
        --query "Reservations[0].Instances[0].PublicIpAddress" --output text)
    if [ -z "$BUILDER_IP" ] || [ "$BUILDER_IP" = "None" ]; then
        err "No public IP on builder"; exit 1
    fi
    ok "IP: $BUILDER_IP"
    wait_ssh "$BUILDER_IP"
}

deploy_frontend_to_builder() {
    step "Syncing frontend to builder"
    $SSH_CMD "$REMOTE_USER@$BUILDER_IP" "mkdir -p $REMOTE_FRONTEND_PATH"
    rsync -az --delete -e "ssh -i $SSH_KEY -o StrictHostKeyChecking=no" \
        frontend/dist/ "$REMOTE_USER@$BUILDER_IP:$REMOTE_FRONTEND_PATH"
    ok "Frontend synced"
}

bake_ami() {
    step "Baking AMI" >&2
    local name="${AMI_NAME_PREFIX}-$(date +%Y%m%d-%H%M%S)"
    local ami
    ami=$(aws ec2 create-image --region "$AWS_REGION" \
        --instance-id "$BUILDER_ID" --name "$name" \
        --query "ImageId" --output text)
    ami="${ami//[$'\t\r\n ']}"
    [ -z "$ami" ] && { err "AMI creation failed" >&2; exit 1; }
    info "AMI $ami — waiting..." >&2
    aws ec2 wait image-available --region "$AWS_REGION" --image-ids "$ami"
    ok "AMI ready: $ami" >&2
    echo "$ami"
}

update_lt() {
    local ami="$1"
    step "Updating launch template"
    local id ver
    id=$(lt_id)
    if [ -z "$id" ] || [ "$id" = "None" ]; then err "LT not found"; exit 1; fi
    ver=$(aws ec2 create-launch-template-version --region "$AWS_REGION" \
        --launch-template-id "$id" --source-version '$Latest' \
        --launch-template-data "{\"ImageId\":\"${ami}\"}" \
        --query "LaunchTemplateVersion.VersionNumber" --output text)
    aws ec2 modify-launch-template --region "$AWS_REGION" \
        --launch-template-id "$id" --default-version "$ver" >/dev/null
    ok "LT version $ver (AMI: $ami)"
}

refresh() {
    step "Instance refresh"
    info "Min=${INSTANCE_REFRESH_MIN_HEALTHY}% Max=${INSTANCE_REFRESH_MAX_HEALTHY}% Warmup=${INSTANCE_REFRESH_WARMUP}s"
    local rid
    rid=$(aws autoscaling start-instance-refresh --region "$AWS_REGION" \
        --auto-scaling-group-name "$ASG_NAME" \
        --preferences "{\"MinHealthyPercentage\":${INSTANCE_REFRESH_MIN_HEALTHY},\"MaxHealthyPercentage\":${INSTANCE_REFRESH_MAX_HEALTHY},\"InstanceWarmup\":${INSTANCE_REFRESH_WARMUP}}" \
        --query "InstanceRefreshId" --output text 2>/dev/null || true)
    if [ -z "$rid" ] || [ "$rid" = "None" ]; then
        warn "Could not start refresh (one may already be running)"; return 0
    fi
    ok "Refresh: $rid"
}

main() {
    local skip_build=false status_only=false
    for arg in "$@"; do
        case "$arg" in
            --skip-build) skip_build=true ;;
            --status) status_only=true ;;
            --help|-h) echo "Usage: ./deploy-frontend.sh [--skip-build] [--status]"; exit 0 ;;
        esac
    done

    echo -e "\n${GREEN}=== Backboard Frontend Deploy ===${NC}"
    info "ASG: $ASG_NAME | Region: $AWS_REGION"

    if [ "$status_only" = true ]; then
        local builder; builder=$(find_existing_builder)
        local bid bip
        bid=$(echo "$builder" | awk '{print $1}')
        bip=$(echo "$builder" | awk '{print $2}')
        if [ -n "$bid" ] && [ "$bid" != "None" ]; then
            ok "Builder: $bid ($bip)"
        else
            warn "No builder instance running"
        fi
        exit 0
    fi

    if [ "$skip_build" = false ]; then
        step "Building frontend"
        [ -d "frontend" ] || { err "frontend/ not found"; exit 1; }
        (cd frontend && npm run build)
        ok "Build done"
    else
        [ -d "frontend/dist" ] || { err "frontend/dist not found"; exit 1; }
        warn "Skip build"
    fi

    get_or_launch_builder
    deploy_frontend_to_builder

    local ami
    ami=$(bake_ami)
    update_lt "$ami"
    refresh

    echo -e "\n${GREEN}=== Done ===${NC}"
    info "Builder: $BUILDER_ID ($BUILDER_IP) — kept running"
    info "AMI: $ami"
    info "Refresh running in background"
}

main "$@"
