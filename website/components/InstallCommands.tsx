"use client";

import { useState } from "react";
import { track } from "@/lib/analytics";
import "./install.css";

// The official one-line installers, as published on backboard.io/products/cli.
export const INSTALL = [
  {
    id: "unix",
    label: "macOS / Linux",
    prompt: "$",
    cmd: "curl -fsSL https://app.backboard.io/api/cli | bash",
  },
  {
    id: "win",
    label: "Windows (PowerShell)",
    prompt: "PS>",
    cmd: "irm https://app.backboard.io/api/cli/windows | iex",
  },
];

// Colour a one-liner like a shell would: program, flags, URL, pipe.
function Shell({ cmd }: { cmd: string }) {
  return (
    <>
      {cmd.split(" ").map((w, i) => (
        <span
          key={i}
          className={
            w === "|"
              ? "ic-pipe"
              : w.startsWith("-")
                ? "ic-flag"
                : w.startsWith("http")
                  ? "ic-url"
                  : "ic-prog"
          }
        >
          {i > 0 ? " " : ""}
          {w}
        </span>
      ))}
    </>
  );
}

// Both installers in one README-style code block: a comment line names the
// platform, the command sits under it, and each command has its own copy icon.
export function InstallCommands({ className = "" }: { className?: string }) {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = async (id: string, cmd: string) => {
    track("install_command_copied", { product: "cli", platform: id });
    try {
      await navigator.clipboard.writeText(cmd);
      setCopied(id);
      window.setTimeout(() => setCopied((c) => (c === id ? null : c)), 1600);
    } catch {
      // Clipboard can be blocked; the command stays selectable either way.
    }
  };
  return (
    <div className={`ic ${className}`}>
      {INSTALL.map((i) => (
        <div key={i.id} className="ic-group">
          <p className="ic-comment"># {i.label}</p>
          <div className="ic-line">
            <span className="ic-prompt" aria-hidden="true">
              {i.prompt}
            </span>
            <code>
              <Shell cmd={i.cmd} />
            </code>
            <button
              type="button"
              className={`ic-copy${copied === i.id ? " is-done" : ""}`}
              onClick={() => copy(i.id, i.cmd)}
              aria-label={`Copy the ${i.label} install command`}
              title={copied === i.id ? "Copied" : "Copy"}
            >
              {copied === i.id ? (
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M3 8.5l3 3 7-7" />
                </svg>
              ) : (
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <rect x="5" y="5" width="8.5" height="8.5" rx="1.5" />
                  <path d="M10.5 3.5v-.5A1.5 1.5 0 0 0 9 1.5H3A1.5 1.5 0 0 0 1.5 3v6A1.5 1.5 0 0 0 3 10.5h.5" />
                </svg>
              )}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
