import type { ReactNode } from "react";

// A navy band of 1-bit pixel art (made by scripts/dither.py). Hovering it fades
// the full-colour painting in; children (a live demo) sit on top.
export function PixelBand({
  name,
  className = "",
  children,
}: {
  name: string;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <div className={`pb ${className}`}>
      <img
        className="pb-pixel"
        src={`/assets/pixel/${name}.png`}
        alt=""
        aria-hidden="true"
      />
      <img
        className="pb-color"
        src={`/assets/pixel/${name}-color.webp`}
        alt=""
        aria-hidden="true"
        loading="lazy"
      />
      {children && <div className="pb-content">{children}</div>}
    </div>
  );
}
