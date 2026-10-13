# Backboard Studio Linux release build

The Linux builder runs in an isolated native x86_64 Ubuntu 22.04 environment. It does not upload artifacts or modify the macOS release directories.

From the repository root:

```bash
VERSION=<version> CHANNEL=stable scripts/build_vscode_release_linux.sh
```

The build installs lockfile-pinned dependencies, type-checks the client and Backboard extension, runs the updater tests, verifies every relevant packaged native binary, smoke-launches the app with Xvfb, and produces:

- `linux-release/<version>/x86_64/Backboard-Studio-linux-x86_64.tar.gz`
- `linux-release/<version>/x86_64/Backboard-Studio-linux-x86_64.deb`
- `linux-release/<version>/x86_64/SHA256SUMS`

The Linux application does not currently participate in the S3 auto-update flow; Linux installation and upgrades use the tarball or Debian package.

## GitHub release build

Release builds run in the Prod Release workflow (`.github/workflows/prod-release.yml`) on every push to `prod`. It builds Linux x86_64 in the same Ubuntu 22.04 container as local builds and uploads the packages as a workflow artifact. The version comes from `backboard/product.json`.

Download the artifact before publishing the packages to the stable S3 download location. GitHub builds the packages; the S3 publication remains a separate step, as for Windows. Linux packages do not require the Azure Windows signing credentials.
