#---------------------------------------------------------------------------------------------
#  Copyright (c) Microsoft Corporation. All rights reserved.
#---------------------------------------------------------------------------------------------

# Windows Backboard CLI bootstrapper
#
# Responsibilities:
#   1. Locate the real Backboard CLI binary (avoid recursion if this file shadows it).
#   2. Offer to install if missing.
#   3. Enforce minimum version (>= REQUIRED_VERSION) with interactive update.
#   4. Execute the real binary with original arguments and exit with its status.
#
# NOTE: This file intentionally keeps logic self‑contained (no external deps) so it can be dropped into PATH directly.

# Minimum required Backboard CLI version
$RequiredVersion = "0.0.394"

function Install-BackboardCLI {
    try {
        Invoke-Expression (Invoke-RestMethod https://app.backboard.io/api/cli/windows)
        return ($LASTEXITCODE -eq 0 -or $null -eq $LASTEXITCODE)
    } catch {
        Write-Host "Backboard CLI installation failed: $($_.Exception.Message)"
        return $false
    }
}

function Find-RealBackboard {
    # Find the real backboard binary, avoiding this script if it's in PATH
    $CurrentScript = $MyInvocation.PSCommandPath
    if (-not $CurrentScript) { $CurrentScript = $PSCommandPath }
    $BackboardPath = (Get-Command backboard -ErrorAction SilentlyContinue).Source

    # Check if the backboard command would point to this script
    $CurrentScriptResolved = if ($CurrentScript) { (Resolve-Path $CurrentScript -ErrorAction SilentlyContinue).Path } else { $null }
    $BackboardPathResolved = if ($BackboardPath) { (Resolve-Path $BackboardPath -ErrorAction SilentlyContinue).Path } else { $null }

    if ($CurrentScript -eq $BackboardPath -or (Split-Path $CurrentScript -Parent) -eq (Split-Path $BackboardPath -Parent) -or ($CurrentScriptResolved -and $BackboardPathResolved -and $CurrentScriptResolved -eq $BackboardPathResolved)) {
        # The backboard in PATH is this script, find the real one by temporarily removing this script's directory from PATH
        $ScriptDir = Split-Path $CurrentScript -Parent
        $OldPath = $env:PATH
        # Use appropriate path delimiter based on OS
        $PathDelimiter = if ($IsWindows -or $env:OS -eq "Windows_NT") { ';' } else { ':' }
        $env:PATH = ($env:PATH -split $PathDelimiter | Where-Object { $_ -ne $ScriptDir }) -join $PathDelimiter
        $RealBackboard = (Get-Command backboard -ErrorAction SilentlyContinue).Source
        $env:PATH = $OldPath

        if ($RealBackboard -and (Test-Path $RealBackboard)) {
            return $RealBackboard
        } else {
            return $null
        }
    } else {
        # The backboard in PATH is different from this script, use it
        if ($BackboardPath -and (Test-Path $BackboardPath)) {
            return $BackboardPath
        } else {
            return $null
        }
    }
}

function Test-VersionCompatibility {
    param([string]$Version)
    $cleanInstalled = $Version -replace '^v',''
    $cleanRequired = $RequiredVersion -replace '^v',''
    try {
        $installedVer = [version]$cleanInstalled
        $requiredVer = [version]$cleanRequired
    } catch {
        return $false
    }
    return ($installedVer -ge $requiredVer)
}

function Test-AndLaunchBackboard {
    param([string[]]$Arguments)

    # Check if real backboard command exists
    $realBackboard = Find-RealBackboard
    if (-not $realBackboard) {
        Write-Host "Cannot find Backboard CLI (https://backboard.io/)"
        $answer = Read-Host "Install Backboard CLI? (y/N)"
        if ($answer -eq "y" -or $answer -eq "Y") {
            if (Install-BackboardCLI) {
                Test-AndLaunchBackboard $Arguments
                return
            } else {
                Read-Host "Installation failed. Please install manually (https://backboard.io/)."
                return
            }
        } else {
            exit 0
        }
    }

    # Check version compatibility
    $realBackboard = Find-RealBackboard
    if (-not $realBackboard) {
        Write-Host "Error: Unable to find backboard binary."
        $answer = Read-Host "Would you like to reinstall Backboard CLI? (y/N)"
        if ($answer -eq "y" -or $answer -eq "Y") {
            Write-Host "Reinstalling Backboard CLI..."
            if (Install-BackboardCLI) {
                Test-AndLaunchBackboard $Arguments
                return
            } else {
                Read-Host "Reinstallation failed. Please install manually (https://backboard.io/)."
                return
            }
        } else {
            exit 0
        }
    }

    try {
        $versionOutput = & $realBackboard --version 2>$null
        if ($LASTEXITCODE -ne 0) {
            throw "Command failed"
        }
    } catch {
        $answer = Read-Host "Would you like to reinstall Backboard CLI? (y/N)"
        if ($answer -eq "y" -or $answer -eq "Y") {
            if (Install-BackboardCLI) {
                Test-AndLaunchBackboard $Arguments
                return
            } else {
                Read-Host "Reinstallation failed. Please install manually (https://backboard.io/)."
                return
            }
        } else {
            exit 0
        }
    }

    # Extract version number from output (search through all lines)
    $version = $null
    if ($versionOutput) {
        foreach ($line in ($versionOutput -split "`n")) {
            $trimmedLine = $line.Trim()
            if ($trimmedLine -match '[0-9]+\.[0-9]+\.[0-9]+') {
                $version = $matches[0]
                break
            }
        }
    }

    # Command succeeded - assume CLI is installed even if we can't parse the version

    # Only check version compatibility if we have a valid version
    if ($version -and -not (Test-VersionCompatibility $version)) {
        Write-Host "Backboard CLI version $version is not compatible."
        Write-Host "Version $RequiredVersion or later is required."
        $answer = Read-Host "Update Backboard CLI? (y/N)"
        if ($answer -eq "y" -or $answer -eq "Y") {
            if (Install-BackboardCLI) {
                Test-AndLaunchBackboard $Arguments
                return
            } else {
                Read-Host "Update failed. Please update manually (https://backboard.io/)."
                return
            }
        } else {
            exit 0
        }
    }

    # All checks passed, execute the real backboard binary
    $realBackboard = Find-RealBackboard
    if ($realBackboard -and (Test-Path $realBackboard)) {
        & $realBackboard @Arguments
    } else {
        Write-Host "Error: Could not find the real Backboard CLI binary"
        Read-Host "Please ensure it's properly installed (https://backboard.io/)"
        return
    }
}

# Start the check and launch process
$finalArgs = $args
# Handle --clear argument
if ($args.Length -gt 0 -and $args[0] -eq '--clear') {
    Clear-Host
    $finalArgs = $args[1..($args.Length - 1)]
}

Test-AndLaunchBackboard $finalArgs
