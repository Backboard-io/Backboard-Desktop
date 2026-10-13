# Backboard Studio Windows signing

Windows releases are built and signed by `.github/workflows/release-windows.yml`.
The workflow uses Azure Artifact Signing (formerly Trusted Signing) with GitHub
OIDC. No certificate private key or Azure client secret is stored in GitHub.

The application source tree is `backboard/`; keep the workflow's Node setup,
dependency cache, metadata stamping, and build working directories aligned with
that path if the source tree is moved again.

The Windows workflow pins Node 24.21.0, which satisfies the source tree's 24.x
minimum. Node 24.15.0 has a Windows libuv TCP-connect crash that can terminate
`npm ci` with `0xC0000409`; the [upstream fix](https://github.com/nodejs/node/pull/62561)
first shipped in 24.16.0. Keep Windows releases on a fixed version carrying that
fix.

## Azure resources

Create these resources in the Azure subscription used for Backboard releases:

1. An Artifact Signing account using the Basic SKU.
2. A Public Trust identity validation for the Backboard publisher.
3. A Public Trust certificate profile linked to that identity validation.
4. A Microsoft Entra application and service principal for GitHub Actions.
5. A federated identity credential matching the repository that runs signing,
   in the form `repo:OWNER@OWNER_ID/REPO@REPO_ID:environment:windows-release`.

   Verify the exact prefix with `gh api repos/OWNER/REPO/actions/oidc/customization/sub`
   and append `:environment:windows-release`. Names and immutable IDs must both
   match the returned `sub_claim_prefix`, including after a repository rename.
   See [GitHub's OIDC reference](https://docs.github.com/en/actions/reference/security/oidc).
   Keep the
   `windows-release` environment name in sync with the workflow and the
   federated credential.

6. An `Artifact Signing Certificate Profile Signer` role assignment for that
   service principal, scoped to the certificate profile.

Identity validation must be completed in the Azure portal. Copy the exact
certificate profile subject; the release gate compares every signed binary to
that subject and rejects artifacts signed by any other identity.

## GitHub configuration

The existing release repository already has a `windows-release` environment
allowing `main` and `windows`. Its `main` branch requires one approving PR
review; a Windows release can instead run directly from the synchronized
`windows` branch, without merging or changing `main`.
For a new signing deployment, create the same protected environment and explicitly
restrict the allowed release branches. Configure these environment secrets:

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

Only the final signed release artifact is suitable for distribution. Intermediate
payloads and installer candidates are retained briefly for build recovery.

## Windows differences

Windows disables Backboard's BYOS subscription setup and provider routing;
Backboard sign-in and provider API keys remain available. Saved subscription
credentials are left on disk but ignored on Windows. Mac subscription behavior
is unchanged. `cli-ts/tests/ReleaseFeatures.test.ts` runs in the Windows workflow,
including Windows-only checks that subscription login/enable commands reject
before provider authentication begins.

The workflow must run from reviewed `main`, `prod`, or `windows`. Use a new
version and leave `reuse_signed_run` empty when app code changed. The environment
must also permit that branch. Installer checks cover fresh per-user/system
installs, an in-app background update of the per-user install, and uninstall;
they do not cover upgrades from historical releases.

## In-app updates

Per-user installs update in place from the Update button, like macOS
(`backboard/extensions/backboard/src/updates.ts`). The app downloads the user
installer from the `windows-x86_64.json` manifest, checks its SHA-256 and that it
is Authenticode-signed by the same publisher as the installed app, then runs it
with `/verysilent /update=<flag>`. Setup stages the new version in `{app}\_`
while the app keeps running and writes `{app}\updating_version`. The app then
quits; setup sees its mutex disappear, `tools\inno_updater.exe` swaps the
staged files in, and setup relaunches the app. No wizard is shown.

`inno_updater` 0.21 cannot read the version 1055 uninstall log that Inno Setup
7.1 writes. It still swaps the files and only logs a warning about the log, so
`code.iss` removes `{app}\resources` by folder on uninstall. System-wide installs
and the portable ZIP still get the download link, because the manifest only
carries the user installer.

To test on any packaged build (macOS or a per-user Windows install), open the
Command Palette and run **Backboard: Test Update (Reinstall Latest Release)**.
It offers the latest published release on the build's channel even when that
version is already installed. It never offers an older release, so publish the
build under test before testing. You get the real popup and the Update button, and **Install and
Restart** runs the full download, verify, install and relaunch. Test mode ends
when the app restarts, so a successful update comes back with no Update button.
If something fails, run **Backboard: Show Update Log**: it opens the installer log
and the `Backboard Tools` output, which has the `[updates]` lines.

## Releasing the current stable app on Windows

Keep `windows` synchronized with `stable` before releasing, then run:

```sh
gh workflow run release-windows.yml --repo Backboard-io/Backboard-Desktop \
  --ref windows -f version=VERSION -f channel=stable
```

Download only `Backboard-Studio-VERSION-windows-x64-signed` after the full run
succeeds. Installer candidates have not passed the final signing gate. Publish
the versioned installers first, then the latest copies, and finally the latest
`windows-x86_64.json` manifest with the user installer's SHA-256 and byte size.
