"use client";

import { useEffect, useRef, useState } from "react";

export type Mode = "simple" | "editor" | "advanced";
const MODES: Mode[] = ["simple", "editor", "advanced"];
const PROMPT = "Build a surf report site for Montauk. Sunny, loud, fun.";
const STEPS = ["Planning the layout", "Writing index.html", "Painting the sunset palette", "Checking it on a phone"];
const CODE: [string, string][][] = [
  [["k", "export async function "], ["f", "forecast"], ["p", "(spot: "], ["t", "string"], ["p", ") {"]],
  [["p", "  const "], ["v", "swell"], ["p", " = await "], ["f", "fetchSwell"], ["p", "(spot);"]],
  [["p", "  return "], ["v", "swell"], ["p", "."], ["f", "map"], ["p", "((day) => ({"]],
  [["p", "    day: day."], ["v", "label"], ["p", ","]],
  [["p", "    waves: "], ["f", "feet"], ["p", "(day.height),"]],
  [["p", "    vibe: day.sun > "], ["n", "0.7"], ["p", " ? "], ["s", '"go surf"'], ["p", " : "], ["s", '"code"'], ["p", ","]],
  [["p", "  }));"]],
  [["p", "}"]],
];
const AGENTS = [
  { who: "Claude", task: "Writing tests", log: ["reading forecast.ts", "12 cases written", "all passing ✓"] },
  { who: "GPT", task: "Hooking up the API", log: ["found swell endpoint", "added caching", "wired to UI ✓"] },
  { who: "Gemini", task: "Polishing the copy", log: ["tightened headlines", "added alt text", "ready for review ✓"] },
];
const FORECAST = [
  { d: "SAT", h: 0.8 },
  { d: "SUN", h: 0.55 },
  { d: "MON", h: 0.95 },
];

// A self-playing, fully illustrative Backboard Desktop window.
export function DesktopMock({ mode: wanted, onMode }: { mode?: Mode; onMode?: (m: Mode) => void } = {}) {
  const [mode, setMode] = useState<Mode>(wanted ?? "simple");
  const [t, setT] = useState(0);
  const [auto, setAuto] = useState(true);
  const root = useRef<HTMLDivElement>(null);
  const reduced = useRef(false);

  useEffect(() => {
    reduced.current = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced.current) setT(999);
  }, []);

  useEffect(() => {
    if (reduced.current) return;
    let visible = false;
    const io = new IntersectionObserver(([e]) => (visible = e.isIntersecting), { threshold: 0.2 });
    if (root.current) io.observe(root.current);
    const id = window.setInterval(() => {
      if (!visible || document.hidden) return;
      setT((v) => {
        const next = v + 1;
        if (next > 150 && auto) {
          setMode((m) => MODES[(MODES.indexOf(m) + 1) % MODES.length]);
          return 0;
        }
        return next;
      });
    }, 60);
    return () => {
      clearInterval(id);
      io.disconnect();
    };
  }, [auto]);

  const pick = (m: Mode) => {
    setMode(m);
    setT(reduced.current ? 999 : 0);
  };

  // Let a parent drive the mode (e.g. clickable cards beside the window).
  useEffect(() => {
    if (wanted && wanted !== mode) pick(wanted);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted]);
  useEffect(() => {
    onMode?.(mode);
  }, [mode, onMode]);

  const typed = PROMPT.slice(0, Math.max(0, t - 4));
  const stepsDone = Math.max(0, Math.min(STEPS.length, Math.floor((t - 60) / 12)));
  const built = Math.max(0, Math.min(5, Math.floor((t - 64) / 10)));
  const codeChars = Math.max(0, (t - 6) * 5);

  let budget = codeChars;
  const codeLines = CODE.map((line) =>
    line.map(([cls, text]) => {
      const take = Math.max(0, Math.min(text.length, budget));
      budget -= text.length;
      return [cls, text.slice(0, take)] as const;
    }),
  );

  return (
    <div className="dm" ref={root}>
      <div className="dm-bar">
        <span className="dm-dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <div className="dm-tabs" role="tablist" aria-label="Workspace mode">
          {MODES.map((m) => (
            <button
              key={m}
              role="tab"
              type="button"
              aria-selected={mode === m}
              className="dm-tab"
              onClick={() => pick(m)}
            >
              {m}
            </button>
          ))}
        </div>
        <button type="button" className="dm-auto" onClick={() => setAuto((a) => !a)} aria-pressed={!auto}>
          {auto ? "Pause tour" : "Resume tour"}
        </button>
      </div>

      {mode === "simple" && (
        <div className="dm-body dm-simple">
          <div className="dm-chat">
            <div className="dm-msg dm-msg--you">
              {typed}
              {t < 70 && <span className="dm-caret" />}
            </div>
            {t > 58 && (
              <div className="dm-msg dm-msg--agent">
                <b>On it.</b>
                <ul>
                  {STEPS.map((s, i) => (
                    <li key={s} className={i < stepsDone ? "is-done" : i === stepsDone ? "is-now" : ""}>
                      {s}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
          <div className="dm-preview">
            <div className="dm-url">montauk-surf.local</div>
            <div className="dm-site">
              <div className={`dm-site-hero${built > 0 ? " is-in" : ""}`}>
                <span className="dm-site-sun" />
                <strong>Montauk Surf</strong>
              </div>
              <div className="dm-site-cards">
                {FORECAST.map((f, i) => (
                  <div key={f.d} className={`dm-card${built > i + 1 ? " is-in" : ""}`}>
                    <span>{f.d}</span>
                    <i style={{ height: built > i + 1 ? `${f.h * 100}%` : "0%" }} />
                  </div>
                ))}
              </div>
              <div className={`dm-site-cta${built > 4 ? " is-in" : ""}`}>Paddle out →</div>
            </div>
          </div>
        </div>
      )}

      {mode === "editor" && (
        <div className="dm-body dm-editor">
          <ul className="dm-tree" aria-label="Files">
            <li>montauk-surf/</li>
            <li>index.html</li>
            <li>style.css</li>
            <li className="is-open">forecast.ts</li>
          </ul>
          <div className="dm-code-wrap">
            <pre className="dm-code">
              {codeLines.map((line, i) => (
                <div key={i}>
                  <span className="dm-ln">{i + 1}</span>
                  {line.map(([cls, text], j) => (
                    <span key={j} className={`c-${cls}`}>
                      {text}
                    </span>
                  ))}
                </div>
              ))}
            </pre>
            <div className="dm-term">
              <span>$ npm run dev</span>
              {t > 90 && <span className="ok">✓ ready in 412ms · http://localhost:3000</span>}
              {t > 110 && <span className="ok">✓ forecast.ts: 12 tests passed</span>}
            </div>
          </div>
        </div>
      )}

      {mode === "advanced" && (
        <div className="dm-body dm-advanced">
          {AGENTS.map((a, i) => {
            const p = Math.max(0, Math.min(1, (t - i * 12) / 110));
            return (
              <div className="dm-agent" key={a.who}>
                <div className="dm-agent-head">
                  <b>{a.who}</b>
                  <span>{a.task}</span>
                </div>
                <div className="dm-progress">
                  <i style={{ width: `${p * 100}%` }} />
                </div>
                <ul>
                  {a.log.map((l, k) => (
                    <li key={l} className={p > (k + 1) / (a.log.length + 0.3) ? "is-in" : ""}>
                      {l}
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
