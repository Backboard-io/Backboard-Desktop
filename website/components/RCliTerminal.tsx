"use client";

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import "./rcli.css";

// A faithful replica of a Backboard R-CLI session, built from the CLI's own
// Ink components (cli-ts/src/ui): the cyan mascot + session card, the ❯
// prompt segments, ●/✓ tool rows with diff tints, and the mode status bar.

const MASCOT = [
  { line: "  #######  ", half: true },
  { line: " #########  ", half: false },
  { line: "## ### #### ", half: false },
  { line: " #########  ", half: false },
  { line: "  # # # #  ", half: true },
];

function Mascot() {
  return (
    <span className="rt-mascot" aria-hidden="true">
      {MASCOT.map((r, i) => (
        <span key={i} className={`rt-mrow${r.half ? " is-half" : ""}`}>
          {[...r.line.padEnd(12)].map((c, j) => (
            <i key={j} className={c === "#" ? "is-on" : ""} />
          ))}
        </span>
      ))}
    </span>
  );
}

const PROMPT = "add a tide table to the report";
const MODEL = "anthropic/claude-opus-4-8";

// Beats, in order. Each appears when `beat` reaches its index.
const BEATS = [
  "shell",
  "card",
  "prompt",
  "read",
  "edit",
  "test",
  "reply",
  "status",
] as const;
type Beat = (typeof BEATS)[number];
const HOLD: Record<Beat, number> = {
  shell: 900,
  card: 1400,
  prompt: 700,
  read: 900,
  edit: 1300,
  test: 1200,
  reply: 1200,
  status: 5200,
};

function useTyped(text: string, active: boolean, speed = 42) {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!active) {
      setN(0);
      return;
    }
    if (n >= text.length) return;
    const t = window.setTimeout(
      () => setN((v) => v + 1),
      speed + Math.random() * 40,
    );
    return () => clearTimeout(t);
  }, [active, n, text, speed]);
  return { text: text.slice(0, n), done: n >= text.length };
}

function Tool({
  running,
  name,
  arg,
  children,
}: {
  running: boolean;
  name: string;
  arg: string;
  children?: ReactNode;
}) {
  return (
    <div className="rt-tool">
      <div>
        <span className={running ? "rt-cyan rt-pulse" : "rt-green"}>
          {running ? "●" : "✓"}
        </span>{" "}
        <b className={`rt-cyan${running ? " rt-shadow" : ""}`}>{name}</b>
      </div>
      <div className="rt-in">
        <span className="rt-dim">{arg}</span>
      </div>
      {!running && children}
    </div>
  );
}

