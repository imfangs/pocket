export type ShakePermission = "granted" | "denied" | "unsupported";
type MotionPermissionWindow = Window & {
  DeviceMotionEvent?: typeof DeviceMotionEvent & { requestPermission?: () => Promise<string> };
};

/** Call directly from the user's enable button. This never runs on mount. */
export async function requestShakePermission(browser: Window = window): Promise<ShakePermission> {
  const target = browser as MotionPermissionWindow;
  if (target.isSecureContext === false || !target.DeviceMotionEvent) return "unsupported";
  try {
    return typeof target.DeviceMotionEvent.requestPermission === "function"
      ? await target.DeviceMotionEvent.requestPermission() === "granted" ? "granted" : "denied"
      : "granted";
  } catch { return "denied"; }
}

type Vector = { x: number; y: number; z: number };
function vector(value: DeviceMotionEventAcceleration | null): Vector | null {
  if (!value || ![value.x, value.y, value.z].every(n => typeof n === "number" && Number.isFinite(n) && Math.abs(n) < 1000)) return null;
  return { x: value.x!, y: value.y!, z: value.z! };
}

export function bindShakeFeedback(options: {
  permission: ShakePermission;
  onShake: () => void | Promise<void>;
  enabled: () => boolean;
  browser?: Window;
  document?: Document;
  now?: () => number;
  threshold?: number;
  cooldownMs?: number;
}) {
  const browser = options.browser ?? window, document = options.document ?? browser.document;
  if (options.permission !== "granted") return () => {};
  const now = options.now ?? (() => browser.performance.now());
  const threshold = options.threshold ?? 18, cooldown = options.cooldownMs ?? 5000;
  let disposed = false, peaks = 0, firstPeak = 0, lastPeak = -Infinity, lastFire = -Infinity;
  let lastVector: Vector | null = null, lastSample = -Infinity, above = false, lastDirection = "";
  const reset = () => { peaks = 0; firstPeak = 0; lastPeak = -Infinity; lastVector = null; lastSample = -Infinity; above = false; lastDirection = ""; };
  const motion = (event: DeviceMotionEvent) => {
    if (disposed || event.isTrusted === false || document.visibilityState !== "visible" || !options.enabled()) { reset(); return; }
    const time = now();
    if (!Number.isFinite(time) || time - lastFire < cooldown) { reset(); return; }
    let acceleration = vector(event.acceleration);
    if (!acceleration) {
      const raw = vector(event.accelerationIncludingGravity);
      if (!raw) { reset(); return; }
      const previous = lastVector;
      lastVector = raw;
      const stale = time - lastSample > 300; lastSample = time;
      if (!previous || stale) return;
      acceleration = { x: raw.x - previous.x, y: raw.y - previous.y, z: raw.z - previous.z };
    }
    const values = Object.entries(acceleration) as [keyof Vector, number][];
    const [axis, dominant] = values.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))[0];
    const magnitude = Math.hypot(acceleration.x, acceleration.y, acceleration.z);
    if (magnitude < threshold * .45) { above = false; return; }
    if (magnitude < threshold) return;
    const direction = axis + (dominant < 0 ? "-" : "+");
    if (above && direction === lastDirection || time - lastPeak < 100) return;
    if (!peaks || time - firstPeak > 900 || time < lastPeak) { peaks = 0; firstPeak = time; }
    above = true; lastDirection = direction; lastPeak = time; peaks++;
    if (peaks < 3) return;
    lastFire = time; reset();
    try { void Promise.resolve(options.onShake()).catch(() => {}); } catch { /* The click entry remains available. */ }
  };
  browser.addEventListener("devicemotion", motion, { passive: true });
  document.addEventListener("visibilitychange", reset);
  browser.addEventListener("pagehide", reset);
  browser.addEventListener("blur", reset);
  return () => {
    disposed = true; reset();
    browser.removeEventListener("devicemotion", motion);
    document.removeEventListener("visibilitychange", reset);
    browser.removeEventListener("pagehide", reset);
    browser.removeEventListener("blur", reset);
  };
}
