import type { Catalog } from "./types";

export class CatalogSourceError extends Error {
  constructor() { super("暂时无法更新，请稍后重试。"); this.name = "CatalogSourceError"; }
}

type Options = {
  request: (sync: boolean) => Promise<Catalog>;
  onData: (catalog: Catalog) => void;
  onSettled: (error?: Error) => void;
  onPendingChange?: (pending: boolean) => void;
};

// Foreground recovery can overlap the initial read. Only the latest read may
// publish data or an error; local edits also supersede every preceding read.
export function createCatalogReader(options: Options) {
  let generation = 0, paused = false, pending = false;
  const setPending = (value: boolean) => {
    if (pending === value) return;
    pending = value; options.onPendingChange?.(value);
  };
  const invalidate = () => { generation++; setPending(false); };
  return {
    async read(sync = false) {
      if (paused) return;
      const current = ++generation;
      const valid = () => !paused && current === generation;
      setPending(true);
      try {
        const catalog = await options.request(sync);
        if (!valid()) return;
        options.onData(catalog);
        // A cached catalog can arrive with HTTP 200 even though the source
        // failed. Keep its rows, but do not announce a successful refresh.
        if (catalog.sourceError) throw new CatalogSourceError();
        options.onSettled();
        return catalog;
      } catch (error) {
        if (!valid()) return;
        const failure = error instanceof Error ? error : new Error("读取任务失败");
        options.onSettled(failure);
        throw failure;
      } finally {
        if (valid()) setPending(false);
      }
    },
    invalidate,
    pause() { paused = true; invalidate(); },
    resume() { paused = false; },
  };
}
