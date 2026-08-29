import { useEffect, useState } from "react";

export type ViewportMode = "mobile" | "tablet" | "desktop";

function getViewportMode(): ViewportMode {
  if (typeof window === "undefined") return "desktop";
  if (window.matchMedia("(max-width: 768px)").matches) return "mobile";
  if (window.matchMedia("(min-width: 769px) and (max-width: 1024px)").matches) return "tablet";
  return "desktop";
}

export function useViewportMode(): ViewportMode {
  const [mode, setMode] = useState<ViewportMode>(() => getViewportMode());
  useEffect(() => {
    const onResize = () => setMode(getViewportMode());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return mode;
}
