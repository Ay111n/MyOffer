"use client";

import { useEffect } from "react";

type ComparisonSection = "offers" | "preferences";
const SCROLL_EVENT = "myoffer:comparison-section";

export function requestComparisonScroll(section: ComparisonSection) {
  window.dispatchEvent(new CustomEvent(SCROLL_EVENT, { detail: section }));
}

/** 数据加载后才会出现锚点；同一锚点的重复点击也需要重新定位。 */
export function useComparisonScroll(ready: boolean) {
  useEffect(() => {
    if (!ready) return;
    let frame = 0;
    const scroll = (section: ComparisonSection) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (section === "offers") {
          window.scrollTo({ top: 0, behavior: "instant" });
        } else {
          document.getElementById("preferences")?.scrollIntoView({ block: "start", behavior: "instant" });
        }
      });
    };
    const fromHash = () => {
      if (window.location.hash === "#offers") scroll("offers");
      if (window.location.hash === "#preferences") scroll("preferences");
    };
    const fromNavigation = (event: Event) => {
      const section: unknown = (event as CustomEvent).detail;
      if (section === "offers" || section === "preferences") scroll(section);
    };
    window.addEventListener("hashchange", fromHash);
    window.addEventListener(SCROLL_EVENT, fromNavigation);
    fromHash();
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("hashchange", fromHash);
      window.removeEventListener(SCROLL_EVENT, fromNavigation);
    };
  }, [ready]);
}
