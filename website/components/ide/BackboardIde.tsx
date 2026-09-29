"use client";

import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { CSSProperties, FormEvent, KeyboardEvent, ReactNode } from "react";
import {
  AUTOPLAY_PROMPT,
  CANVAS,
  CONNECTORS,
  FILES,
  INITIAL_SITE,
  MODELS,
  SCRIPTS,
  SESSIONS,
  SUGGESTIONS,
  TERMINAL_BOOT,
  TREE,
  pickScript,
  type DiffLine,
  type FileNode,
  type Msg,
  type Script,
  type Session,
  type Site,
  type Tool,
} from "./data";
import { highlight, langOf } from "./highlight";
import "./ide.css";

// The replica is laid out at a real 16:10 window size and scaled as a whole, so
// every line stays vector-sharp at any size, from a phone to a 6K display.
const W = 1440;
const H = 900;

// Codicons, the same icon font the real app uses.
const I = {
  files: "",
  search: "",
  scm: "",
  debug: "",
  ext: "",
  plug: "",
  media: "",
  graph: "",
  table: "",
  color: "",
  gear: "",
  account: "",
  edit: "",
  folder: "",
  folderOpen: "",
  down: "",
  right: "",
  close: "",
  terminal: "",
  globe: "",
  add: "",
  check: "",
  loading: "",
  sparkle: "",
  error: "",
  warning: "",
  bell: "",
  ellipsis: "",
  refresh: "",
  diff: "",
  pass: "",
  json: "",
  markdown: "",
  file: "",
  shield: "",
  sync: "",
  remote: "",
  history: "",
  mic: "",
  arrowUp: "",
  back: "",
  fwd: "",
  tree: "",
  sideL: "",
  sideR: "",
  panel: "",
  branch: "",
  code: "",
  full: "",
  newFile: "",
  newFolder: "",
  split: "",
  external: "",
  comment: "",
  filter: "",
  video: "",
};
const Ic = ({
  i,
  className = "",
  style,
}: {
  i: string;
  className?: string;
  style?: CSSProperties;
}) => (
  <i className={`bi-ic ${className}`} style={style} aria-hidden="true">
    {i}
  </i>
);

type Mode = "simple" | "editor";
type View = "chat" | "canvas" | "connectors" | "usage";
type RightTab = "preview" | "review" | "terminal";

const VERB: Record<Tool["k"], [string, string]> = {
  read: ["Read", "Reading"],
  edit: ["Edited", "Editing"],
  create: ["Created", "Creating"],
  run: ["Ran", "Running"],
  search: ["Searched for", "Searching for"],
};

// `code` and **bold** in agent replies.
function inline(text: string): ReactNode[] {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).map((part, i) => {
    if (part.startsWith("`") && part.endsWith("`"))
      return <code key={i}>{part.slice(1, -1)}</code>;
    if (part.startsWith("**") && part.endsWith("**"))
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    return <Fragment key={i}>{part}</Fragment>;
  });
}

function diffStats(tools: Tool[]) {
  const files = tools.filter((t) => t.k === "edit" || t.k === "create");
  return {
    files,
    add: files.reduce((n, t) => n + (t.add ?? 0), 0),
    del: files.reduce((n, t) => n + (t.del ?? 0), 0),
  };
}

// ---------- chat pieces ----------

