type AccessCheckOptions = {
  request: () => Promise<boolean>;
  onResult: (authenticated: boolean) => void;
  onFailure: () => void;
};

// Status reads may finish out of order across foreground/network events.
// Login, logout and expiry supersede every earlier observation.
export function createAccessCheck(options: AccessCheckOptions) {
  let generation = 0, paused = false;
  return {
    async check() {
      if (paused) return;
      const current = ++generation;
      try {
        const authenticated = await options.request();
        if (!paused && current === generation) options.onResult(authenticated);
      } catch {
        if (!paused && current === generation) options.onFailure();
      }
    },
    invalidate() { generation++; },
    pause() { paused = true; generation++; },
    resume() { paused = false; },
  };
}
