type BootScreen = Pick<HTMLElement, "hidden">;
type BootScreenEnvironment = {
  screen: () => BootScreen | null;
  requestFrame: (callback: () => void) => number;
  cancelFrame: (frame: number) => void;
};

// Each loading stage holds the same pre-JavaScript screen. A stage handoff
// cancels the pending hide, preserving image nodes, animation phase and retry time.
export function createBootScreenController(environment: BootScreenEnvironment) {
  const holders = new Set<symbol>();
  let pendingHide: number | null = null;
  return {
    hold() {
      const holder = Symbol();
      holders.add(holder);
      if (pendingHide !== null) environment.cancelFrame(pendingHide);
      pendingHide = null;
      const screen = environment.screen();
      if (screen) screen.hidden = false;
      return () => {
        if (!holders.delete(holder) || holders.size || pendingHide !== null) return;
        pendingHide = environment.requestFrame(() => {
          pendingHide = null;
          if (holders.size) return;
          const screen = environment.screen();
          if (screen) screen.hidden = true;
        });
      };
    },
  };
}

let controller: ReturnType<typeof createBootScreenController> | undefined;
export function holdBootScreen() {
  controller ??= createBootScreenController({
    screen: () => document.getElementById("pocket-boot"),
    requestFrame: callback => window.requestAnimationFrame(callback),
    cancelFrame: frame => window.cancelAnimationFrame(frame),
  });
  return controller.hold();
}
