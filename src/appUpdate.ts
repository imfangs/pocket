export type AppVersion = { id: string; assets: string[] };
type Result = { status: "updated" | "current" | "blocked" | "unavailable"; reason?: string };
type Options = {
  currentId: string;
  request: typeof fetch;
  blocker: () => string | null;
  onAvailable: (version: AppVersion | null) => void;
  reload: () => void;
  entryUrl?: () => string;
};
const assetPath = /^\/assets\/[A-Za-z0-9_.-]+\.(?:js|css)$/;
export function parseAppVersion(value: unknown): AppVersion | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<AppVersion>;
  if (typeof candidate.id !== "string" || !/^[a-f0-9]{64}$/.test(candidate.id) || !Array.isArray(candidate.assets) ||
      !candidate.assets.length || candidate.assets.length > 32 ||
      candidate.assets.some(path => typeof path !== "string" || !assetPath.test(path)) ||
      new Set(candidate.assets).size !== candidate.assets.length) return null;
  return { id: candidate.id, assets: candidate.assets };
}

export function htmlBuildId(html: string) {
  const tags = html.replace(/<!--[\s\S]*?-->/g, "").match(/<meta\b[^>]*>/gi) || [];
  for (const tag of tags) {
    if (!/\bname\s*=\s*["']pocket-build["']/i.test(tag)) continue;
    return /\bcontent\s*=\s*["']([a-f0-9]{64})["']/i.exec(tag)?.[1] || null;
  }
  return null;
}

export function createAppUpdate(options: Options) {
  let checking: Promise<void> | null = null, applying = false, stopped = false;
  const manifest = async () => {
    const response = await options.request("/pocket-version.json", { cache: "no-store", signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error("version unavailable");
    const version = parseAppVersion(await response.json());
    if (!version) throw new Error("invalid version");
    return version;
  };
  const publish = (version: AppVersion) => { if (!stopped) options.onAvailable(version.id === options.currentId ? null : version); };
  return {
    check() {
      if (stopped || applying || !/^[a-f0-9]{64}$/.test(options.currentId)) return Promise.resolve();
      if (!checking) checking = manifest().then(publish).catch(() => {}).finally(() => { checking = null; });
      return checking;
    },
    async apply(): Promise<Result> {
      if (stopped || applying) return { status: "unavailable" };
      const blocked = options.blocker();
      if (blocked) return { status: "blocked", reason: blocked };
      applying = true;
      try {
        const version = await manifest();
        publish(version);
        if (version.id === options.currentId) return { status: "current" };
        // Pages may briefly serve its HTML fallback for a new chunk during a
        // deployment. Do not reload until every JS/CSS asset is actually ready.
        await Promise.all(version.assets.map(async path => {
          const response = await options.request(path, { method: "HEAD", cache: "no-store", signal: AbortSignal.timeout(10000) });
          const type = response.headers.get("content-type") || "";
          if (!response.ok || (path.endsWith(".css") ? !type.includes("text/css") : !/(?:javascript|ecmascript)/i.test(type))) throw new Error("assets unavailable");
        }));
        const entry = await options.request(options.entryUrl?.() || "/", { cache: "no-store", signal: AbortSignal.timeout(10000) });
        if (!entry.ok || htmlBuildId(await entry.text()) !== version.id) throw new Error("entry unavailable");
        const latest = await manifest();
        publish(latest);
        if (latest.id !== version.id || JSON.stringify(latest.assets) !== JSON.stringify(version.assets)) throw new Error("deployment changed");
        if (stopped) return { status: "unavailable" };
        // The user can type or start an operation during the network checks.
        const reason = options.blocker();
        if (reason) return { status: "blocked", reason };
        options.reload();
        return { status: "updated" };
      } catch {
        return { status: "unavailable", reason: "新版暂未准备好，稍后再试。" };
      } finally { applying = false; }
    },
    stop() { stopped = true; },
    resume() { stopped = false; },
  };
}
