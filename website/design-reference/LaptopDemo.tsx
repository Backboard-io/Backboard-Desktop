"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const modes = ["film", "simple", "editor", "advanced"] as const;
type Mode = (typeof modes)[number];
const descriptions: Record<Mode, string> = {
  film: "A glimpse of what you can make.",
  simple: "A thought, a conversation, a place to begin.",
  editor: "Your files and tools, with an agent right beside you.",
  advanced: "More ideas in motion. Keep the whole picture in view.",
};

export function LaptopDemo() {
  const [mode, setMode] = useState<Mode>("simple");
  const screen = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const film = useRef<HTMLVideoElement>(null);
  const sendMode = useCallback(() => {
    if (mode !== "film")
      frame.current?.contentWindow?.postMessage(
        { type: "laptop-mode", mode },
        window.location.origin,
      );
  }, [mode]);

  useEffect(() => {
    const screenElement = screen.current;
    if (!screenElement) return;
    const resize = () => {
      if (frame.current)
        frame.current.style.transform = `scale(${screenElement.clientWidth / 1100},${screenElement.clientHeight / 720})`;
    };
    const observer = new ResizeObserver(resize);
    observer.observe(screenElement);
    resize();
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    sendMode();
    if (mode === "film") void film.current?.play().catch(() => {});
    else film.current?.pause();
  }, [mode, sendMode]);

  useEffect(() => {
    const video = film.current;
    const element = screen.current;
    if (!video || !element) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) video.pause();
    });
    const handleVisibility = () => {
      if (document.hidden) video.pause();
    };
    observer.observe(element);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", handleVisibility);
      video.pause();
    };
  }, []);

  return (
    <div className="hero-demo" id="workspace">
      <div className="demo-shell">
        <div className="demo-toolbar">
          <div className="mode-picker" role="group" aria-label="Workspace mode">
            {modes.map((item) => (
              <button
                key={item}
                aria-pressed={mode === item}
                onClick={() => setMode(item)}
              >
                {item[0].toUpperCase() + item.slice(1)}
              </button>
            ))}
          </div>
        </div>
        <div className="demo-viewport">
          <img
            className="computer-hardware"
            src="/assets/laptop-meadow-hero.png"
            alt="Laptop displaying the interactive Kevin IDE"
          />
          <div className="computer-screen" ref={screen}>
            <video
              ref={film}
              hidden={mode !== "film"}
              className="demo-film"
              controls
              muted
              loop
              playsInline
              preload="none"
              poster="/assets/film/backboard-studio-poster.jpg"
            >
              <source
                src="/assets/film/backboard-studio.mp4"
                type="video/mp4"
              />
            </video>
            <iframe
              ref={frame}
              hidden={mode === "film"}
              src="/laptop-demo.html"
              title="Interactive Kevin IDE concept preview"
              onLoad={sendMode}
            />
          </div>
        </div>
      </div>
      <div className="demo-caption">
        <p>{descriptions[mode]}</p>
        <span>LIVE DEMO ↗</span>
      </div>
    </div>
  );
}
