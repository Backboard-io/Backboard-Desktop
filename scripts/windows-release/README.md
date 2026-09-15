# Backboard Studio Windows signing

Windows releases are built and signed by `.github/workflows/release-windows.yml`.
The workflow uses Azure Artifact Signing (formerly Trusted Signing) with GitHub
OIDC. No certificate private key or Azure client secret is stored in GitHub.

The application source tree is `backboard/`; keep the workflow's Node setup,
dependency cache, metadata stamping, and build working directories aligned with
that path if the source tree is moved again.

## Azure resources

Create these resources in the Azure subscription used for Backboard releases:

1. An Artifact Signing account using the Basic SKU.
2. A Public Trust identity validation for the Backboard publisher.
3. A Public Trust certificate profile linked to that identity validation.
4. A Microsoft Entra application and service principal for GitHub Actions.
5. A federated identity credential with this subject:

   `repo:Backboard-io@241341711/Backboard-Desktop@1314090052:environment:windows-release`

   This uses GitHub's immutable organization and repository IDs. Keep the
   `windows-release` environment name in sync with the workflow and the
   federated credential.

6. An `Artifact Signing Certificate Profile Signer` role assignment for that
   service principal, scoped to the certificate profile.

Identity validation must be completed in the Azure portal. Copy the exact
certificate profile subject; the release gate compares every signed binary to
that subject and rejects artifacts signed by any other identity.

## GitHub configuration

Create a protected GitHub environment named `windows-release`, restrict it to
the `main` branch, and add required reviewers. Configure these environment
secrets:

- `AZURE_CLIENT_ID`
- `AZURE_TENANT_ID`
- `AZURE_SUBSCRIPTION_ID`

Configure these environment variables:

- `AZURE_ARTIFACT_SIGNING_ENDPOINT` (for example,
  `https://eus.codesigning.azure.net/`)
- `AZURE_ARTIFACT_SIGNING_ACCOUNT`
- `AZURE_ARTIFACT_SIGNING_PROFILE`
- `WINDOWS_SIGNING_SUBJECT` (the exact certificate profile subject)

Run the **Windows Release** workflow manually with a semantic version and a
release channel. It performs the release in this order:

1. Stamp Backboard branding and release metadata.
2. Build the unpacked Windows application and updater.
3. Sign every shipped `.exe`, `.dll`, and `.node` recursively.
4. Verify publisher identity, certificate trust, and RFC 3161 timestamps.
5. Build the system and per-user Inno Setup installers from signed contents.
6. Sign and verify both installers.
7. Create the portable ZIP and SHA-256 checksums.
8. Publish the completed files as a GitHub Actions artifact.

The workflow deliberately does not publish unsigned intermediate artifacts.

## 3.1.10 integration

The Windows build fixes preserved on `codex/windows-release-3.1.5` are restored
selectively onto the current app source. Do not replace the current source tree
with that older branch: newer Mac onboarding, auth, and UI changes must remain.
Keep the source-commit override, non-Windows native-module filtering, long-path
installer compiler, and Azure credential refresh before installer signing.

Subscriptions are disabled on all platforms for this release. Backboard sign-in
and provider API keys remain available. Setup actions, cached model catalogs,
saved selections, environment overrides, and production subscription routing
are blocked. `cli-ts/tests/ReleaseFeatures.test.ts` verifies these restrictions,
including rejection of legacy login/enable commands before authentication.

The workflow must run from reviewed `main`. Use a new version and leave
`reuse_signed_run` empty when app code changed. Installer checks cover fresh
per-user/system installs and uninstall, not historical in-place upgrades.
