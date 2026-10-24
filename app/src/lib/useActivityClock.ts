import { useEffect, useState } from 'react';

/** Re-evaluate expired work indicators once, without polling or keeping idle lists awake. */
export function useActivityClock(typing: Record<string, Record<string, number>>): number {
  const [, tick] = useState(0);
  const now = Date.now();
  const expires = Math.min(...Object.values(typing).flatMap((entries) => Object.values(entries)).filter((at) => at > now));
  useEffect(() => {
    if (!Number.isFinite(expires)) return;
    const timer = setTimeout(() => tick((n) => n + 1), Math.max(0, expires - Date.now()) + 25);
    return () => clearTimeout(timer);
  }, [expires]);
  return now;
}
