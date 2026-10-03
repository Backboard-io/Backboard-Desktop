"use client";

import { useEffect, useState } from "react";
import { GithubLink } from "@/components/GithubLink";
import { DESKTOP_REPO } from "@/data/links";
import { track } from "@/lib/analytics";

type Platform = { id: string; os: string; detail: string; short: string };

const PLATFORMS: Platform[] = [
  { id: "mac-arm", os: "macOS", detail: "Apple silicon", short: "Mac" },
  { id: "mac-intel", os: "macOS", detail: "Intel", short: "Intel Mac" },
  { id: "win", os: "Windows", detail: "64-bit", short: "Windows" },
  { id: "linux", os: "Linux", detail: "x64 · .deb", short: "Linux" },
];

function Icon({ id }: { id: string }) {
  if (id.startsWith("mac"))
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M16.4 12.6c0-2.4 2-3.6 2.1-3.7-1.2-1.7-3-1.9-3.6-2-1.5-.2-3 .9-3.8.9s-2-.9-3.3-.9c-1.7 0-3.3 1-4.2 2.6-1.8 3.1-.5 7.7 1.3 10.2.9 1.2 1.9 2.6 3.2 2.6 1.3-.1 1.8-.8 3.3-.8 1.6 0 2 .8 3.3.8 1.4 0 2.3-1.3 3.1-2.5 1-1.4 1.4-2.8 1.4-2.9 0 0-2.8-1.1-2.8-4.3ZM13.9 5.2c.7-.9 1.2-2 1-3.2-1 0-2.3.7-3 1.6-.7.8-1.2 2-1.1 3.1 1.2.1 2.3-.6 3.1-1.5Z" />
      </svg>
    );
  if (id === "win")
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M3 5.1 10.4 4v7.2H3V5.1Zm0 13.8 7.4 1.1v-7.1H3v6Zm8.2 1.2L21 21.5v-8.6h-9.8v7.2Zm0-16.2v7.3H21V2.5l-9.8 1.4Z" />
      </svg>
    );
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 2.5c-2.2 0-3.4 1.9-3.4 4.4 0 1.3.3 2.2-.6 3.5-1.2 1.6-2.6 3.8-2.6 6.2 0 .6.1 1.1.3 1.6-.9.4-1.7.9-1.7 1.6 0 1 1.7 1.2 3.4 1.6 1.2.3 2 .7 2.9.7.8 0 1.2-.4 1.7-.4s.9.4 1.7.4c.9 0 1.7-.4 2.9-.7 1.7-.4 3.4-.6 3.4-1.6 0-.7-.8-1.2-1.7-1.6.2-.5.3-1 .3-1.6 0-2.4-1.4-4.6-2.6-6.2-.9-1.3-.6-2.2-.6-3.5 0-2.5-1.2-4.4-3.4-4.4Z" />
    </svg>
  );
}

// One download button for the visitor's platform, plus quiet links to the
// others. Release URLs aren't published yet, so the button is marked soon.
export function DownloadButton() {
  const [id, setId] = useState("mac-arm");
  useEffect(() => {
    const ua = navigator.userAgent;
    if (/windows/i.test(ua)) setId("win");
    else if (/linux/i.test(ua) && !/android/i.test(ua)) setId("linux");
  }, []);
  const p = PLATFORMS.find((x) => x.id === id) ?? PLATFORMS[0];
  const others = PLATFORMS.filter((x) => x.id !== id);

  return (
    <div id="download" className="dl">
      <div className="dl-top">
        <button
          type="button"
          className="dl-badge"
          aria-disabled="true"
          title="Downloads open soon"
          onClick={() =>
            // Counted while it's still "soon": clicks here are demand.
            track("download_clicked", { product: "desktop", platform: p.id, available: false })
          }
        >
          <Icon id={p.id} />
          <span>
            <small>Download for</small>
            <b>{p.os}</b>
          </span>
        </button>
        <GithubLink href={DESKTOP_REPO} label="Backboard Desktop" />
      </div>
      <p className="dl-more">
        {p.detail} · coming soon. Also for{" "}
        {others.map((o, i) => (
          <span key={o.id}>
            <button type="button" onClick={() => setId(o.id)}>
              {o.short}
            </button>
            {i < others.length - 1 ? ", " : "."}
          </span>
        ))}
      </p>
    </div>
  );
}
