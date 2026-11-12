import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type RefCallback } from "react";
import { currentMachineId } from "./machineScope.ts";
import { imageReadCache, type ImageReadLease, type ImageReadProof } from "./imageReadCache.ts";

const useCacheVersion = () => useSyncExternalStore(imageReadCache.subscribe, imageReadCache.version, () => 0);
export function useImageReadProof(proof: ImageReadProof) {
  const version = useCacheVersion(), machine = proof.machine ?? currentMachineId();
  useEffect(() => {
    try { imageReadCache.register({ ...proof, machine }); } catch { /* Auth/source and invalid capability remain fail-closed. */ }
  }, [proof.src, proof.sha256, proof.mime, proof.size, proof.variant, machine, version]);
}

// An image gets a Blob URL only after the sole controlled fetch has validated
// its bytes. Registration, gallery identity and retry still use the API URI.
export function useImageReadUrl(proof: ImageReadProof, { lazy = false }: { lazy?: boolean } = {}) {
  const machine = proof.machine ?? currentMachineId(), version = useCacheVersion();
  const supplied = useMemo(() => ({ src: proof.src, machine, sha256: proof.sha256, mime: proof.mime, size: proof.size, variant: proof.variant }),
    [proof.src, machine, proof.sha256, proof.mime, proof.size, proof.variant]);
  const sourceKey = JSON.stringify([supplied.src, machine, supplied.sha256, supplied.mime, supplied.size, supplied.variant]);
  const [element, setElement] = useState<HTMLElement | null>(null), [proximity, setProximity] = useState({ key: sourceKey, visible: !lazy });
  const nearby = !lazy || proximity.key === sourceKey && proximity.visible;
  const [attempt, setAttempt] = useState({ key: sourceKey, number: 0 });
  const number = attempt.key === sourceKey ? attempt.number : 0, key = `${sourceKey}:${version}:${number}`;
  const [state, setState] = useState<{ key: string; url?: string; error?: unknown; phase: "loading" | "ready" | "failed" }>({ key: "", phase: "loading" });
  const ref: RefCallback<HTMLElement> = useCallback(node => { setElement(node); }, []);
  useEffect(() => {
    if (!lazy) return;
    setProximity({ key: sourceKey, visible: false });
    if (!element) return;
    if (typeof IntersectionObserver === "undefined") { setProximity({ key: sourceKey, visible: true }); return; }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setProximity({ key: sourceKey, visible: true }); observer.disconnect(); }
    }, { rootMargin: "240px" });
    observer.observe(element); return () => observer.disconnect();
  }, [lazy, element, sourceKey]);
  useEffect(() => {
    if (!nearby || !supplied.src) return;
    const controller = new AbortController(); let lease: ImageReadLease | undefined;
    setState({ key, phase: "loading" });
    void (async () => {
      try {
        imageReadCache.register(supplied);
        if (number) await imageReadCache.invalidateSource(supplied);
        controller.signal.throwIfAborted();
        const loaded = await imageReadCache.acquire(supplied, { signal: controller.signal, force: number > 0 });
        if (controller.signal.aborted) { loaded.release(); return; }
        lease = loaded; setState({ key, phase: "ready", url: loaded.url });
      } catch (error) { if (!controller.signal.aborted) setState({ key, phase: "failed", error }); }
    })();
    return () => { controller.abort(); lease?.release(); };
  }, [key, nearby, supplied, number]);
  const retry = useCallback(() => setAttempt(previous => ({ key: sourceKey, number: previous.key === sourceKey ? previous.number + 1 : 1 })), [sourceKey]);
  return { ref, retry, requestKey: key, url: nearby && state.key === key ? state.url : undefined,
    phase: nearby && state.key === key ? state.phase : "loading" as const, error: state.key === key ? state.error : undefined };
}
