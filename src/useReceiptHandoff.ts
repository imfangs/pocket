import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { animateReceiptHandoff, reconcileHandoffRows, type HandoffRow } from "./receiptMotion";

export const NO_HANDOFF_IDS: ReadonlySet<string> = new Set();

export function useHandoffRows<T>(items: readonly T[], key: (item: T) => string, exitIds: ReadonlySet<string> = NO_HANDOFF_IDS, explicitIds: ReadonlySet<string> = NO_HANDOFF_IDS) {
  const [state, setState] = useState(() => ({ items, exitIds, rows: items.map(item => ({ id: key(item), item, leaving: false })) as HandoffRow<T>[] }));
  let rows = state.rows;
  if (state.items !== items || state.exitIds !== exitIds) {
    rows = reconcileHandoffRows(state.rows, items, key, exitIds);
    setState({ items, exitIds, rows });
  }
  const nodes = useRef(new Map<string, HTMLElement>()), motions = useRef(new Map<string, () => void>());
  const bind = useCallback((id: string, element: HTMLElement | null) => {
    if (element) nodes.current.set(id, element); else nodes.current.delete(id);
  }, []);
  useLayoutEffect(() => {
    const leaving = new Set(rows.filter(row => row.leaving).map(row => row.id));
    for (const [id, cancel] of motions.current) if (!leaving.has(id)) { cancel(); motions.current.delete(id); }
    for (const row of rows) {
      const node = nodes.current.get(row.id);
      if (!row.leaving || !node || motions.current.has(row.id)) continue;
      motions.current.set(row.id, animateReceiptHandoff(node, "exit", () => {
        setState(current => ({ ...current, rows: current.rows.filter(item => item.id !== row.id || !item.leaving) }));
      }, explicitIds.has(row.id)));
    }
  }, [rows, explicitIds]);
  useLayoutEffect(() => () => { for (const cancel of motions.current.values()) cancel(); motions.current.clear(); }, []);
  return { rows, bind };
}

// Only a source card visible in this mounted view can introduce a target. Old
// history and every later feed snapshot remain still.
export function useReceiptEntrances(root: RefObject<HTMLElement | null>, submissionIds: readonly string[], queueIds: readonly string[], messageIds: ReadonlyMap<string, string>) {
  const previous = useRef<{ submissions: Set<string>; queue: Set<string> } | null>(null);
  const seen = useRef(new Set<string>()), motions = useRef(new Map<() => void, { finished: boolean }>());
  useLayoutEffect(() => {
    for (const [cancel, state] of motions.current) if (state.finished) { cancel(); motions.current.delete(cancel); }
    const before = previous.current;
    previous.current = { submissions: new Set(submissionIds), queue: new Set(queueIds) };
    if (!before || !root.current) return;
    const incoming: HTMLElement[] = [];
    for (const [requestId, messageId] of messageIds) {
      if (seen.current.has(`message:${requestId}`) || !before.submissions.has(requestId) && !before.queue.has(requestId)) continue;
      const target = [...root.current.querySelectorAll<HTMLElement>("[data-message-id]")].find(node => node.dataset.messageId === messageId);
      if (target) { seen.current.add(`message:${requestId}`); incoming.push(target); }
    }
    for (const id of queueIds) {
      if (seen.current.has(`queue:${id}`) || !before.submissions.has(id) || before.queue.has(id)) continue;
      const target = [...root.current.querySelectorAll<HTMLElement>("[data-outbox-id]")].find(node => node.dataset.outboxId === id);
      if (target) { seen.current.add(`queue:${id}`); incoming.push(target); }
    }
    for (const target of incoming) {
      const bounds = target.getBoundingClientRect(), browser = target.ownerDocument.defaultView;
      if (bounds.height <= 0 || bounds.bottom <= 0 || bounds.top >= (browser?.innerHeight ?? 0)) continue;
      const state = { finished: false };
      const cancel = animateReceiptHandoff(target, "enter", () => { state.finished = true; });
      if (!state.finished) motions.current.set(cancel, state);
    }
  }, [root, submissionIds, queueIds, messageIds]);
  useLayoutEffect(() => () => { for (const cancel of motions.current.keys()) cancel(); motions.current.clear(); }, []);
}
