import { NextResponse } from 'next/server';
import { absoluteReleaseUrl, release } from '../../../../release';

const supportedArchitectures = new Set(['aarch64', 'arm64']);

export function GET(request, { params }) {
  const { channel } = params;
  const { searchParams } = new URL(request.url);
  const asset = searchParams.get('asset');
  const os = searchParams.get('os');
  const arch = searchParams.get('arch');

  if (channel !== 'stable' && channel !== 'preview' && channel !== 'dev') {
    return NextResponse.json({ error: 'Unsupported release channel' }, { status: 404 });
  }

  if (asset && asset !== 'zed' && asset !== 'backboard-studio') {
    return NextResponse.json({ error: 'Unsupported release asset' }, { status: 404 });
  }

  if (os && os !== 'macos') {
    return NextResponse.json({ error: 'Unsupported operating system' }, { status: 404 });
  }

  if (arch && !supportedArchitectures.has(arch)) {
    return NextResponse.json({ error: 'Unsupported architecture' }, { status: 404 });
  }

  return NextResponse.json(
    {
      version: params.version === 'latest' ? release.version : params.version,
      url: absoluteReleaseUrl(request),
      sha256: release.sha256,
      name: release.filename,
      size: release.size
    },
    {
      headers: {
        'Cache-Control': 'public, max-age=60, s-maxage=60'
      }
    }
  );
}
