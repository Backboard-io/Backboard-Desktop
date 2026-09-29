import type { CSSProperties } from "react";
import { models } from "@/data/models";

// Every model/provider family, drifting along in one seamless loop. The list
// is rendered twice and the track slides by exactly one copy. CSS pauses it
// on hover and holds it still for reduced motion.
export function ModelMarquee({ className = "" }: { className?: string }) {
  const style = { "--mm-duration": `${models.length * 3.2}s` } as CSSProperties;
  return (
    <div
      className={`mm ${className}`}
      role="region"
      aria-label={`Works with ${models.length} model families`}
    >
      <div className="mm-track" style={style}>
        {[0, 1].map((copy) => (
          <ul key={copy} aria-hidden={copy === 1 || undefined}>
            {models.map((m) => (
              <li key={m.name}>
                <img
                  src={m.icon}
                  alt=""
                  width={18}
                  height={18}
                  loading="lazy"
                />
                {m.name}
              </li>
            ))}
          </ul>
        ))}
      </div>
    </div>
  );
}
