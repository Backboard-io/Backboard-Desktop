"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const modes = ["film", "simple", "editor", "advanced"] as const;
type Mode = (typeof modes)[number];

export function WorkspaceDemo() {
  const [mode, setMode] = useState<Mode>("simple");
  const [expanded, setExpanded] = useState(false);
  const windowRef = useRef<HTMLDivElement>(null);
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

  useEffect(() => {
    const update = () =>
      setExpanded(document.fullscreenElement === windowRef.current);
    document.addEventListener("fullscreenchange", update);
    return () => document.removeEventListener("fullscreenchange", update);
  }, []);

  async function toggleExpanded() {
    if (document.fullscreenElement === windowRef.current)
      await document.exitFullscreen();
    else await windowRef.current?.requestFullscreen();
  }

  return (
    <div className="workspace-demo" id="workspace">
      <div className="workspace-window" ref={windowRef} data-mode={mode}>
        <div className="workspace-screen" ref={screen}>
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
            <source src="/assets/film/backboard-studio.mp4" type="video/mp4" />
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
      <div className="workspace-controls">
        <div
          className="workspace-modes"
          role="group"
          aria-label="Workspace mode"
        >
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
        <button
          className="workspace-expand"
          type="button"
          aria-label={expanded ? "Exit expanded workspace" : "Expand workspace"}
          onClick={() => void toggleExpanded().catch(() => {})}
        >
          <svg
            viewBox="0 0 20 20"
            width="17"
            height="17"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            aria-hidden="true"
          >
            <path d="M7 3H3v4m10-4h4v4M3 13v4h4m10-4v4h-4" />
          </svg>
        </button>
      </div>
    </div>
  );
}
