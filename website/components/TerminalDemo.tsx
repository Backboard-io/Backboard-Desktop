"use client";

import { useEffect, useRef, useState } from "react";

// Illustrative Backboard CLI session that types itself on a loop.
const SCRIPT: { kind: "cmd" | "you" | "out" | "ok"; text: string }[] = [
  { kind: "cmd", text: "backboard" },
  { kind: "you", text: "add a dark mode toggle to the settings page" },
  { kind: "out", text: "reading src/settings/SettingsPage.tsx" },
  { kind: "out", text: "editing src/settings/SettingsPage.tsx  +18 −2" },
  { kind: "out", text: "editing src/theme.ts  +9" },
  { kind: "out", text: "running npm test" },
  { kind: "ok", text: "✓ 48 tests passed · toggle added, saved per user" },
];

export function TerminalDemo() {
  const [step, setStep] = useState(0);
  const [chars, setChars] = useState(0);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setStep(SCRIPT.length);
      return;
    }
    let visible = false;
    const io = new IntersectionObserver(([e]) => (visible = e.isIntersecting), { threshold: 0.3 });
    if (root.current) io.observe(root.current);
    let s = 0;
    let c = 0;
    let hold = 0;
    const id = window.setInterval(() => {
      if (!visible || document.hidden) return;
      if (s >= SCRIPT.length) {
        if (++hold > 60) {
          s = 0;
          c = 0;
          hold = 0;
        }
      } else {
        const line = SCRIPT[s];
        const typed = line.kind === "cmd" || line.kind === "you";
        c += typed ? 1 : line.text.length;
        if (c >= line.text.length + (typed ? 8 : 5)) {
          s++;
          c = 0;
        }
      }
      setStep(s);
      setChars(c);
    }, 45);
    return () => {
      clearInterval(id);
      io.disconnect();
    };
  }, []);

  return (
    <div className="term" ref={root} aria-label="Example Backboard CLI session" role="img">
      <div className="term-bar" aria-hidden="true">
        <i />
        <i />
        <i />
        <span>~/my-app</span>
      </div>
      <div className="term-body" aria-hidden="true">
        {SCRIPT.map((line, i) => {
          if (i > step) return null;
          const text = i === step ? line.text.slice(0, chars) : line.text;
          return (
            <div key={i} className={`term-line term-line--${line.kind}`}>
              {line.kind === "cmd" && <span className="term-p">$ </span>}
              {line.kind === "you" && <span className="term-p">› </span>}
              {text}
              {i === step && <span className="term-caret" />}
            </div>
          );
        })}
      </div>
    </div>
  );
}
