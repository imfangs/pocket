import { AppIcon } from "./ui/AppIcon";
import { t as tr, useLocale, formatDate } from "./i18n";
import { IconButton } from "./ui/IconButton";
import {
  Search,
  Pin,
  Star,
  ArrowUpRight,
  Inbox,
  Clock,
  AlarmClockOff,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ActivityFilter, Thread, ThreadSort, View } from "./types";
import { ago } from "./model";
import { lastMessageTime, recentCreationExpiry } from "./threadTime";
import { codexPinned, pocketPriority } from "./priority";
import { emptyListContent, threadListPresentation } from "./listPresentation";
import type { TaskStatus } from "./taskStatuses";
import SwipeTaskRow from "./SwipeTaskRow";
import { bindTaskListMotion } from "./taskListMotion";
import { bindListInteraction, heldListRows } from "./listInteraction";
import { inspectorEntryFromClick, type InspectorEntryOrigin } from "./inspectorFocus";
import type { CreationCue } from "./creationList";
import "./task-list-status.css";
import "./thread-automations.css";
import "./creation-list.css";
interface Props {
  threads: Thread[];
  projectScope?: string;
  selected: string | null;
  view: View;
  activity?: ActivityFilter;
  sort?: ThreadSort;
  unreadAvailable?: boolean;
  unreadPending?: number;
  onSelect: (id: string, animate?: boolean, origin?: InspectorEntryOrigin) => void;
  onOpen: (t: Thread) => void;
  onPriority?: (t: Thread) => Promise<void>;
  onHidden?: (t: Thread) => Promise<void>;
  busy: boolean;
  query: string;
  onClearQuery: () => void;
  onCreate?: () => void;
  onShowAll?: () => void;
  onSearchAll?: () => void;
  onRefresh?: () => void;
  onClearFilters?: () => void;
  hasFilters?: boolean;
  draftIds?: ReadonlySet<string>;
  runtimeStates?: ReadonlyMap<string, TaskStatus>;
  runtimeUnavailable?: boolean;
  runtimeLoading?: boolean;
  creationCues?: ReadonlyMap<string, CreationCue>;
}
export default function TaskList(p: Props) {
  useLocale();
  const [limits, setLimits] = useState(() => new Map<string, number>());
  const [openRowId, setOpenRowId] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<{ id: string; kind: "priority" | "hidden" } | null>(null);
  const pendingId = pendingAction?.id;
  const [actionErrors, setActionErrors] = useState<Record<string, string>>({});
  const acting = useRef<string | null>(null), mounted = useRef(true), list = useRef<HTMLDivElement>(null);
  const focusAfterHidden = useRef<{ scope: string; id?: string } | null>(null);
  const focusAfterEmptyAction = useRef<{ opener: HTMLButtonElement; scope: string | null } | null>(null);
  const motion = useRef<ReturnType<typeof bindTaskListMotion> | null>(null);
  const scope = `${p.view}\0${p.projectScope || ""}\0${p.activity || "all"}\0${p.sort || "smart"}\0${p.query}`;
  const limit = limits.get(scope) ?? 80;
  const [held, setHeld] = useState<{ scope: string; rows: Thread[] } | null>(null);
  const currentRows = new Map(p.threads.map(thread => [thread.id, thread]));
  const rows = held?.scope === scope ? heldListRows(p.threads, held.rows) : p.threads.slice(0, limit);
  const [, refreshCreationClock] = useState(0);
  const now = Date.now();
  const recentExpiries = rows.map(thread => recentCreationExpiry(thread, now)).filter((expiry): expiry is number => expiry !== null);
  const nextCreationExpiry = recentExpiries.length ? Math.min(...recentExpiries) : null;
  useEffect(() => {
    const refresh = () => { if (!document.hidden) refreshCreationClock(value => value + 1); };
    // One deadline for the displayed list, not a timer per row or a rank tick.
    const timer = nextCreationExpiry === null ? undefined : window.setTimeout(refresh, Math.max(0, nextCreationExpiry - Date.now()));
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("pageshow", refresh);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("pageshow", refresh);
    };
  }, [nextCreationExpiry]);
  const latest = useRef({ scope, rows, currentRows });
  latest.current = { scope, rows, currentRows };
  const interaction = useRef<ReturnType<typeof bindListInteraction> | null>(null);
  useLayoutEffect(() => {
    if (!list.current) return;
    const control = bindListInteraction(list.current, {
      scope: () => latest.current.scope,
      current: id => latest.current.currentRows.has(id),
      hold: () => setHeld({ scope: latest.current.scope, rows: latest.current.rows }),
      release: () => setHeld(null),
    });
    interaction.current = control;
    return () => { control.dispose(); interaction.current = null; };
  }, []);
  useLayoutEffect(() => { interaction.current?.scopeChanged(); }, [scope]);
  const anchor = useRef<{ scope: string; id: string; offset: number } | null>(null);
  useLayoutEffect(() => {
    if (!list.current) return;
    const controller = bindTaskListMotion(list.current);
    motion.current = controller;
    return () => { controller.dispose(); motion.current = null; };
  }, []);
  const rememberAnchor = useCallback(() => {
    const root = list.current, panel = root?.closest<HTMLElement>(".list-panel");
    if (!root || !panel?.clientHeight || motion.current?.isMoving()) return;
    if (panel.scrollTop < 1) { anchor.current = null; return; }
    const top = panel.getBoundingClientRect().top;
    const first = [...root.querySelectorAll<HTMLElement>("[data-thread-id]")].find(node => node.getBoundingClientRect().bottom > top);
    anchor.current = first ? { scope, id: first.dataset.threadId!, offset: first.getBoundingClientRect().top - top } : null;
  }, [scope]);
  useEffect(() => {
    const panel = list.current?.closest<HTMLElement>(".list-panel");
    let frame = 0;
    const scroll = () => {
      if (panel && panel.scrollTop < 1) anchor.current = null;
      cancelAnimationFrame(frame); frame = requestAnimationFrame(rememberAnchor);
    };
    panel?.addEventListener("scroll", scroll, { passive: true });
    return () => { panel?.removeEventListener("scroll", scroll); cancelAnimationFrame(frame); };
  }, [rememberAnchor]);
  useLayoutEffect(() => {
    // Remove only our temporary Y transform before measuring layout or restoring
    // the reading anchor. Swipe X and its in-flight touch remain independent.
    motion.current?.prepareLayout();
    const root = list.current, panel = root?.closest<HTMLElement>(".list-panel");
    if (!root || !panel?.clientHeight) { motion.current?.commit(scope); return; }
    const previous = anchor.current;
    // DOM moves may already have clamped scrollTop to zero. Use the saved
    // reader position, not that intermediate post-layout scroll value.
    if (previous?.scope === scope) {
      const target = [...root.querySelectorAll<HTMLElement>("[data-thread-id]")].find(node => node.dataset.threadId === previous.id);
      if (target) panel.scrollTop += target.getBoundingClientRect().top - panel.getBoundingClientRect().top - previous.offset;
    }
    rememberAnchor();
    motion.current?.commit(scope);
  }, [p.threads, p.selected, p.runtimeStates, p.runtimeUnavailable, p.runtimeLoading, p.draftIds, p.creationCues, pendingId, held, scope, limit, rememberAnchor]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setOpenRowId(null); }, [scope]);
  useEffect(() => {
    if (openRowId && !p.threads.some(thread => thread.id === openRowId)) setOpenRowId(null);
  }, [p.threads, openRowId]);
  useEffect(() => {
    if (!openRowId) return;
    const outside = (event: Event) => {
      const target = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-swipe-row-id]") : null;
      if (!target || !list.current?.contains(target) || target.dataset.swipeRowId !== openRowId) setOpenRowId(null);
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", outside);
    return () => { document.removeEventListener("pointerdown", outside, true); document.removeEventListener("focusin", outside); };
  }, [openRowId]);
  const clearActionError = (id: string) => setActionErrors(previous => { const next = { ...previous }; delete next[id]; return next; });
  const changePriority = async (thread: Thread, animate: boolean) => {
    if (!p.onPriority || p.busy || acting.current) return;
    const current = latest.current.currentRows.get(thread.id);
    if (!current) return;
    thread = current;
    motion.current?.beginPriority(thread.id, !pocketPriority(thread), animate);
    acting.current = thread.id; setPendingAction({ id: thread.id, kind: "priority" }); setOpenRowId(thread.id); clearActionError(thread.id);
    try {
      await p.onPriority(thread);
      motion.current?.confirmPriority(thread.id);
      if (mounted.current) setOpenRowId(current => current === thread.id ? null : current);
    } catch (failure) {
      motion.current?.cancelPriority(thread.id);
      if (mounted.current) setActionErrors(previous => ({ ...previous, [thread.id]: failure instanceof Error ? failure.message : "关注状态未保存，请重试。" }));
    } finally {
      acting.current = null;
      if (mounted.current) setPendingAction(null);
    }
  };
  const changeHidden = async (thread: Thread, animate: boolean) => {
    if (!p.onHidden || p.busy || acting.current) return;
    const current = latest.current.currentRows.get(thread.id);
    if (!current) return;
    thread = current;
    const originScope = latest.current.scope;
    const index = latest.current.rows.findIndex(row => row.id === thread.id);
    const nextId = latest.current.rows[index + 1]?.id ?? latest.current.rows[index - 1]?.id;
    acting.current = thread.id; setPendingAction({ id: thread.id, kind: "hidden" });
    setOpenRowId(thread.id); clearActionError(thread.id);
    try {
      await p.onHidden(thread);
      if (mounted.current) {
        setOpenRowId(value => value === thread.id ? null : value);
        if (latest.current.scope === originScope) {
          // This removal is the user's completed action, so it need not wait
          // for the pointer-hold grace period used by background refreshes.
          setHeld(null);
          const active = document.activeElement;
          if (!animate && (!active || active === document.body ||
              active instanceof HTMLElement && active.closest<HTMLElement>("[data-swipe-row-id]")?.dataset.swipeRowId === thread.id))
            focusAfterHidden.current = { scope: originScope, id: nextId };
        }
      }
    } catch (failure) {
      if (mounted.current) setActionErrors(previous => ({ ...previous, [thread.id]: failure instanceof Error ? failure.message : "隐藏状态未保存，请重试。" }));
    } finally {
      acting.current = null;
      if (mounted.current) setPendingAction(null);
    }
  };
  useLayoutEffect(() => {
    const target = focusAfterHidden.current;
    if (!target || pendingId) return;
    focusAfterHidden.current = null;
    if (target.scope !== scope || !list.current) return;
    const buttons = [...list.current.querySelectorAll<HTMLButtonElement>("button.task-select:not(:disabled)")];
    (buttons.find(button => button.dataset.threadId === target.id) ?? buttons[0] ?? list.current).focus({ preventScroll: true });
  }, [p.threads, pendingId, scope]);
  useLayoutEffect(() => {
    const request = focusAfterEmptyAction.current;
    if (!request) return;
    const { opener } = request;
    const root = list.current, active = document.activeElement;
    // Keyboard recovery replaces the empty CTA with results. Keep the next
    // activation in those results, unless another control already owns focus.
    if (!root || root.closest("[inert]") || document.querySelector("dialog[open]") ||
        (request.scope !== null && request.scope !== scope) ||
        (active && active !== document.body && active !== opener && active !== root)) {
      focusAfterEmptyAction.current = null;
      return;
    }
    request.scope = scope;
    const first = root.querySelector<HTMLButtonElement>("button.task-select:not(:disabled)");
    if (first) {
      focusAfterEmptyAction.current = null;
      first.focus({ preventScroll: true });
      return;
    }
    // The recovery's new catalog may arrive after its initial empty render.
    // Retain only this scope's intent, and cancel it on any newer user action.
    const cancel = () => { if (focusAfterEmptyAction.current === request) focusAfterEmptyAction.current = null; };
    const focus = (event: FocusEvent) => {
      if (event.target !== document.body && event.target !== opener && event.target !== root) cancel();
    };
    const visibility = () => { if (document.hidden) cancel(); };
    document.addEventListener("pointerdown", cancel, true);
    document.addEventListener("keydown", cancel, true);
    document.addEventListener("focusin", focus, true);
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("blur", cancel);
    return () => {
      document.removeEventListener("pointerdown", cancel, true);
      document.removeEventListener("keydown", cancel, true);
      document.removeEventListener("focusin", focus, true);
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("blur", cancel);
    };
  });
  const empty = emptyListContent({ view: p.view, activity: p.activity, query: p.query, projectScope: p.projectScope, hasFilters: p.hasFilters, unreadAvailable: p.unreadAvailable, unreadPending: p.unreadPending,
    runtimeAvailable: !p.runtimeLoading && !p.runtimeUnavailable, runtimeLoading: p.runtimeLoading });
  const emptyAction = empty.action === "create" ? p.onCreate : empty.action === "showAll" ? p.onShowAll : empty.action === "searchAll" ? p.onSearchAll
    : empty.action === "refresh" ? p.onRefresh : empty.action === "clearFilters" ? p.onClearFilters : p.onClearQuery;
  return (
    <div
      ref={list}
      className="task-list-surface"
      tabIndex={-1}
      style={{ outline: "none" }}
    >
      {rows.length === 0 ? (
        <div className="empty-list">
          {p.query ? <AppIcon icon={Search} kind="illustration" /> : <AppIcon icon={Inbox} kind="illustration" />}
          <h2>{tr(empty.title)}</h2>
          {empty.description && <p>{tr(empty.description)}</p>}
          {emptyAction && empty.actionLabel && <div className="empty-list-actions">
            <button className={empty.action === "create" ? "primary" : "secondary"} onClick={event => {
              if (event.detail === 0 && document.activeElement === event.currentTarget &&
                  (empty.action === "showAll" || empty.action === "searchAll" || empty.action === "clearFilters" || empty.action === "clearQuery"))
                focusAfterEmptyAction.current = { opener: event.currentTarget, scope: null };
              emptyAction();
            }} disabled={p.busy}>{tr(empty.actionLabel)}</button>
          </div>}
        </div>
      ) : (
        <div className="task-list" role="list" aria-label={tr("会话列表")}>
          {rows.map((t) => {
            const inactive = !currentRows.has(t.id);
            const creation = inactive ? undefined : p.creationCues?.get(t.id);
            const creationPending = creation && creation.phase !== "confirmed" ? creation : undefined;
            const recentlyCreated = !inactive && (creation ? creation.phase === "confirmed" : recentCreationExpiry(t, now) !== null);
            const messageAt = lastMessageTime(t);
            const runtime = p.runtimeUnavailable || p.runtimeLoading ? undefined : p.runtimeStates?.get(t.id);
            const presentation = threadListPresentation(t, p.draftIds?.has(t.id), runtime);
            const states = presentation.secondaryStates.filter(state => state.key !== "archived" || p.view !== "archived");
            const rowState = creationPending ? `creation-${creationPending.phase}` : presentation.primaryState?.key ?? states.find(state => state.key === "unread")?.key;
            const automations = t.automationSummary;
            const hasAutomations = !!automations && Number.isInteger(automations.count) && automations.count > 0;
            const allAutomationsPaused = hasAutomations && automations.activeCount === 0 && automations.pausedCount === automations.count;
            const automationState = allAutomationsPaused ? "paused" : automations && automations.activeCount > 0 ? "active" : "unknown";
            const automationLabel = hasAutomations ? tr("定时任务：{{count}} 个，{{statuses}}{{stale}}", {
              count: automations.count,
              statuses: [
                automations.activeCount > 0 ? tr("{{count}} 个已启用", { count: automations.activeCount }) : "",
                automations.pausedCount > 0 ? tr("{{count}} 个已暂停", { count: automations.pausedCount }) : "",
                automations.count > automations.activeCount + automations.pausedCount ? tr("部分状态待确认") : "",
              ].filter(Boolean).join(tr("，")),
              stale: automations.stale ? tr("；缓存可能已过期") : "",
            }) : "";
            return (
              <SwipeTaskRow
                className={`task-row ${p.selected === t.id ? "is-selected" : ""} ${recentlyCreated ? "is-recently-created" : ""} ${creationPending ? `is-creation-${creationPending.phase}` : ""}`}
                key={t.id}
                threadId={t.id} title={t.title} prioritized={pocketPriority(t)} hidden={t.pocketHidden === true} open={openRowId === t.id}
                disabled={inactive || p.busy || !!pendingId} pending={pendingId === t.id} pendingAction={pendingAction?.kind} error={actionErrors[t.id]}
                onPriority={p.onPriority ? animate => void changePriority(t, animate) : undefined}
                onHidden={p.onHidden ? animate => void changeHidden(t, animate) : undefined}
                onOpenChange={value => setOpenRowId(current => value ? t.id : current === t.id ? null : current)}
                onClaim={() => setOpenRowId(current => current === t.id ? current : null)} onDismissError={() => clearActionError(t.id)}
              >
                <button
                  className="task-select"
                  data-thread-id={t.id}
                  data-row-state={rowState}
                  data-creation-request-id={creation?.requestId}
                  data-creation-state={creation?.phase}
                  disabled={inactive}
                  onClick={event => { if (!latest.current.currentRows.has(t.id)) return; setOpenRowId(null); p.onSelect(t.id, event.detail !== 0, inspectorEntryFromClick(event)); }}
                  aria-pressed={p.selected === t.id}
                  title={t.title}
                >
                  {recentlyCreated && <span className="sr-only">{tr("5 分钟内新建，")}</span>}
                  <div className="row-first">
                    <strong>{t.separator ? tr("分隔符会话") : t.title}</strong>
                    {pocketPriority(t) && <AppIcon icon={Star} kind="marker" className="priority-icon"
                      data-list-status="priority" data-list-status-key="pocket" role="img" aria-label={tr("Pocket 优先关注")} />}
                    {codexPinned(t) && <AppIcon icon={Pin} kind="marker" className="pin-icon"
                      data-list-status="codex-pin" data-list-status-key="codex" data-pin-source="codex" role="img" aria-label={tr("Codex 置顶")} />}
                    {hasAutomations && <span className="thread-automation-icon" data-automation-state={automationState}
                      data-automation-stale={automations.stale || undefined} data-list-status="automation"
                      role="img" aria-label={automationLabel} title={automationLabel}>
                      {allAutomationsPaused ? <AppIcon icon={AlarmClockOff} kind="marker" aria-hidden="true" /> : <AppIcon icon={Clock} kind="marker" aria-hidden="true" />}
                    </span>}
                    <span className="row-status-slot" data-list-status="primary" data-list-status-key={creationPending ? `creation-${creationPending.phase}` : presentation.primaryState?.key ?? "time"}>
                      {creationPending ? <span className="creation-state-label" data-creation-phase={creationPending.phase} role="status">{tr(creationPending.label)}</span>
                        : presentation.primaryState ? <span className="task-state-badge" data-state={presentation.primaryState.key}>
                        {tr(presentation.primaryState.label)}
                      </span> : messageAt !== null ? <time dateTime={new Date(messageAt).toISOString()} title={tr("最后消息：{{time}}", { time: formatDate(messageAt) })}>{ago(messageAt)}</time>
                        : <span aria-label={tr("暂无可确认的消息时间")} title={tr("暂无可确认的消息时间")}>—</span>}
                    </span>
                  </div>
                  {(!p.projectScope || states.length > 0) && <div className="row-second">
                    {!p.projectScope && <span className="project-label">
                      {t.projectName === "无项目" ? tr("独立会话") : t.projectName}
                    </span>}
                    {states.length > 0 && <span className="row-secondary-states" data-list-status="secondary" data-list-status-key={states.map(state => state.key).join(" ")}>
                      {states.map(state => <span key={state.key} className="task-state-badge" data-state={state.key}>{tr(state.label)}</span>)}
                    </span>}
                  </div>}
                  {pendingId === t.id && <span className="sr-only" role="status">{tr("正在保存…")}</span>}
                </button>
                <IconButton type="button"
                  className="row-open icon-button"
                  aria-label={tr("在 Codex 打开 {{title}}", { title: t.title })}
                  title={tr("在 Codex 打开")}
                  onClick={() => { const current = latest.current.currentRows.get(t.id); if (current) p.onOpen(current); }}
                  disabled={inactive || t.missing || p.busy || !!pendingId}
                >
                  <AppIcon icon={ArrowUpRight} kind="action" />
                </IconButton>
              </SwipeTaskRow>
            );
          })}
          {p.threads.length > limit && (
            <button
              className="load-more"
              onClick={() => setLimits(previous => {
                const next = new Map(previous);
                next.delete(scope); next.set(scope, limit + 80);
                if (next.size > 10) next.delete(next.keys().next().value!);
                return next;
              })}
            >{tr("显示更多 · 还有 {{count}} 条", { count: p.threads.length - limit })}</button>
          )}
        </div>
      )}
    </div>
  );
}
