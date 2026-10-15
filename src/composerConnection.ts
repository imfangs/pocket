type Options = {
  available: () => boolean;
  connect: () => Promise<unknown>;
};

// A reading view never opens a desktop conversation. Only an input gesture may
// spend this view's one automatic attempt; failure does not retry on every key.
export function createComposerConnectionIntent(options: Options) {
  let attempted = false, disposed = false;
  let pending: Promise<void> | null = null;
  const request = (retry = false): Promise<void> => {
    if (disposed || !options.available() || attempted && !retry) return pending ?? Promise.resolve();
    if (pending) return pending;
    const operation = Promise.resolve().then(async () => {
      if (!disposed && options.available()) { attempted = true; await options.connect(); }
    }).finally(() => { if (pending === operation) pending = null; });
    pending = operation;
    return operation;
  };
  return { request, dispose() { disposed = true; } };
}

// Programmatic focus (including autofocus/restoration) is trusted by browsers,
// so focus alone is insufficient. A pointer on this input, a Tab arriving here,
// or native input/paste/composition identifies the user's intention instead.
export function bindComposerConnectionIntent(form: HTMLFormElement, request: () => void) {
  const input = form.querySelector<HTMLTextAreaElement>("textarea");
  const document = form.ownerDocument;
  if (!input) return () => {};
  let tabPending = false;
  const key = (event: KeyboardEvent) => { tabPending = event.isTrusted && event.key === "Tab"; };
  const focus = (event: FocusEvent) => {
    if (event.target === input && tabPending) request();
    tabPending = false;
  };
  const pointer = (event: PointerEvent) => {
    tabPending = false;
    if (event.isTrusted && event.button === 0) request();
  };
  const edit = (event: Event) => { if (event.isTrusted) request(); };
  const blur = () => { tabPending = false; };
  document.addEventListener("keydown", key, true);
  document.addEventListener("focusin", focus, true);
  document.defaultView?.addEventListener("blur", blur);
  input.addEventListener("pointerdown", pointer);
  input.addEventListener("click", edit);
  input.addEventListener("input", edit);
  input.addEventListener("paste", edit);
  input.addEventListener("compositionstart", edit);
  return () => {
    document.removeEventListener("keydown", key, true);
    document.removeEventListener("focusin", focus, true);
    document.defaultView?.removeEventListener("blur", blur);
    input.removeEventListener("pointerdown", pointer);
    input.removeEventListener("click", edit);
    input.removeEventListener("input", edit);
    input.removeEventListener("paste", edit);
    input.removeEventListener("compositionstart", edit);
  };
}
