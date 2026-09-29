"use client";

import { useEffect } from "react";

// Scroll effects: --sy for parallax, .is-in reveals and ink that draws itself,
// and the current-product highlight in the nav.
export function ScrollFx() {
  useEffect(() => {
    const root = document.documentElement;
    const reveal = document.querySelectorAll<HTMLElement>("[data-slap], [data-slap-ink]");
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      reveal.forEach((el) => el.classList.add("is-in"));
      return;
    }
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => root.style.setProperty("--sy", String(window.scrollY)));
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    const io = new IntersectionObserver(
      (entries) =>
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add("is-in");
            io.unobserve(e.target);
          }
        }),
      { threshold: 0.25 },
    );
    reveal.forEach((el) => io.observe(el));

    // Highlight the product the reader is currently in.
    const links = new Map<string, HTMLAnchorElement>();
    document.querySelectorAll<HTMLAnchorElement>(".bb-nav nav a").forEach((a) => links.set(a.hash.slice(1), a));
    const spy = new IntersectionObserver(
      (entries) =>
        entries.forEach((e) => {
          const link = links.get(e.target.id);
          if (!link) return;
          if (e.isIntersecting) link.setAttribute("aria-current", "true");
          else link.removeAttribute("aria-current");
        }),
      { rootMargin: "-45% 0px -50% 0px" },
    );
    links.forEach((_, id) => {
      const el = document.getElementById(id);
      if (el) spy.observe(el);
    });
    return () => {
      spy.disconnect();
      window.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(raf);
      io.disconnect();
    };
  }, []);
  return null;
}
