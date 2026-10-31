import { useCallback, useLayoutEffect, useRef, useState } from "react";
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
