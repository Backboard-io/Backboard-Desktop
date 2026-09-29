// Hand-drawn ink marks in the same loose line as the penguin logo.
// Paths draw themselves in when their parent gets .is-in (see ScrollFx).
import type { ReactNode } from "react";

function Underline({ children }: { children: ReactNode }) {
  return (
    <span className="ink ink--under" data-slap-ink>
      {children}
      <svg viewBox="0 0 300 24" preserveAspectRatio="none" aria-hidden="true">
        <path pathLength={1} d="M4 15 C 60 6, 110 20, 170 11 S 260 8, 296 14" />
        <path pathLength={1} d="M30 20 C 90 14, 170 22, 250 16" />
      </svg>
    </span>
  );
}

function Circle({ children }: { children: ReactNode }) {
  return (
    <span className="ink ink--circle" data-slap-ink>
      {children}
      <svg viewBox="0 0 300 100" preserveAspectRatio="none" aria-hidden="true">
        <path pathLength={1} d="M150 8 C 60 6, 8 30, 12 56 C 16 84, 90 96, 170 92 C 250 88, 296 70, 290 44 C 284 18, 210 6, 120 12" />
      </svg>
    </span>
  );
}

function Note({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <span className={`ink-note ${className}`} data-slap-ink>
      <svg viewBox="0 0 60 50" aria-hidden="true">
        <path pathLength={1} d="M52 6 C 36 10, 18 22, 12 42" />
        <path pathLength={1} d="M6 32 L 12 43 L 22 36" />
      </svg>
      {children}
    </span>
  );
}

export const Ink = { Underline, Circle, Note };
