"use client";

import { useEffect, useState } from "react";
import "./typecycle.css";

// Types a word, holds it, deletes it, moves to the next. Screen readers get
// the whole list once; reduced motion shows the first word, still.
export function TypeCycle({ words, className = "" }: { words: string[]; className?: string }) {
  const [i, setI] = useState(0);
  const [n, setN] = useState(words[0].length);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const word = words[i];
    let t: number;
    if (!deleting && n === word.length) t = window.setTimeout(() => setDeleting(true), 1900);
    else if (deleting && n === 0) {
      t = window.setTimeout(() => {
        setDeleting(false);
        setI((v) => (v + 1) % words.length);
      }, 260);
    } else t = window.setTimeout(() => setN((v) => v + (deleting ? -1 : 1)), deleting ? 38 : 75);
    return () => clearTimeout(t);
  }, [i, n, deleting, words]);

  return (
    <span className={className}>
      <span className="tc-sr">{words.join(", ")}</span>
      <span aria-hidden="true" className="tc-word">
        {words[i].slice(0, n)}
        <span className="tc-caret" />
      </span>
    </span>
  );
}
