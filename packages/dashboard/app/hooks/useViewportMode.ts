import { useState, useEffect } from "react";

export type ViewportMode = "mobile" | "tablet" | "desktop";

export function getViewportMode(): ViewportMode {
  if (typeof window === "undefined") return "desktop";
  if (window.matchMedia("(max-width: 768px)").matches) return "mobile";
  if (window.matchMedia("(min-width: 769px) and (max-width: 1024px)").matches) return "tablet";
  return "desktop";
}

export function useViewportMode(): ViewportMode {
  const [mode, setMode] = useState<ViewportMode>(getViewportMode);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const mobileQuery = window.matchMedia("(max-width: 768px)");
    const tabletQuery = window.matchMedia("(min-width: 769px) and (max-width: 1024px)");

    const updateMode = () => {
      if (mobileQuery.matches) {
        setMode("mobile");
      } else if (tabletQuery.matches) {
        setMode("tablet");
      } else {
        setMode("desktop");
      }
    };

    mobileQuery.addEventListener("change", updateMode);
    tabletQuery.addEventListener("change", updateMode);
    return () => {
      mobileQuery.removeEventListener("change", updateMode);
      tabletQuery.removeEventListener("change", updateMode);
    };
  }, []);

  return mode;
}
