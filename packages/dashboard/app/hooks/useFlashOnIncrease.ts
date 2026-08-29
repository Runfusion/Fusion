import { useRef, useState, useEffect } from "react";

/**
 * Returns `true` briefly when `count` increases compared to its previous value.
 * Used to trigger a CSS flash animation on the column count badge.
 *
 * - Does NOT flash on initial render (only on subsequent increases).
 * - Does NOT flash when count decreases or stays the same.
 * - Resets after `duration` ms (default 1400ms).
 * - Cleans up timers on unmount.
 */
export function useFlashOnIncrease(count: number, duration = 1400): boolean {
  const prevRef = useRef<number | null>(null);
  const [flashing, setFlashing] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (prevRef.current !== null && count > prevRef.current) {
      setFlashing(true);
      timerRef.current = setTimeout(() => setFlashing(false), duration);
    }
    prevRef.current = count;

    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
      }
    };
  }, [count, duration]);

  return flashing;
}
