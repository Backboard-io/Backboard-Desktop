"use client";

import { useEffect, useRef, useState } from "react";
import { models } from "@/data/models";

export function ModelSlider() {
  const region = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [paused, setPaused] = useState(false);
  const [visible, setVisible] = useState(false);
  const [pageVisible, setPageVisible] = useState(true);

  useEffect(() => {
    const element = region.current;
    const modelList = list.current;
    if (!element || !modelList) return;
    const resize = new ResizeObserver(() => {
      // Both copies have equal widths; one complete set travels at 44px/second.
      track.current?.style.setProperty(
        "--flow-duration",
        `${modelList.getBoundingClientRect().width / 44}s`,
      );
    });
    const intersection = new IntersectionObserver(([entry]) =>
      setVisible(entry.isIntersecting),
    );
    const visibility = () => setPageVisible(!document.hidden);
    resize.observe(modelList);
    intersection.observe(element);
    document.addEventListener("visibilitychange", visibility);
    visibility();
    return () => {
      resize.disconnect();
      intersection.disconnect();
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);

  return (
    <div
      id="models"
      className="model-flow"
      ref={region}
      role="region"
      aria-label="60 providers and model families"
    >
      <button
        className="flow-toggle"
        type="button"
        onClick={() => setPaused((value) => !value)}
        aria-label={paused ? "Play model flow" : "Pause model flow"}
      >
        {paused ? "Play" : "Pause"}
      </button>
      <div
        className="model-flow-viewport"
        tabIndex={0}
        aria-label="Model providers. Hover or focus to pause; scroll to browse when reduced motion is enabled."
      >
        <div
          className="model-flow-track"
          ref={track}
          style={{
            animationPlayState:
              paused || !visible || !pageVisible ? "paused" : "running",
          }}
        >
          {[0, 1].map((copy) => (
            <ul
              className="model-flow-list"
              ref={copy === 0 ? list : undefined}
              key={copy}
              aria-hidden={copy === 1 ? true : undefined}
            >
              {models.map((model) => (
                <li className="model-flow-item" key={model.name}>
                  <img src={model.icon} width="34" height="34" alt="" />
                  <span>{model.name}</span>
                </li>
              ))}
            </ul>
          ))}
        </div>
      </div>
      <p className="visually-hidden">
        Model availability depends on your connected provider.
      </p>
    </div>
  );
}
