import { writeTrafficPoint } from './influx.js';

/**
 * Optional: poll a real HTTP URL and record one point per request (count=1 on success).
 */
export function startRealApiPoller(url, intervalMs) {
  if (!url || typeof url !== 'string' || !url.startsWith('http')) {
    return () => {};
  }

  const tick = async () => {
    let path = '/';
    try {
      const u = new URL(url);
      path = u.pathname || '/';
    } catch {
      return;
    }
    try {
      const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(8000) });
      writeTrafficPoint(path, res.ok ? 1 : 0, 'real');
    } catch {
      writeTrafficPoint(path, 0, 'real');
    }
  };

  tick();
  const id = setInterval(tick, Math.max(Number(intervalMs) || 10000, 2000));
  return () => clearInterval(id);
}