export function RCliTerminal({
  className = "",
  compact = false,
}: {
  className?: string;
  /** Tight layout for small spots (the CLI grid): one-row session header, no status bar. */
  compact?: boolean;
}) {
  const [beat, setBeat] = useState(0);
  const [settled, setSettled] = useState(false); // current beat finished its "running" phase
  const [wake, setWake] = useState(0); // re-checks visibility while paused offscreen
  const root = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const visible = useRef(false);
  const reduced = useRef(false);

  const shell = useTyped("backboard", beat === 0);
  const ask = useTyped(PROMPT, beat === 2 && !settled, 38);

  useEffect(() => {
    reduced.current = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    if (reduced.current) {
      setBeat(BEATS.length - 1);
      setSettled(true);
      return;
    }
    const io = new IntersectionObserver(
      ([e]) => (visible.current = e.isIntersecting),
      { threshold: 0.25 },
    );
    if (root.current) io.observe(root.current);
    return () => io.disconnect();
  }, []);

  // Advance through the beats; typed beats wait for their typing to finish.
  useEffect(() => {
    if (reduced.current) return;
    const name = BEATS[beat];
    if (name === "shell" && !shell.done) return;
    if (name === "prompt" && !ask.done && !settled) return;
    const t = window.setTimeout(
      () => {
        if (!visible.current || document.hidden) {
          setWake((w) => w + 1); // paused offscreen; look again shortly
          return;
        }
        if (!settled) {
          setSettled(true);
          return;
        }
        setSettled(false);
        setBeat((b) => (b + 1) % BEATS.length);
      },
      settled ? 260 : HOLD[name],
    );
    return () => clearTimeout(t);
  }, [beat, settled, shell.done, ask.done, wake]);

  useEffect(() => {
    const el = body.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [beat, settled, ask.text]);

  const at = (b: Beat) => BEATS.indexOf(b) <= beat;
  const running = (b: Beat) => BEATS[beat] === b && !settled;

  return (
    <div
      className={`rt-win${compact ? " is-compact" : ""} ${className}`}
      ref={root}
      role="img"
      aria-label="Backboard R-CLI session adding a tide table"
    >
      <div className="rt-bar" aria-hidden="true">
        <span className="rt-lights">
          <i />
          <i />
          <i />
        </span>
        <span className="rt-title">backboard — ~/surf-report — zsh</span>
      </div>
      <div className="rt-body" ref={body} aria-hidden="true">
        <div className="rt-line">
          <span className="rt-green">erin@MacBook-Pro</span>{" "}
          <span className="rt-blue">~/surf-report</span>{" "}
          <span className="rt-dim">%</span>{" "}
          {beat === 0 ? shell.text : "backboard"}
          {beat === 0 && <span className="rt-caret" />}
        </div>

        {at("card") && compact && (
          <div className="rt-card is-compact">
            <Mascot />
            <div>
              <b>Backboard CLI is ready</b>
              <div className="rt-dim">
                ~/surf-report · <span className="rt-cyan">{MODEL}</span>
              </div>
            </div>
            <span className="rt-green rt-synced">● Synced</span>
          </div>
        )}

        {at("card") && !compact && (
          <div className="rt-card">
            <div className="rt-card-head">
              <Mascot />
              <div>
                <b>Backboard CLI is ready</b>
                <div className="rt-dim">Connected workspace: ~/surf-report</div>
                <div className="rt-green">Status: Synced</div>
              </div>
            </div>
            <b className="rt-card-h">Current Session</b>
            <div className="rt-row">
              <span className="rt-dim">mode</span>agent
            </div>
            <div className="rt-row">
              <span className="rt-dim">model</span>
              <span className="rt-cyan">{MODEL}</span>
            </div>
            <div className="rt-row">
              <span className="rt-dim">context</span>0 / 1.0M
            </div>
            <div className="rt-row is-gap">
              <b className="rt-cyan">/help</b>
              <span className="rt-dim">View commands</span>
            </div>
          </div>
        )}

        {at("prompt") && (
          <>
            <div className="rt-segs">
              <span className="rt-seg">backboard</span>
              <span className="rt-dim">❯</span>
              <span className="rt-seg is-plain">~/surf-report</span>
              <span className="rt-dim">❯</span>
              <span className="rt-seg is-plain">v3.0.2</span>
            </div>
            <div className="rt-ask">
              <span className="rt-cyan">›</span>{" "}
              {BEATS[beat] === "prompt" && !settled ? ask.text : PROMPT}
              {BEATS[beat] === "prompt" && !settled && (
                <span className="rt-caret" />
              )}
            </div>
          </>
        )}

        {at("read") && (
          <Tool
            running={running("read")}
            name="Read"
            arg="src/forecast.ts · 44 lines"
          />
        )}

        {at("edit") && (
          <Tool
            running={running("edit")}
            name="Write"
            arg="src/components/TideTable.tsx"
          >
            <div className="rt-result">
              <span className="rt-dim">⎿ </span>Created <b>TideTable.tsx</b>{" "}
              <span className="rt-green">+29</span>
            </div>
            <div className="rt-diff">
              <div className="is-add">
                <span>1</span>+ export function TideTable({"{ tides }"}) {"{"}
              </div>
              <div className="is-add">
                <span>2</span>+ {"  "}const next = tides.find((t) =&gt; t.at
                &gt; now);
              </div>
              <div className="is-add">
                <span>3</span>+ {"  "}return &lt;table
                className=&quot;tides&quot;&gt;…
              </div>
            </div>
          </Tool>
        )}

        {at("test") && (
          <Tool running={running("test")} name="Bash" arg="npm test">
            <div className="rt-result">
              <span className="rt-dim">⎿ </span>
              <span className="rt-green">✓ 16 passed</span>{" "}
              <span className="rt-dim">(1.2s)</span>
            </div>
          </Tool>
        )}

        {at("reply") && (
          <div className="rt-reply">
            Added a tide table under the swell chart. Highs and lows with times,
            and the next change is highlighted. All 16 tests pass.
          </div>
        )}
      </div>

      <div className="rt-foot" aria-hidden="true">
        <div className="rt-input">
          <span className="rt-cyan">›</span>
          <span className="rt-dim">
            {running("read") || running("edit") || running("test")
              ? "Working… esc to interrupt"
              : "Ask anything, / for commands"}
          </span>
        </div>
        <div className="rt-status">
          <b className="rt-cyan">✦ auto mode</b>
          <span className="rt-dim">
            {" "}
            · (shift+tab to cycle) · {MODEL} · high
          </span>
        </div>
      </div>
    </div>
  );
}
