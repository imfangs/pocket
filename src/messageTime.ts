const minute = 60_000, hour = 60 * minute, day = 24 * hour;
const fullDate = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZoneName: "short",
});
const withinYear = new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
const acrossYears = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });

export function validMessageTimestamp(value: unknown): value is number {
  return typeof value === "number" && value !== 0 && Number.isFinite(new Date(value).getTime());
}

export function messageTime(timestamp: unknown, now: number) {
  if (!validMessageTimestamp(timestamp)) return null;
  const date = new Date(timestamp), age = now - timestamp;
  let label: string;
  if (age >= 0 && age < minute) label = "刚刚";
  else if (age >= minute && age < hour) label = `${Math.floor(age / minute)}分钟前`;
  else if (age >= hour && age < day) label = `${Math.floor(age / hour)}小时前`;
  else if (age >= day && age < 7 * day) label = `${Math.floor(age / day)}天前`;
  // A future or invalid device clock cannot turn an actual timestamp into "now".
  else label = (date.getFullYear() === new Date(now).getFullYear() ? withinYear : acrossYears).format(date);
  return { label, dateTime: date.toISOString(), absolute: fullDate.format(date) };
}

export function progressMessageTime(timestamp: unknown, now: number) {
  if (validMessageTimestamp(timestamp) && now - timestamp >= hour) return null;
  return messageTime(timestamp, now);
}

type MessageClockEnvironment = {
  now: () => number;
  document: Pick<Document, "hidden" | "addEventListener" | "removeEventListener">;
  setInterval: (callback: () => void, delay: number) => number;
  clearInterval: (id: number) => void;
};

// A page owns one minute timer regardless of how many message footers it shows.
// Only the time components subscribe, so ticks cannot rerender a message body.
export function createMessageClock(environment?: MessageClockEnvironment) {
  const env = environment ?? (typeof window === "undefined" ? undefined : {
    now: () => Date.now(), document: window.document,
    setInterval: (callback: () => void, delay: number) => window.setInterval(callback, delay),
    clearInterval: (id: number) => window.clearInterval(id),
  });
  let value = env?.now() ?? Date.now(), timer: number | null = null;
  const listeners = new Set<() => void>();
  const update = () => {
    if (!env || env.document.hidden) return;
    const next = env.now();
    if (next === value) return;
    value = next;
    for (const listener of listeners) listener();
  };
  const stop = () => { if (timer !== null) { env?.clearInterval(timer); timer = null; } };
  const visible = () => {
    stop();
    if (!env || env.document.hidden || !listeners.size) return;
    update();
    if (listeners.size) timer = env.setInterval(update, minute);
  };
  return {
    getSnapshot: () => value,
    subscribe(listener: () => void) {
      const notify = () => listener();
      listeners.add(notify);
      if (listeners.size === 1) {
        env?.document.addEventListener("visibilitychange", visible);
        visible();
      }
      return () => {
        listeners.delete(notify);
        if (listeners.size) return;
        stop();
        env?.document.removeEventListener("visibilitychange", visible);
      };
    },
  };
}

export const messageClock = createMessageClock();
