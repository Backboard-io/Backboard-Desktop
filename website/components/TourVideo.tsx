"use client";

import { useEffect, useRef } from "react";
import "./tour-video.css";

// The Nash product tour. It just plays: muted and looping while on screen
// (browsers only allow muted autoplay), with native controls to turn sound on.
export function TourVideo({
  src = "/assets/nash/nash-tour.mp4",
  poster = "/assets/nash/nash-tour-poster.jpg",
  label = "Nash product tour",
  className = "",
}: {
  src?: string;
  poster?: string;
  label?: string;
  className?: string;
}) {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const v = ref.current;
    if (!v || window.matchMedia("(prefers-reduced-motion: reduce)").matches)
      return;
    const io = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting) v.play().catch(() => {});
        else v.pause();
      },
      { threshold: 0.3 },
    );
    io.observe(v);
    return () => io.disconnect();
  }, []);

  return (
    <figure className={`tv ${className}`}>
      <video
        ref={ref}
        src={src}
        poster={poster}
        muted
        loop
        playsInline
        controls
        preload="auto"
        aria-label={label}
      />
    </figure>
  );
}
