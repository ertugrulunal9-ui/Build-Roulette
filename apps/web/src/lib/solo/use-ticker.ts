'use client';

import { useEffect, useState } from 'react';

/** Re-renders every `intervalMs` while `active`; returns the tick count. */
export function useTicker(intervalMs: number, active = true): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => {
      setTick((t) => t + 1);
    }, intervalMs);
    return () => {
      clearInterval(id);
    };
  }, [intervalMs, active]);
  return tick;
}