function AgentMessage({
  m,
  onReview,
}: {
  m: Extract<Msg, { role: "agent" }>;
  onReview: () => void;
}) {
  const [open, setOpen] = useState(true);
  if (m.stage === "thinking") {
    return (
      <div className="bi-agent">
        <p className="bi-shimmer">Thinking</p>
      </div>
    );
  }
  const words = m.reply.split(" ");
  const shown =
    m.stage === "done" ? m.reply : words.slice(0, m.shownWords).join(" ");
  const tools = m.tools.slice(0, m.shownTools);
  const stats = diffStats(m.tools);
  return (
    <div className="bi-agent">
      <button
        type="button"
        className="bi-worked"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {m.stage === "done" ? `Worked for ${m.secs}s` : "Working"}
        <Ic i={open ? I.down : I.right} />
      </button>
      {open && (
        <ul className="bi-tools">
          {tools.map((t, i) => {
            const live = m.stage === "tools" && i === tools.length - 1;
            return (
              <li key={i} className={live ? "is-live" : ""}>
                <span className="bi-tool-verb">{VERB[t.k][live ? 1 : 0]}</span>
                <span className="bi-tool-path">{t.path}</span>
                {t.add !== undefined && (
                  <span className="bi-add">+{t.add}</span>
                )}
                {t.del !== undefined && (
                  <span className="bi-del">−{t.del}</span>
                )}
                {t.note && !live && (
                  <span className="bi-tool-note">{t.note}</span>
                )}
                {live && <Ic i={I.loading} className="bi-spin" />}
              </li>
            );
          })}
        </ul>
      )}
      {(m.stage === "text" || m.stage === "done") && (
        <p className="bi-reply">
          {inline(shown)}
          {m.stage === "text" && <span className="bi-caret" />}
        </p>
      )}
      {m.stage === "done" && stats.files.length > 0 && (
        <div className="bi-changes">
          <div className="bi-changes-head">
            <span>
              {stats.files.length} file{stats.files.length > 1 ? "s" : ""}{" "}
              changed <span className="bi-add">+{stats.add}</span>{" "}
              <span className="bi-del">−{stats.del}</span>
            </span>
            <button type="button" onClick={onReview}>
              Review
            </button>
          </div>
          {stats.files.slice(0, 3).map((f) => (
            <div key={f.path} className="bi-changes-file">
              <Ic i={I.code} />
              <span>{f.path}</span>
              <span className="bi-add">+{f.add ?? 0}</span>
              <span className="bi-del">−{f.del ?? 0}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Transcript({
  session,
  onReview,
}: {
  session: Session;
  onReview: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  });
  return (
    <div className="bi-transcript" ref={ref}>
      <div className="bi-transcript-inner">
        {session.msgs.map((m) =>
          m.role === "user" ? (
            <div key={m.id} className="bi-user">
              <p>{m.text}</p>
            </div>
          ) : (
            <AgentMessage key={m.id} m={m} onReview={onReview} />
          ),
        )}
      </div>
    </div>
  );
}

type ComposerProps = {
  draft: string;
  setDraft: (v: string) => void;
  onSend: (text: string) => void;
  busy: boolean;
  model: number;
  setModel: (i: number) => void;
  access: string;
  setAccess: (v: string) => void;
  placeholder?: string;
  compact?: boolean;
};

function Composer({
  draft,
  setDraft,
  onSend,
  busy,
  model,
  setModel,
  access,
  setAccess,
  placeholder,
  compact,
}: ComposerProps) {
  const [menu, setMenu] = useState<null | "model" | "access">(null);
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (draft.trim() && !busy) onSend(draft.trim());
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };
  const m = MODELS[model];
  return (
    <form
      className={`bi-composer${compact ? " is-compact" : ""}`}
      onSubmit={submit}
    >
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKey}
        rows={compact ? 1 : 2}
        placeholder={
          placeholder ?? "Ask Backboard to build, fix or explain anything"
        }
        aria-label="Message Backboard"
      />
      <div className="bi-composer-row">
        <button type="button" className="bi-round" aria-label="Attach">
          <Ic i={I.add} />
        </button>
        <button
          type="button"
          className="bi-chip"
          onClick={() => setMenu(menu === "access" ? null : "access")}
        >
          <Ic i={I.shield} /> {access} <Ic i={I.down} className="bi-small" />
        </button>
        <span className="bi-grow" />
        <button
          type="button"
          className="bi-chip is-plain"
          onClick={() => setMenu(menu === "model" ? null : "model")}
        >
          <img src={m.icon} alt="" width={14} height={14} /> {m.name}{" "}
          <Ic i={I.down} className="bi-small" />
        </button>
        {!compact && (
          <button
            type="button"
            className="bi-round is-plain"
            aria-label="Dictate"
          >
            <Ic i={I.mic} />
          </button>
        )}
        <button
          type="submit"
          className={`bi-send${draft.trim() && !busy ? " is-ready" : ""}`}
          aria-label="Send"
          disabled={!draft.trim() || busy}
        >
          {busy ? <span className="bi-stop" /> : <Ic i={I.arrowUp} />}
        </button>
      </div>
      {menu === "model" && (
        <div className="bi-menu is-right" role="menu">
          <p className="bi-menu-label">Model</p>
          {MODELS.map((x, i) => (
            <button
              key={x.name}
              type="button"
              role="menuitemradio"
              aria-checked={i === model}
              onClick={() => {
                setModel(i);
                setMenu(null);
              }}
            >
              <img src={x.icon} alt="" width={16} height={16} />
              <span>{x.name}</span>
              <small>{x.note}</small>
              {i === model && <Ic i={I.check} />}
            </button>
          ))}
          <p className="bi-menu-foot">
            + 50 more providers, or bring your own subscription
          </p>
        </div>
      )}
      {menu === "access" && (
        <div className="bi-menu" role="menu">
          <p className="bi-menu-label">Access</p>
          {[
            ["Full access", "Edit files and run commands"],
            ["Ask first", "Approve every change"],
            ["Read only", "Look, don't touch"],
          ].map(([name, note]) => (
            <button
              key={name}
              type="button"
              role="menuitemradio"
              aria-checked={access === name}
              onClick={() => {
                setAccess(name);
                setMenu(null);
              }}
            >
              <span>{name}</span>
              <small>{note}</small>
              {access === name && <Ic i={I.check} />}
            </button>
          ))}
        </div>
      )}
    </form>
  );
}

// ---------- right panel ----------

function SitePreview({ site, pulse }: { site: Site; pulse: string }) {
  const days = [
    ["SAT", 3],
    ["SUN", 4],
    ["MON", 6],
    ["TUE", 5],
    ["WED", 2],
  ] as const;
  const style = { "--sea": site.accent } as CSSProperties;
  return (
    <div className={`bi-site is-${site.theme}`} style={style}>
      <nav className="bi-site-nav">
        <b>
          <i aria-hidden="true" />
          Montauk Surf
        </b>
        <span>Report</span>
        <span>Tides</span>
        <span>Cams</span>
        <em>Subscribe</em>
      </nav>
      <header
        className={`bi-site-hero${pulse === "theme" || pulse === "sunset" ? " is-new" : ""}`}
      >
        <p className="bi-site-kicker">Ditch Plains · Today</p>
        <h3>4–5 ft</h3>
        <p>Clean and glassy with an offshore breeze. Paddle out before 9.</p>
        <span className="bi-site-rating">★★★★☆ Good</span>
        <img src="/assets/surf/wave-ribbon.webp" alt="" />
      </header>
      <div className="bi-site-stats">
        {[
          ["Wind", "8 mph", "NW, offshore"],
          ["Water", "68°F", "3/2 wetsuit"],
          ["Tide", "Rising", "High 11:58"],
          ["Period", "11 s", "SE groundswell"],
        ].map(([k, v, note]) => (
          <span key={k}>
            <small>{k}</small>
            <b>{v}</b>
            <i>{note}</i>
          </span>
        ))}
      </div>
      <section className="bi-site-window">
        <p className="bi-site-kicker">Best window</p>
        <div className="bi-site-timeline">
          <span style={{ left: "8%", width: "26%" }} />
        </div>
        <div className="bi-site-hours">
          <small>5 am</small>
          <small>9 am</small>
          <small>1 pm</small>
          <small>5 pm</small>
        </div>
      </section>
      {site.chart && (
        <section
          className={`bi-site-chart${pulse === "chart" ? " is-new" : ""}`}
        >
          <p className="bi-site-kicker">5-day swell</p>
          <div className="bi-site-bars">
            {days.map(([d, ft]) => (
              <div key={d}>
                {ft === 6 && <em>go surf</em>}
                <span style={{ height: `${(ft / 6) * 100}%` }} />
                <b>{d}</b>
                <small>{ft} ft</small>
              </div>
            ))}
          </div>
        </section>
      )}
      {site.tides && (
        <section
          className={`bi-site-tides${pulse === "tides" ? " is-new" : ""}`}
        >
          <p className="bi-site-kicker">Tides today</p>
          <table>
            <tbody>
              {[
                ["Low", "5:42 am", "0.4"],
                ["High", "11:58 am", "3.1"],
                ["Low", "6:10 pm", "0.6"],
              ].map(([k, t, ft], i) => (
                <tr key={t} className={i === 1 ? "is-next" : ""}>
                  <td>{k}</td>
                  <td>{t}</td>
                  <td>{ft} ft</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      {site.extras.map((x, i) => (
        <section
          key={x + i}
          className={`bi-site-extra${pulse === "any" && i === site.extras.length - 1 ? " is-new" : ""}`}
        >
          <p className="bi-site-kicker">New section</p>
          <h4>{x}</h4>
          <p>
            Built from your prompt. Edit it in Editor mode, or just ask for
            changes.
          </p>
        </section>
      ))}
      <section className="bi-site-spots">
        <p className="bi-site-kicker">Nearby spots</p>
        {[
          ["Turtle Cove", "3–4 ft", 4],
          ["Camp Hero", "4–6 ft", 3],
          ["Ditch Plains", "4–5 ft", 4],
        ].map(([name, size, stars]) => (
          <div key={name as string}>
            <b>{name}</b>
            <span>{size}</span>
            <em>
              {"●".repeat(stars as number) + "○".repeat(5 - (stars as number))}
            </em>
          </div>
        ))}
      </section>
      <footer>Updated every 10 minutes · buoy 44017</footer>
    </div>
  );
}

function DiffView({ diff }: { diff: Script["diff"] }) {
  let a = 11;
  let b = 11;
  const add = diff.lines.filter((l) => l[0] === "+").length;
  const del = diff.lines.filter((l) => l[0] === "-").length;
  return (
    <div className="bi-diff">
      <div className="bi-diff-head">
        <Ic i={I.code} />
        <span>{diff.file}</span>
        <span className="bi-add">+{add}</span>
        <span className="bi-del">−{del}</span>
        <span className="bi-grow" />
        <button type="button">Revert</button>
        <button type="button" className="is-primary">
          Keep
        </button>
      </div>
      <div className="bi-diff-body">
        {diff.lines.map(([k, text]: DiffLine, i) => {
          const left = k === "+" ? "" : a++;
          const right = k === "-" ? "" : b++;
          return (
            <div
              key={i}
              className={`bi-diff-line is-${k === "+" ? "add" : k === "-" ? "del" : "ctx"}`}
            >
              <span className="bi-ln">{left}</span>
              <span className="bi-ln">{right}</span>
              <span className="bi-diff-mark">
                {k === " " ? "" : k === "-" ? "−" : "+"}
              </span>
              <code>
                {highlight(text, langOf(diff.file)).map(([c, t], j) => (
                  <span key={j} className={c && `t-${c}`}>
                    {t}
                  </span>
                ))}
              </code>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Terminal({ lines, busy }: { lines: string[]; busy?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  });
  return (
    <div className="bi-term" ref={ref}>
      {lines.map((l, i) => (
        <div
          key={i}
          className={
            l.startsWith("$")
              ? "is-cmd"
              : l.includes("✓")
                ? "is-ok"
                : l.includes("➜")
                  ? "is-link"
                  : ""
          }
        >
          {l || " "}
        </div>
      ))}
      <div className="is-cmd">
        <span className="bi-term-prompt">surf-report</span>{" "}
        <span className="bi-term-branch">main</span> ${" "}
        {!busy && <span className="bi-block" />}
      </div>
    </div>
  );
}

// ---------- main ----------

export function BackboardIde({
  autoplay = true,
  className = "",
}: {
  autoplay?: boolean;
  className?: string;
}) {
  const [mode, setMode] = useState<Mode>("simple");
  const [view, setView] = useState<View>("chat");
  const [navOpen, setNavOpen] = useState(true);
  const [panelOpen, setPanelOpen] = useState(true);
  const [sessions, setSessions] = useState<Session[]>(SESSIONS);
  const [activeId, setActiveId] = useState("s1");
  const [draft, setDraft] = useState("");
  const [site, setSite] = useState<Site>(INITIAL_SITE);
  const [pulse, setPulse] = useState("");
  const [rightTab, setRightTab] = useState<RightTab>("preview");
  const [diff, setDiff] = useState<Script["diff"]>(SCRIPTS[0].diff);
  const [term, setTerm] = useState<string[]>(TERMINAL_BOOT);
  const [busy, setBusy] = useState(false);
  const [model, setModel] = useState(0);
  const [access, setAccess] = useState("Full access");
  const [plugged, setPlugged] = useState(CONNECTORS.map((c) => c.on));
  const [canvasSel, setCanvasSel] = useState(0);
  const [expanded, setExpanded] = useState(false);
  // editor
  const [openFiles, setOpenFiles] = useState([
    "src/App.tsx",
    "src/styles.css",
    "src/forecast.ts",
  ]);
  const [activeFile, setActiveFile] = useState("src/App.tsx");
  const [closed, setClosed] = useState<Record<string, boolean>>({
    ".github": true,
    public: true,
  });
  const [bottomTab, setBottomTab] = useState<
    "problems" | "output" | "terminal"
  >("terminal");
  const [cursor, setCursor] = useState(9);

  const stageRef = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState({ s: 0.5, x: 0, y: 0 });
  const auto = useRef(autoplay);
  const timers = useRef<number[]>([]);
  const run = useRef<null | {
    sid: string;
    mid: string;
    script: Script;
    prompt: string;
    stage: "thinking" | "tools" | "text" | "done";
    shownTools: number;
    shownWords: number;
    words: number;
    at: number;
  }>(null);

  const active = sessions.find((s) => s.id === activeId) ?? sessions[0];

  // Fit the fixed-size window into whatever box the page gives us.
  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      const s = Math.min(r.width / W, r.height / H);
      setFit({ s, x: (r.width - W * s) / 2, y: (r.height - H * s) / 2 });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [expanded]);

  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: globalThis.KeyboardEvent) =>
      e.key === "Escape" && setExpanded(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded]);

  const patchMsg = useCallback(
    (
      sid: string,
      mid: string,
      patch: Partial<Extract<Msg, { role: "agent" }>>,
    ) => {
      setSessions((all) =>
        all.map((s) =>
          s.id !== sid
            ? s
            : {
                ...s,
                msgs: s.msgs.map((m) =>
                  m.id === mid && m.role === "agent" ? { ...m, ...patch } : m,
                ),
              },
        ),
      );
    },
    [],
  );

  // The agent run loop: think, call tools one by one, then stream the reply.
  useEffect(() => {
    if (!busy) return;
    const id = window.setInterval(() => {
      const r = run.current;
      if (!r) return;
      const now = performance.now();
      if (r.stage === "thinking" && now - r.at > 1100) {
        r.stage = "tools";
        r.shownTools = 1;
        r.at = now;
      } else if (r.stage === "tools" && now - r.at > 560) {
        r.at = now;
        if (r.shownTools < r.script.tools.length) {
          r.shownTools++;
          if (r.script.tools[r.shownTools - 1].k === "run")
            setTerm((lines) => [...lines, ...r.script.term]);
        } else r.stage = "text";
      } else if (r.stage === "text") {
        r.shownWords += 2;
        if (r.shownWords >= r.words) {
          r.stage = "done";
          setSite((s) => r.script.effect(s, r.prompt));
          setPulse(r.script.id);
          setDiff(r.script.diff);
          setRightTab("preview");
          setPanelOpen(true);
          run.current = null;
          setBusy(false);
        }
      }
      patchMsg(r.sid, r.mid, {
        stage: r.stage,
        shownTools: r.shownTools,
        shownWords: r.shownWords,
      });
    }, 55);
    return () => clearInterval(id);
  }, [busy, patchMsg]);

  const send = useCallback(
    (text: string) => {
      if (run.current) return;
      const script = pickScript(text);
      const mid = `r${Date.now()}`;
      const sid = activeId;
      const agent: Msg = {
        id: mid,
        role: "agent",
        script: script.id,
        prompt: text,
        tools: script.tools,
        reply: script.reply,
        secs: 4 + script.tools.length * 2,
        stage: "thinking",
        shownTools: 0,
        shownWords: 0,
      };
      setSessions((all) =>
        all.map((s) =>
          s.id !== sid
            ? s
            : {
                ...s,
                title: s.msgs.length === 0 ? text : s.title,
                msgs: [...s.msgs, { id: `u${mid}`, role: "user", text }, agent],
              },
        ),
      );
      setDraft("");
      setView("chat");
      run.current = {
        sid,
        mid,
        script,
        prompt: text,
        stage: "thinking",
        shownTools: 0,
        shownWords: 0,
        words: script.reply.split(" ").length,
        at: performance.now(),
      };
      setBusy(true);
    },
    [activeId],
  );

  // Autoplay: once visible, type a prompt and send it, like a person would.
  useEffect(() => {
    if (
      !autoplay ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    )
      return;
    const el = stageRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([e]) => {
        if (!e.isIntersecting || !auto.current) return;
        io.disconnect();
        const start = window.setTimeout(() => {
          let i = 0;
          const tick = () => {
            if (!auto.current) return;
            i++;
            setDraft(AUTOPLAY_PROMPT.slice(0, i));
            if (i < AUTOPLAY_PROMPT.length)
              timers.current.push(
                window.setTimeout(tick, 38 + Math.random() * 50),
              );
            else
              timers.current.push(
                window.setTimeout(() => {
                  if (!auto.current) return;
                  auto.current = false;
                  send(AUTOPLAY_PROMPT);
                }, 450),
              );
          };
          tick();
        }, 1300);
        timers.current.push(start);
      },
      { threshold: 0.4 },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      timers.current.forEach(clearTimeout);
    };
  }, [autoplay, send]);

  const takeOver = () => {
    if (!auto.current) return;
    auto.current = false;
    timers.current.forEach(clearTimeout);
    setDraft("");
  };

  const newChat = () => {
    const id = `n${Date.now()}`;
    setSessions((all) => [
      { id, title: "New chat", folder: "surf-report", msgs: [], ago: "now" },
      ...all,
    ]);
    setActiveId(id);
    setView("chat");
  };

  const openFile = (path: string) => {
    setOpenFiles((f) => (f.includes(path) ? f : [...f, path]));
    setActiveFile(path);
    setCursor(1);
  };
  const closeFile = (path: string) => {
    setOpenFiles((f) => {
      const next = f.filter((x) => x !== path);
      if (path === activeFile) setActiveFile(next[next.length - 1] ?? "");
      return next;
    });
  };

  const folders = useMemo(() => {
    const out: [string, Session[]][] = [];
    for (const s of sessions) {
      const g = out.find(([f]) => f === s.folder);
      if (g) g[1].push(s);
      else out.push([s.folder, [s]]);
    }
    return out;
  }, [sessions]);

  const composer = (compact = false, placeholder?: string) => (
    <Composer
      draft={draft}
      setDraft={setDraft}
      onSend={send}
      busy={busy}
      model={model}
      setModel={setModel}
      access={access}
      setAccess={setAccess}
      compact={compact}
      placeholder={placeholder}
    />
  );

  const review = () => {
    setRightTab("review");
    setPanelOpen(true);
  };

  // ---------- Simple mode ----------
  const simple = (
    <div
      className={`bi-simple${navOpen ? "" : " no-nav"}${panelOpen ? "" : " no-panel"}`}
    >
      <nav className="bi-rail" aria-label="Tools">
        {(
          [
            ["connectors", I.plug, "Connectors"],
            ["canvas", I.media, "Canvas"],
            ["usage", I.graph, "Usage"],
          ] as const
        ).map(([v, icon, label]) => (
          <button
            key={v}
            type="button"
            className={view === v ? "is-on" : ""}
            onClick={() => setView(view === v ? "chat" : v)}
            aria-label={label}
            title={label}
          >
            <Ic i={icon} />
          </button>
        ))}
        <span className="bi-grow" />
        <button type="button" aria-label="Split grid" title="Split grid">
          <Ic i={I.table} />
        </button>
        <button type="button" aria-label="Background" title="Background">
          <Ic i={I.color} />
        </button>
        <button type="button" aria-label="Settings" title="Settings">
          <Ic i={I.gear} />
        </button>
        <span className="bi-avatar">E</span>
      </nav>

      {navOpen && (
        <aside className="bi-nav" aria-label="Chats">
          <div className="bi-nav-head">
            <button type="button" className="bi-newchat" onClick={newChat}>
              <Ic i={I.edit} /> New chat
            </button>
            <span className="bi-grow" />
            <button type="button" className="bi-iconbtn" aria-label="Search">
              <Ic i={I.search} />
            </button>
            <button type="button" className="bi-iconbtn" aria-label="Compact">
              <Ic i={I.tree} />
            </button>
          </div>
          <div className="bi-nav-filter">
            All folders <Ic i={I.down} className="bi-small" />
            <span className="bi-grow" />
            <Ic i={I.newFolder} />
          </div>
          <div className="bi-nav-list">
            {folders.map(([folder, list]) => (
              <div key={folder} className="bi-folder">
                <p>
                  <Ic i={I.folder} /> {folder}
                </p>
                {list.map((s) => {
                  const live = busy && run.current?.sid === s.id;
                  return (
                    <button
                      key={s.id}
                      type="button"
                      className={`bi-session${s.id === activeId && view === "chat" ? " is-on" : ""}`}
                      onClick={() => {
                        setActiveId(s.id);
                        setView("chat");
                      }}
                    >
                      <span>{s.title}</span>
                      {live ? (
                        <Ic i={I.loading} className="bi-spin" />
                      ) : (
                        <small>{s.ago}</small>
                      )}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </aside>
      )}

      <main className="bi-card">
        {view === "chat" &&
          (active.msgs.length === 0 ? (
            <div className="bi-empty">
              <h3>What should we build?</h3>
              {composer(false, "Describe an app, a fix, or a wild idea")}
              <div className="bi-suggest">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => send(s)}
                    disabled={busy}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <>
              <div className="bi-chat-head">
                <span>{active.title}</span>
                <small>surf-report · main</small>
                <span className="bi-grow" />
                <button
                  type="button"
                  className="bi-iconbtn"
                  aria-label="Toggle side panel"
                  onClick={() => setPanelOpen((v) => !v)}
                >
                  <Ic i={I.sideR} />
                </button>
              </div>
              <Transcript session={active} onReview={review} />
              <div className="bi-dock">
                {!busy && (
                  <div className="bi-suggest is-row">
                    {SUGGESTIONS.map((s) => (
                      <button key={s} type="button" onClick={() => send(s)}>
                        {s}
                      </button>
                    ))}
                  </div>
                )}
                {composer()}
              </div>
            </>
          ))}

        {view === "canvas" && (
          <div className="bi-canvas">
            <div className="bi-canvas-bar">
              <span>Canvas</span>
              <small>{CANVAS.length} images</small>
              <span className="bi-grow" />
              <button type="button" className="bi-chip">
                <Ic i={I.comment} /> Comment
              </button>
              <button type="button" className="bi-chip">
                Fit <Ic i={I.down} className="bi-small" />
              </button>
            </div>
            <div className="bi-canvas-main">
              <figure>
                <img
                  src={CANVAS[canvasSel]}
                  alt="Generated impasto surf painting"
                />
                <figcaption>Generated image</figcaption>
              </figure>
              <div className="bi-canvas-strip">
                {CANVAS.map((src, i) => (
                  <button
                    key={src}
                    type="button"
                    className={i === canvasSel ? "is-on" : ""}
                    onClick={() => setCanvasSel(i)}
                  >
                    <img src={src} alt="" />
                  </button>
                ))}
              </div>
            </div>
            <div className="bi-canvas-actions">
              <button type="button" className="bi-chip">
                <Ic i={I.refresh} /> Prompt
              </button>
              <button
                type="button"
                className="bi-chip"
                onClick={() => setView("chat")}
              >
                <Ic i={I.add} /> Chat
              </button>
            </div>
          </div>
        )}

        {view === "connectors" && (
          <div className="bi-page">
            <h3>Connectors</h3>
            <p>
              Give your agents the tools you already use. Toggle one on and
              every chat can use it.
            </p>
            <div className="bi-connectors">
              {CONNECTORS.map((c, i) => (
                <div key={c.name} className="bi-connector">
                  <span className="bi-conn-logo">{c.name[0]}</span>
                  <span>
                    <b>{c.name}</b>
                    <small>{c.note}</small>
                  </span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={plugged[i]}
                    aria-label={`${c.name} connector`}
                    className="bi-switch"
                    onClick={() =>
                      setPlugged((p) => p.map((v, j) => (j === i ? !v : v)))
                    }
                  />
                </div>
              ))}
            </div>
          </div>
        )}

        {view === "usage" && (
          <div className="bi-page">
            <h3>Usage</h3>
            <p>Last 14 days across every model and subscription.</p>
            <div className="bi-usage-stats">
              <span>
                <small>Tokens</small>4.2M
              </span>
              <span>
                <small>Chats</small>38
              </span>
              <span>
                <small>Most used</small>
                {MODELS[model].name}
              </span>
            </div>
            <div className="bi-usage-bars">
              {[22, 35, 18, 52, 64, 40, 12, 30, 71, 58, 44, 90, 66, 48].map(
                (v, i) => (
                  <span key={i} style={{ height: `${v}%` }} />
                ),
              )}
            </div>
          </div>
        )}
      </main>

      {panelOpen && (
        <aside className="bi-panel" aria-label="Side panel">
          <div className="bi-tabs" role="tablist">
            {(
              [
                ["preview", I.globe, "localhost:5173"],
                ["review", I.diff, "Review"],
                ["terminal", I.terminal, "Terminal"],
              ] as const
            ).map(([t, icon, label]) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={rightTab === t}
                className={rightTab === t ? "is-on" : ""}
                onClick={() => setRightTab(t)}
              >
                <Ic i={icon} /> {label}
              </button>
            ))}
            <button type="button" className="bi-iconbtn" aria-label="New tab">
              <Ic i={I.add} />
            </button>
            <span className="bi-grow" />
            <button
              type="button"
              className="bi-iconbtn"
              aria-label="Close panel"
              onClick={() => setPanelOpen(false)}
            >
              <Ic i={I.close} />
            </button>
          </div>
          <div className="bi-panel-body">
            {rightTab === "preview" && (
              <div className="bi-browser">
                <div className="bi-urlbar">
                  <Ic i={I.back} />
                  <Ic i={I.fwd} />
                  <Ic i={I.refresh} className={busy ? "bi-spin" : ""} />
                  <span className="bi-url">
                    <Ic i={I.globe} /> localhost:5173
                  </span>
                  <Ic i={I.external} />
                </div>
                <div className="bi-viewport" key={pulse}>
                  <SitePreview site={site} pulse={pulse} />
                </div>
              </div>
            )}
            {rightTab === "review" && <DiffView diff={diff} />}
            {rightTab === "terminal" && <Terminal lines={term} busy={busy} />}
          </div>
        </aside>
      )}
    </div>
  );

  // ---------- Editor mode ----------
  const renderTree = (
    nodes: FileNode[],
    depth: number,
    base: string,
  ): ReactNode =>
    nodes.map((n) => {
      const key = base ? `${base}/${n.name}` : n.name;
      if (n.children) {
        const isClosed = closed[key];
        return (
          <Fragment key={key}>
            <button
              type="button"
              className="bi-tree-row"
              style={{ paddingLeft: 8 + depth * 12 }}
              onClick={() => setClosed((c) => ({ ...c, [key]: !isClosed }))}
            >
              <Ic i={isClosed ? I.right : I.down} className="bi-small" />
              <span>{n.name}</span>
            </button>
            {!isClosed && renderTree(n.children, depth + 1, key)}
          </Fragment>
        );
      }
      const lang = langOf(n.name);
      return (
        <button
          key={key}
          type="button"
          className={`bi-tree-row is-file${activeFile === n.path ? " is-on" : ""}${n.git ? ` git-${n.git}` : ""}`}
          style={{ paddingLeft: 8 + depth * 12 + 14 }}
          onClick={() =>
            n.path && FILES[n.path] !== undefined && openFile(n.path)
          }
        >
          <span className={`bi-fi fi-${lang === "ts" ? "ts" : lang}`}>
            {lang === "ts"
              ? "TS"
              : lang === "css"
                ? "#"
                : lang === "json"
                  ? "{}"
                  : lang === "md"
                    ? "M↓"
                    : lang === "yml"
                      ? "!"
                      : "▣"}
          </span>
          <span>{n.name}</span>
          {n.git && <em>{n.git}</em>}
        </button>
      );
    });

  const code = FILES[activeFile] ?? "";
  const lines = code.replace(/\n$/, "").split("\n");
  const lang = langOf(activeFile);

  const editor = (
    <div className="bi-ed">
      <nav className="bi-ab" aria-label="Activity bar">
        {[I.files, I.search, I.scm, I.debug, I.ext].map((icon, i) => (
          <button
            key={i}
            type="button"
            className={i === 0 ? "is-on" : ""}
            aria-label={
              ["Explorer", "Search", "Source control", "Run", "Extensions"][i]
            }
          >
            <Ic i={icon} />
            {i === 2 && <span className="bi-badge">3</span>}
          </button>
        ))}
        <span className="bi-grow" />
        <button type="button" aria-label="Account">
          <Ic i={I.account} />
        </button>
        <button type="button" aria-label="Settings">
          <Ic i={I.gear} />
        </button>
      </nav>
      <aside className="bi-explorer" aria-label="Explorer">
        <p className="bi-ex-title">
          Explorer <span className="bi-grow" /> <Ic i={I.ellipsis} />
        </p>
        <p className="bi-ex-root">
          <Ic i={I.down} className="bi-small" /> SURF-REPORT
          <span className="bi-grow" />
          <Ic i={I.newFile} />
          <Ic i={I.newFolder} />
          <Ic i={I.refresh} />
        </p>
        <div className="bi-tree">{renderTree(TREE, 0, "")}</div>
        <p className="bi-ex-root is-closed">
          <Ic i={I.right} className="bi-small" /> OUTLINE
        </p>
        <p className="bi-ex-root is-closed">
          <Ic i={I.right} className="bi-small" /> TIMELINE
        </p>
      </aside>
      <section className="bi-edcol">
        <div className="bi-edtabs" role="tablist">
          {openFiles.map((f) => (
            <div
              key={f}
              className={`bi-edtab${f === activeFile ? " is-on" : ""}`}
              role="tab"
              aria-selected={f === activeFile}
            >
              <button type="button" onClick={() => setActiveFile(f)}>
                <span className={`bi-fi fi-${langOf(f)}`}>
                  {langOf(f) === "ts"
                    ? "TS"
                    : langOf(f) === "css"
                      ? "#"
                      : langOf(f) === "json"
                        ? "{}"
                        : "M↓"}
                </span>
                {f.split("/").pop()}
              </button>
              <button
                type="button"
                className="bi-edtab-x"
                aria-label={`Close ${f}`}
                onClick={() => closeFile(f)}
              >
                <Ic i={I.close} />
              </button>
            </div>
          ))}
          <span className="bi-grow" />
          <Ic i={I.split} />
          <Ic i={I.ellipsis} />
        </div>
        {activeFile ? (
          <>
            <div className="bi-crumbs">
              {activeFile.split("/").map((p, i, a) => (
                <Fragment key={i}>
                  <span>{p}</span>
                  {i < a.length - 1 && <Ic i={I.right} className="bi-small" />}
                </Fragment>
              ))}
            </div>
            <div
              className="bi-code"
              role="textbox"
              aria-readonly="true"
              aria-label={activeFile}
            >
              <div className="bi-code-lines">
                {lines.map((l, i) => (
                  <div
                    key={i}
                    className={`bi-cl${cursor === i + 1 ? " is-cur" : ""}`}
                    onClick={() => setCursor(i + 1)}
                  >
                    <span className="bi-gut">{i + 1}</span>
                    <code>
                      {highlight(l, lang).map(([c, t], j) => (
                        <span key={j} className={c && `t-${c}`}>
                          {t}
                        </span>
                      ))}
                      {cursor === i + 1 && <span className="bi-cursor" />}
                    </code>
                  </div>
                ))}
              </div>
              <div className="bi-minimap" aria-hidden="true">
                {lines.map((l, i) => (
                  <span
                    key={i}
                    style={{ width: Math.min(100, l.length * 1.6) }}
                  />
                ))}
              </div>
            </div>
          </>
        ) : (
          <div className="bi-ed-empty">
            <img src="/logo.svg" alt="" />
            <p>Open a file from the explorer</p>
          </div>
        )}
        <div className="bi-bottom">
          <div className="bi-bottom-tabs" role="tablist">
            {(["problems", "output", "terminal"] as const).map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={bottomTab === t}
                className={bottomTab === t ? "is-on" : ""}
                onClick={() => setBottomTab(t)}
              >
                {t}
                {t === "problems" && <span className="bi-count">0</span>}
              </button>
            ))}
            <span className="bi-grow" />
            <Ic i={I.add} />
            <Ic i={I.split} />
            <Ic i={I.close} />
          </div>
          {bottomTab === "terminal" && <Terminal lines={term} busy={busy} />}
          {bottomTab === "problems" && (
            <p className="bi-bottom-note">
              No problems have been detected in the workspace.
            </p>
          )}
          {bottomTab === "output" && (
            <div className="bi-term">
              <div>[backboard] agent ready · {MODELS[model].name}</div>
              <div>
                [backboard] connectors:{" "}
                {CONNECTORS.filter((_, i) => plugged[i])
                  .map((c) => c.name)
                  .join(", ")}
              </div>
              <div>[vite] hmr update /src/App.tsx</div>
            </div>
          )}
        </div>
      </section>
      <aside className="bi-aux" aria-label="Backboard chat">
        <div className="bi-aux-tabs">
          <span className="bi-aux-tab is-on">{active.title}</span>
          <span className="bi-grow" />
          <button
            type="button"
            className="bi-iconbtn"
            aria-label="New chat"
            onClick={newChat}
          >
            <Ic i={I.add} />
          </button>
          <button type="button" className="bi-iconbtn" aria-label="History">
            <Ic i={I.history} />
          </button>
        </div>
        {active.msgs.length ? (
          <Transcript session={active} onReview={() => setMode("simple")} />
        ) : (
          <div className="bi-aux-empty">Ask about this project</div>
        )}
        <div className="bi-dock">{composer(true)}</div>
      </aside>
    </div>
  );

  return (
    <div
      className={`bi-stage${expanded ? " is-expanded" : ""} ${className}`}
      ref={stageRef}
      onPointerDownCapture={takeOver}
      onKeyDownCapture={takeOver}
      role="region"
      aria-label="Interactive Backboard Desktop demo"
    >
      {expanded && (
        <button
          type="button"
          className="bi-scrim"
          aria-label="Close full screen"
          onClick={() => setExpanded(false)}
        />
      )}
      <div
        className="bi-window"
        style={{
          transform: `translate(${fit.x}px, ${fit.y}px) scale(${fit.s})`,
        }}
      >
        <div className="bi-title">
          <div className="bi-lights" aria-hidden="true">
            <i />
            <i />
            <i />
          </div>
          <div className="bi-seg" role="tablist" aria-label="Mode">
            {(["simple", "editor"] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="tab"
                aria-selected={mode === m}
                className={mode === m ? "is-on" : ""}
                onClick={() => setMode(m)}
              >
                {m === "simple" ? "Simple" : "Editor"}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="bi-iconbtn"
            aria-label="Toggle sidebar"
            onClick={() => setNavOpen((v) => !v)}
          >
            <Ic i={I.sideL} />
          </button>
          {mode === "editor" && (
            <div className="bi-cmd">
              <Ic i={I.search} /> surf-report
            </div>
          )}
          <span className="bi-grow" />
          <button
            type="button"
            className="bi-iconbtn"
            aria-label={expanded ? "Exit full screen" : "Full screen"}
            title={expanded ? "Exit full screen (Esc)" : "Full screen"}
            onClick={() => setExpanded((v) => !v)}
          >
            <Ic i={expanded ? I.close : I.full} />
          </button>
        </div>
        <div className="bi-body">{mode === "simple" ? simple : editor}</div>
        {mode === "editor" && (
          <footer className="bi-status">
            <span className="bi-status-remote">
              <Ic i={I.remote} />
            </span>
            <span>
              <Ic i={I.branch} /> main*
            </span>
            <span>
              <Ic i={I.sync} />
            </span>
            <span>
              <Ic i={I.error} /> 0 <Ic i={I.warning} /> 0
            </span>
            <span className="bi-grow" />
            <span>Ln {cursor}, Col 1</span>
            <span>Spaces: 2</span>
            <span>UTF-8</span>
            <span>
              {lang === "ts"
                ? "TypeScript JSX"
                : lang === "css"
                  ? "CSS"
                  : lang === "json"
                    ? "JSON"
                    : "Markdown"}
            </span>
            <span>
              <Ic i={I.sparkle} /> {MODELS[model].name}
            </span>
            <span>
              <Ic i={I.bell} />
            </span>
          </footer>
        )}
      </div>
    </div>
  );
}
