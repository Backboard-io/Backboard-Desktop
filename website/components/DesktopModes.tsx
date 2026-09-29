"use client";

import { useState } from "react";
import { DesktopMock, type Mode } from "@/components/DesktopMock";

// Three boards for three kinds of session: each mode is a surfboard, and
// picking one switches the live window beside it.
const RUNS: { mode: Mode; level: string; mark: "long" | "fun" | "short"; text: string }[] = [
  { mode: "simple", level: "Longboard", mark: "long", text: "Describe what you want in a sentence and watch it get built. No code required." },
  { mode: "editor", level: "Funboard", mark: "fun", text: "A full editor with the agent beside you. Take the wheel whenever you like." },
  { mode: "advanced", level: "Shortboard", mark: "short", text: "Run a crew of agents in parallel, each on its own task, and review them together." },
];

export function DesktopModes() {
  const [mode, setMode] = useState<Mode>("simple");
  return (
    <div className="dk-modes">
      <ol className="dk-runs">
        {RUNS.map((r) => (
          <li key={r.mode}>
            <button type="button" aria-pressed={mode === r.mode} onClick={() => setMode(r.mode)}>
              <span className={`dk-mark dk-mark--${r.mark}`} aria-hidden="true" />
              <span className="dk-run-level">{r.level}</span>
              <strong>{r.mode}</strong>
              <span className="dk-run-text">{r.text}</span>
            </button>
          </li>
        ))}
      </ol>
      <div className="dk-window">
        <DesktopMock mode={mode} onMode={setMode} />
      </div>
    </div>
  );
}
