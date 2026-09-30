import type { Catalog } from "./types";

type Options = {
  request: (sync: boolean) => Promise<Catalog>;
  onData: (catalog: Catalog) => void;
  onSettled: (error?: Error) => void;
};

// Foreground recovery can overlap the initial read. Only the latest read may
// publish data or an error; local edits also supersede every preceding read.
export function createCatalogReader(options: Options) {
  let generation = 0, paused = false;
  return {
    async read(sync = false) {
      if (paused) return;
      const current = ++generation;
      const valid = () => !paused && current === generation;
      try {
        const catalog = await options.request(sync);
        if (!valid()) return;
        options.onData(catalog);
        options.onSettled();
        return catalog;
      } catch (error) {
        if (!valid()) return;
        const failure = error instanceof Error ? error : new Error("读取任务失败");
        options.onSettled(failure);
        throw failure;
      }
    },
    invalidate() { generation++; },
    pause() { paused = true; generation++; },
    resume() { paused = false; },
  };
}
