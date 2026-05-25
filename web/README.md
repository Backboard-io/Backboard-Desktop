# Backboard Studio Web

Small Next.js download page for Backboard Studio release artifacts.

## Local Development

```sh
cd ide/web
npm install
npm run dev
```

Open `http://localhost:3000`.

## Release Artifact

For local testing, the Apple Silicon DMG can be placed at:

```txt
public/downloads/Backboard-Studio-aarch64.dmg
```

DMG files are ignored by git because they are large release artifacts. For
production, upload the DMG to object storage or a release CDN and set:

```sh
NEXT_PUBLIC_MAC_ARM64_DMG_URL=https://your-release-host/Backboard-Studio-aarch64.dmg
NEXT_PUBLIC_BACKBOARD_STUDIO_VERSION=0.1.0
```

The update manifest endpoint is:

```txt
/releases/stable/latest/asset?asset=zed&os=macos&arch=aarch64
```

Current SHA-256:

```txt
d0a7e3c3e0f36fa457477860f1650c13706e8f33ec1c9224ecf14210b99c6084
```
