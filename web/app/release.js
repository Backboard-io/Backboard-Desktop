const fallbackDownloadPath = '/downloads/Backboard-Studio-aarch64.dmg';

export const release = {
  filename: 'Backboard-Studio-aarch64.dmg',
  href: process.env.NEXT_PUBLIC_MAC_ARM64_DMG_URL || fallbackDownloadPath,
  size: '122 MB',
  platform: 'macOS Apple Silicon',
  version: process.env.NEXT_PUBLIC_BACKBOARD_STUDIO_VERSION || '0.1.0-dev',
  notarization: 'Apple notarized and stapled',
  sha256: 'd0a7e3c3e0f36fa457477860f1650c13706e8f33ec1c9224ecf14210b99c6084'
};

export function absoluteReleaseUrl(request) {
  if (/^https?:\/\//.test(release.href)) {
    return release.href;
  }

  return new URL(release.href, request.url).toString();
}
