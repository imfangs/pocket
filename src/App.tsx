import { AppIcon } from "./ui/AppIcon";
import { t as tr, useLocale } from "./i18n";
import { TaskReferencesProvider } from "./MessageTaskCard";
import { ConversationNavigationStack } from "./conversationNavigationStack";
import { IconButton } from "./ui/IconButton";
import { Button } from "./ui/Button";
import {
  Menu,
  Search,
  CircleDot,
  CirclePlay,
  Star,
  RefreshCw,
  X,
  AlertCircle,
  Plus,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { SetStateAction } from "react";
import { flushSync } from "react-dom";
import { toast } from "sonner";
import Sidebar from "./Sidebar";
import TaskList from "./TaskList";
import TaskListPanel from "./TaskListPanel";
import ThreadSortMenu from "./ThreadSortMenu";
import "./filter-sort-row.css";
import CollectionReadFeedback from "./CollectionReadFeedback";
import Inspector from "./Inspector";
import BootSplash from "./BootSplash";
import type { HistoryCache } from "./conversationFeed";
import type { ConnectOptions, OpenThreadResult } from "./threadConnection";
import { SettingsDialog } from "./Dialogs";
import { api, setToken, clearReadResponses } from "./api";
import { CatalogSourceError, createCatalogReader } from "./catalogReader";
import { startRecentThreadCatalogSync } from "./recentThreadCatalog";
import { useReloadGuard } from "./updateSafety";
import { hasUpdateBlockingDraft, protectedDraftThreadIds } from "./updateDrafts";
import PocketUpdate from "./PocketUpdate";
import NetworkTitle from "./NetworkTitle";
import { usePocketFeedback } from "./PocketFeedback";
import { filterThreads, preserveOpenThread } from "./model";
import { UNASSIGNED_PROJECT } from "./projectNavigation";
import { readPocketActivity, recordPocketVisit, rememberPocketCreations, savePocketActivity } from "./pocketActivity";
import type { Catalog, Thread, View } from "./types";
import NewConversationDialog, { type NewConversationInput } from "./NewConversationDialog";
import { startUsageAnalytics } from "./usageAnalytics";
import { createSubmittedQueryStore, seedSubmittedQuery, visibleSubmittedQueries } from "./submittedQueries";
import { prepareCreationDialog, type CreationClipboard } from "./creationQuery";
import type { CreateLocation, TaskOperation } from "./taskOperations";
import type { CreationPreference } from "./creationPreference";
import CreationPendingRows from "./CreationPendingRows";
import { creationCue, creationNeedsAttention, withCreatedThread, type CreationCue } from "./creationList";
import { readCreationConfirmations, saveCreationConfirmations } from "./creationConfirmations";
import "./creation-list.css";
import TaskOperationStatus from "./TaskOperationStatus";
import useTaskOperations from "./useTaskOperations";
import useTaskStatuses from "./useTaskStatuses";
import { pocketReadState } from "./pocketReadState";
import { activeOperation } from "./taskOperations";
import { createDraftMap, draftThreadIds } from "./draftIndicators";
import { preserveNewerThreadMetadata } from "./threadMetadata";
import { hasPriorityState, pocketPriority, priorityFields } from "./priority";
import { hiddenFields, pocketHidden, updateThreadHidden } from "./hiddenThreads";
import { focusInspectorEntry, inspectorEntryFromClick, scheduleInspectorReturnFocus, type InspectorEntryOrigin } from "./inspectorFocus";
import { machineStorageKey, currentMachineId } from "./machineScope";
import { clearNotificationTarget, readInitialNotificationTarget, notificationRouteUrl, type NotificationEntryEvent } from "./notificationTarget";
import { createReadingCache, readingCatalogScope, type ReadingCache } from "./readingCache";
import useTranscriptPrefetch from "./useTranscriptPrefetch";
import type { TranscriptReader } from "./transcriptReader";
import { changeNavigation, navigationActivityCounts, navigationTitle, normalizeNavigationPrefs, type NavigationChange } from "./navigationModel";
import "./task-operations.css";
function readPrefs() {
  try {
    return normalizeNavigationPrefs(JSON.parse(localStorage.getItem(machineStorageKey("navigator.view")) || "{}"));
  } catch {
    return normalizeNavigationPrefs(null);
  }
}
const catalogError = (error: Error) => ["TimeoutError", "AbortError"].includes(error.name)
  ? "读取较慢，请稍后重试。"
  : /failed to fetch|networkerror|load failed/i.test(error.message)
    ? "连接中断，请重试。"
    : error.message;
const empty: Catalog = {
  threads: [],
  groups: [],
  projects: [],
  sourceInfo: null,
  sourceError: null,
};
export default function App({
  appearanceActions,
  logoutAction,
}: {
  appearanceActions?: React.ReactNode;
  logoutAction?: React.ReactNode;
}) {
  const locale = useLocale();
  useEffect(startUsageAnalytics, []);
  const [navigation, setNavigation] = useState(readPrefs);
  const { scope, project, activity, sort } = navigation;
  const [pocketActivity, setPocketActivity] = useState(() => readPocketActivity());
  const [draftIndicatorRevision, setDraftIndicatorRevision] = useState(0);
  const [conversationDrafts] = useState(() => ({ current: createDraftMap(() => setDraftIndicatorRevision(value => value + 1)) }));
  const [submissions] = useState(createSubmittedQueryStore);
  useEffect(() => submissions.subscribe(() => setDraftIndicatorRevision(value => value + 1)), [submissions]);
  const creationQueries = useRef(new Map<string, string>());
  const creationDrafts = useRef(new Map<string, { input: NewConversationInput; location?: CreateLocation; startedAt: number }>());
  const [creationConfirmedAt, setCreationConfirmedAt] = useState(readCreationConfirmations);
  const observedCreationWaits = useRef(new Set<string>());
  const [hiddenCreationNotices, setHiddenCreationNotices] = useState(() => new Set<string>());
  useReloadGuard(() => submissions.reloadBlocker());
  const [narrow, setNarrow] = useState(() => matchMedia("(max-width:760px)").matches);
  useEffect(() => {
    const media = matchMedia("(max-width:760px)");
    const update = () => setNarrow(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const [catalog, setCatalogState] = useState<Catalog>(empty),
    [loading, setLoading] = useState(true),
    [catalogLoaded, setCatalogLoaded] = useState(false),
    [catalogReading, setCatalogReading] = useState(false),
    [selected, setSelectedState] = useState<string | null>(() => {
      let id = new URLSearchParams(location.search).get("task");
      try { id = readInitialNotificationTarget(sessionStorage, location.search); } catch {}
      return id && /^[a-f0-9-]{36}$/i.test(id) ? id : null;
    }),
    [query, setQuery] = useState(""),
    [searchOpen, setSearchOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [readError, setReadError] = useState(""),
    [mobile, setMobile] = useState(false),
    [settings, setSettings] = useState(false),
    [newConversationOpen, setNewConversationOpen] = useState(false),
    [newConversationDraft, setNewConversationDraft] = useState<{ text: string; name?: string; selection?: CreationPreference; clipboardRead?: Promise<CreationClipboard> } | null>(null),
    [createRequestId, setCreateRequestId] = useState<string | null>(null);
  const readRevision = useSyncExternalStore(pocketReadState.subscribe, pocketReadState.getSnapshot, pocketReadState.getSnapshot);
  const pocketReadScope = catalog.sourceInfo?.pocketRead?.scope;
  const displayCatalog = useMemo(() => ({ ...catalog, threads: catalog.threads.map(thread => {
    const unread = pocketReadState.unread(thread);
    if (typeof unread === "boolean") return { ...thread, pocketUnread: unread };
    if (Object.hasOwn(thread, "pocketUnread")) {
      const { pocketUnread: _ignored, ...original } = thread;
      return original;
    }
    return thread;
  }) }), [catalog, readRevision]);
  const draftIds = useMemo(() => draftThreadIds(conversationDrafts.current), [conversationDrafts, draftIndicatorRevision]);
  const taskStatuses = useTaskStatuses({ threads: displayCatalog.threads, activity: pocketActivity,
    selectedId: selected, excludedThreadIds: catalog.excludedThreadIds, draftIds,
    machine: currentMachineId(), readingScope: pocketReadScope });
  const selectedRef = useRef(selected);
  const conversationMachine = currentMachineId();
  const conversationStack = useMemo(() => new ConversationNavigationStack({ machine: conversationMachine, readingScope: pocketReadScope }), [conversationMachine, pocketReadScope]);
  const latestConversationStack = useRef(conversationStack); latestConversationStack.current = conversationStack;
  const selectionRevision = useRef(0);
  const notificationTarget = useRef<{ id: string; selection: number; stack?: ConversationNavigationStack; origin?: InspectorEntryOrigin } | null>(null);
  const notificationRouteOwner = useRef<{ id: string; selection: number } | null>(null);
  const returnFocusController = useRef<AbortController | null>(null);
  useEffect(() => () => returnFocusController.current?.abort(), []);
  const [animateSelection, setAnimateSelection] = useState(false);
  const [entryOrigin, setEntryOrigin] = useState<InspectorEntryOrigin>("programmatic");
  const [newConversationClosing, setNewConversationClosing] = useState(false);
  const setSelected = useCallback((id: string | null, animate = false, origin: InspectorEntryOrigin = "programmatic", navigation: "root" | "push" | "back" = "root") => {
    returnFocusController.current?.abort(); returnFocusController.current = null;
    const from = selectedRef.current;
    if (navigation === "root") latestConversationStack.current.replace();
    selectionRevision.current++;
    selectedRef.current = id;
    if (navigation === "push" && id) latestConversationStack.current.push(from, id);
    const owned = notificationRouteOwner.current;
    if (owned && id !== owned.id) {
      // Explicitly choosing the already-selected row is still a new intent.
      // React may skip a same-value state update, so revoke the old route here.
      try {
        const machine = currentMachineId();
        if (machine) history.replaceState(history.state, "", notificationRouteUrl(location.href, machine, id));
      } catch {}
      notificationRouteOwner.current = null;
      notificationTarget.current = null;
      try { clearNotificationTarget(sessionStorage); } catch {}
    }
    if (navigation === "back") {
      // Reference navigation owns a durable URL, including the final return
      // to the list after a previous back already released route ownership.
      try {
        const machine = currentMachineId();
        if (machine) history.replaceState(history.state, "", notificationRouteUrl(location.href, machine, id));
      } catch {}
    }
    setEntryOrigin(origin);
    setAnimateSelection(!!id && animate);
    setSelectedState(id);
  }, []);
  const search = useRef<HTMLInputElement>(null),
    searchToggle = useRef<HTMLButtonElement>(null),
    conversationHistory = useRef<HistoryCache>(new Map());
  const setCatalog = useCallback((update: SetStateAction<Catalog>) => {
    setCatalogState(current => {
      const retained = protectedDraftThreadIds(conversationDrafts.current, conversationHistory.current);
      for (const thread of current.threads) {
        if (visibleSubmittedQueries(submissions.getThread(thread.id), [], []).length) retained.add(thread.id);
      }
      return preserveOpenThread(current,
        preserveNewerThreadMetadata(current, typeof update === "function" ? update(current) : update), selectedRef.current, retained);
    });
  }, []);
  const pinNotificationRoute = (id: string) => {
    try {
      const machine = currentMachineId();
      if (!machine) return false;
      history.replaceState(history.state, "", notificationRouteUrl(location.href, machine, id));
      notificationRouteOwner.current = { id, selection: selectionRevision.current };
      return true;
    } catch { return false; }
  };
  useEffect(() => {
    setCatalog(current => current);
  }, [selected, draftIndicatorRevision, setCatalog]);
  const syncing = useRef<Promise<Catalog | undefined> | null>(null);
  const createRequest = useRef<string | null>(null), newDialogOpen = useRef(false);
  useEffect(() => {
    window.dispatchEvent(new Event("pocket-reading-visibility-change"));
  }, [mobile, settings, newConversationOpen]);
  useReloadGuard(() => hasUpdateBlockingDraft(conversationDrafts.current, conversationHistory.current)
    ? "还有未完成的输入，请处理后再更新。" : busy ? "操作尚未完成，请稍后更新。" : null);
  const listPanel = useRef<HTMLElement>(null);
  const cacheRef = useRef<ReadingCache | null>(null), catalogFresh = useRef(false), catalogScope = useRef<string | null>(null);
  const transcriptReader = useRef<TranscriptReader | null>(null), prefetchCatalogAt = useRef(0);
  const [readingCache, setReadingCache] = useState<ReadingCache | null>(null);
  const [catalogFromDisk, setCatalogFromDisk] = useState(false);
  const visibilityCachePending = useRef(false);
  useEffect(() => {
    if (!visibilityCachePending.current || !readingCache || !catalogFresh.current) return;
    const machine = currentMachineId();
    if (!machine || !readingCatalogScope(catalog)) return;
    visibilityCachePending.current = false;
    readingCache.rememberCatalog(machine, catalog);
  }, [catalog, readingCache]);
  useEffect(() => {
    const machine = currentMachineId();
    if (!machine) return;
    const cache = createReadingCache(); let active = true;
    cacheRef.current = cache; setReadingCache(cache);
    void cache.loadCatalog(machine).then(snapshot => {
      if (!active || !snapshot || catalogFresh.current) return;
      catalogScope.current = snapshot.scope;
      setCatalogState(current => current.sourceInfo || current.threads.length ? current : snapshot.value);
      setCatalogFromDisk(true); setCatalogLoaded(true);
    });
    return () => { active = false; if (cacheRef.current === cache) cacheRef.current = null; cache.dispose(); };
  }, []);
  const restoreScroll = useRef<number | null>(null);
  const openSearch = useCallback(() => {
    // Focus during the tap so iOS opens the keyboard on the first interaction.
    flushSync(() => { setMobile(false); setSearchOpen(true); });
    search.current?.focus();
  }, []);
  const closeSearch = useCallback(() => {
    setQuery("");
    setSearchOpen(false);
    searchToggle.current?.focus();
  }, []);
  useLayoutEffect(() => {
    if (restoreScroll.current === null || !listPanel.current) return;
    listPanel.current.scrollTop = restoreScroll.current;
    restoreScroll.current = null;
  }, [scope, project, activity, sort, query]);
  const notify = useCallback((s: string) => {
    toast.success(tr(s), { id: "pocket-feedback" });
  }, []);
  const [catalogReader] = useState(() => createCatalogReader({
    request: sync => api<Catalog>(sync ? "/api/sync" : "/api/catalog", sync ? "POST" : "GET",
      undefined, { signal: AbortSignal.timeout(15000) }),
    onData(c) {
      if (c.csrfToken) setToken(c.csrfToken);
      const scope = readingCatalogScope(c);
      if (scope !== catalogScope.current) { transcriptReader.current?.stop(); transcriptReader.current = null; }
      prefetchCatalogAt.current = scope && !c.sourceError ? Date.now() : 0;
      if (scope && catalogScope.current && scope !== catalogScope.current) {
        conversationHistory.current = new Map();
        const machine = currentMachineId(); if (machine) clearReadResponses(machine);
        setCatalogState(c);
      } else setCatalog(c);
      catalogScope.current = scope; catalogFresh.current = true; setCatalogFromDisk(false);
      if (!c.sourceError) {
        setCatalogLoaded(true);
        const machine = currentMachineId(); if (machine) cacheRef.current?.rememberCatalog(machine, c);
      }
    },
    onPendingChange(pending) { setCatalogReading(pending); if (pending) setReadError(""); },
    onSettled(error) {
      if (error) { prefetchCatalogAt.current = 0; transcriptReader.current?.wake(true); }
      setLoading(false); setReadError(error ? catalogError(error) : "");
    },
  }));
  const refresh = useCallback((sync = false) => catalogReader.read(sync), [catalogReader]);
  const syncTasks = useCallback((silent = false) => {
    if (!syncing.current) {
      const operation = refresh(true).finally(() => {
        if (syncing.current === operation) syncing.current = null;
      });
      syncing.current = operation;
    }
    if (silent) return syncing.current.then(() => {});
    setBusy(true);
    return syncing.current.then(catalog => {
      if (catalog) notify("已刷新");
    }).finally(() => {
      setBusy(false);
    });
  }, [refresh, notify]);
  const refreshAfterActivity = useCallback(() => {
    if (navigator.onLine === false) return;
    // If an older catalog read is already in flight, start a fresh one after
    // it settles so a send acknowledged during that read is not missed.
    void (syncing.current ?? Promise.resolve()).catch(() => {}).then(() => syncTasks(true)).catch(() => {});
  }, [syncTasks]);
  const openCreatedThread = (id: string) => {
    setSelected(id, true); setNavigation(previous => ({ ...changeNavigation(previous, { type: "scope", scope: "all" }), activity: "all" })); setQuery("");
    setSearchOpen(false); setMobile(false);
  };
  const seedCreationMessage = (operation: TaskOperation, force = false) => {
    // Background creation is already durable on the Mac. A local transcript
    // copy is only needed when the user actually opens this conversation.
    if (!force && selectedRef.current !== operation.threadId) return;
    const text = creationQueries.current.get(operation.requestId) ?? creationDrafts.current.get(operation.requestId)?.input.initialQuery;
    if (operation.threadId && operation.creationStatus === "created" && operation.initialMessage) {
      if (text) {
        seedSubmittedQuery(submissions, { threadId: operation.threadId, requestId: operation.initialMessage.requestId,
          text, status: operation.initialMessage.status, code: operation.initialMessage.code });
        creationQueries.current.delete(operation.requestId);
      }
      submissions.receipt(operation.threadId, operation.initialMessage);
    }
  };
  const taskOperations = useTaskOperations(operation => {
    seedCreationMessage(operation);
    catalogReader.invalidate();
    if (operation.thread) setCatalog(previous => {
      if (operation.operation === "create") return withCreatedThread(previous, operation);
      const found = previous.threads.some(thread => thread.id === operation.thread!.id);
      return { ...previous,
        excludedThreadStates: previous.excludedThreadStates?.map(state => state.id === operation.thread!.id
          ? { ...state, archived: operation.thread!.archived } : state),
        threads: found ? previous.threads.map(thread => thread.id === operation.thread!.id ? { ...thread, archived: operation.thread!.archived, missing: operation.thread!.missing,
        ...(operation.thread!.sourceExcluded ? { sourceExcluded: true } : {}) } : thread)
        : [...previous.threads, operation.thread!] };
    });
    refreshAfterActivity();
  });
  useReloadGuard(() => taskOperations.creations.some(operation => operation.status === "rejected" && !operation.creationStatus
    && (creationDrafts.current.get(operation.requestId)?.input.initialQuery || creationDrafts.current.get(operation.requestId)?.input.name))
    ? "新会话未创建，原输入已保留；请先重试或放弃本次新建。" : null);
  useEffect(() => { taskOperations.operations.forEach(operation => seedCreationMessage(operation)); }, [taskOperations.operations, submissions, selected]);
  const recentCreationConfirmation = (operation: TaskOperation) => creationConfirmedAt.has(operation.requestId)
    ? Date.now() < creationConfirmedAt.get(operation.requestId)! + 300000
    : creationDrafts.current.has(operation.requestId) || observedCreationWaits.current.has(operation.requestId)
      || Math.abs(Date.now() - (operation.createdAt ?? operation.thread?.createdAt ?? 0)) < 300000;
  useEffect(() => { saveCreationConfirmations(creationConfirmedAt); }, [creationConfirmedAt]);
  useEffect(() => {
    for (const operation of taskOperations.creations) {
      if (operation.status === "succeeded" && operation.initialMessage?.status === "cancelled") {
        taskOperations.dismiss(operation.requestId);
        creationDrafts.current.delete(operation.requestId); creationQueries.current.delete(operation.requestId);
        continue;
      }
      const cue = creationCue(operation);
      if (cue && cue.phase !== "confirmed" && operation.createdAt !== undefined) observedCreationWaits.current.add(operation.requestId);
    }
    const confirmed = taskOperations.creations.filter(operation => creationCue(operation)?.phase === "confirmed");
    for (const operation of confirmed) if (!recentCreationConfirmation(operation)) taskOperations.dismiss(operation.requestId);
    const newlyConfirmed = confirmed.filter(operation => recentCreationConfirmation(operation) && !creationConfirmedAt.has(operation.requestId));
    if (!newlyConfirmed.length) return;
    setCreationConfirmedAt(previous => {
      const next = new Map(previous);
      for (const operation of newlyConfirmed) if (!next.has(operation.requestId)) next.set(operation.requestId,
        creationDrafts.current.has(operation.requestId) || observedCreationWaits.current.has(operation.requestId)
          ? Date.now() : operation.thread?.createdAt ?? operation.createdAt ?? Date.now());
      return next;
    });
    refreshAfterActivity();
  }, [taskOperations.creations, creationConfirmedAt, refreshAfterActivity]);
  const creationDismiss = useRef(taskOperations.dismiss);
  creationDismiss.current = taskOperations.dismiss;
  useEffect(() => {
    const completed = taskOperations.creations.filter(operation => creationCue(operation)?.phase === "confirmed"
      && creationConfirmedAt.has(operation.requestId) && catalog.threads.some(thread => thread.id === operation.threadId));
    if (!completed.length) return;
    const retire = () => {
      for (const operation of completed) if (Date.now() >= creationConfirmedAt.get(operation.requestId)! + 300000) {
        creationDismiss.current(operation.requestId);
        creationDrafts.current.delete(operation.requestId); creationQueries.current.delete(operation.requestId);
      }
    };
    const deadline = Math.min(...completed.map(operation => creationConfirmedAt.get(operation.requestId)! + 300000));
    const timer = window.setTimeout(retire, Math.max(0, deadline - Date.now()));
    window.addEventListener("pageshow", retire);
    document.addEventListener("visibilitychange", retire);
    return () => { window.clearTimeout(timer); window.removeEventListener("pageshow", retire); document.removeEventListener("visibilitychange", retire); };
  }, [taskOperations.creations, creationConfirmedAt, catalog.threads]);
  useEffect(() => { setPocketActivity(previous => rememberPocketCreations(previous, taskOperations.operations)); }, [taskOperations.operations]);
  useEffect(() => { savePocketActivity(pocketActivity); }, [pocketActivity]);
  const showNewConversation = async () => {
    const prepared = await prepareCreationDialog({
      existing: taskOperations.operations.find(operation => operation.operation === "create" && activeOperation(operation)),
      getLatest: taskOperations.get,
      readText: () => navigator.clipboard.readText(),
    });
    if (prepared.kind === "open") { await openCreation(prepared.operation); return; }
    const { operation: existing, clipboardRead } = prepared;
    const saved = existing ? creationDrafts.current.get(existing.requestId) : undefined;
    const existingQuery = existing ? creationQueries.current.get(existing.requestId) ??
      saved?.input.initialQuery ?? (existing.threadId && submissions.getThread(existing.threadId).find(entry => entry.requestId === existing.initialMessage?.requestId)?.text) : "";
    setNewConversationDraft({ text: existingQuery || "", clipboardRead, name: saved?.input.name,
      selection: saved?.location ? { cwd: saved.location.cwd, locationId: saved.location.id } : undefined });
    createRequest.current = existing?.requestId ?? null;
    setCreateRequestId(createRequest.current);
    setNewConversationClosing(false);
    newDialogOpen.current = true; setNewConversationOpen(true);
  };
  const startCreation = async (input: NewConversationInput, location?: CreateLocation) => {
    if (createRequest.current && activeOperation(taskOperations.operations.find(operation => operation.requestId === createRequest.current))) return;
    if (taskOperations.operations.some(operation => operation.operation === "create" && activeOperation(operation)))
      throw new Error("已有新建结果待确认，请先在列表中核对。");
    const previous = createRequest.current && taskOperations.get(createRequest.current);
    if (previous && previous.status === "rejected" && !previous.creationStatus) taskOperations.dismiss(previous.requestId);
    const requestId = crypto.randomUUID(); createRequest.current = requestId; setCreateRequestId(requestId);
    if (input.initialQuery) creationQueries.current.set(requestId, input.initialQuery);
    creationDrafts.current.set(requestId, { input, location, startedAt: Date.now() });
    const pending = taskOperations.start("create", input, undefined, requestId);
    // Leave only the dialog, not the request. App owns the receipt and keeps
    // observing it while the user browses the list or another conversation.
    newDialogOpen.current = false; setNewConversationClosing(true);
    setSelected(null); setNavigation(value => ({ ...changeNavigation(value, { type: "scope", scope: "all" }), activity: "all" }));
    setQuery(""); setSearchOpen(false); setMobile(false); restoreScroll.current = 0;
    if (listPanel.current) listPanel.current.scrollTop = 0;
    const result = await pending;
    seedCreationMessage(result);
    if (result.requestId !== requestId) { createRequest.current = result.requestId; setCreateRequestId(result.requestId); }
    return result;
  };
  const openCreation = async (operation: TaskOperation) => {
    if (!operation.threadId || !(operation.status === "succeeded" || operation.creationStatus === "created")) return;
    if (!operation.thread && !catalog.threads.some(thread => thread.id === operation.threadId)) {
      const refreshed = await (syncing.current ?? refresh(true));
      if (!refreshed?.threads.some(thread => thread.id === operation.threadId))
        throw new Error("会话已创建，列表尚未同步，请稍后重试。");
    }
    if (operation.thread && !catalog.threads.some(thread => thread.id === operation.threadId)) {
      catalogReader.invalidate();
      setCatalog(previous => withCreatedThread(previous, operation));
    }
    seedCreationMessage(operation, true);
    openCreatedThread(operation.threadId);
  };
  const reviewCreation = (operation: TaskOperation) => {
    if (operation.creationStatus === "created" || operation.status === "succeeded") { void guard(() => openCreation(operation)); return; }
    const saved = creationDrafts.current.get(operation.requestId);
    createRequest.current = operation.requestId; setCreateRequestId(operation.requestId);
    setNewConversationDraft({ text: saved?.input.initialQuery ?? creationQueries.current.get(operation.requestId) ?? "",
      name: saved?.input.name, selection: saved?.location ? { cwd: saved.location.cwd, locationId: saved.location.id } : undefined });
    setNewConversationClosing(false); newDialogOpen.current = true; setNewConversationOpen(true);
  };
  const discardCreation = (operation: TaskOperation) => {
    if (operation.status !== "rejected" || operation.creationStatus || !window.confirm(tr("放弃本次新建并清除保留的输入？"))) return;
    taskOperations.dismiss(operation.requestId);
    creationDrafts.current.delete(operation.requestId); creationQueries.current.delete(operation.requestId);
  };
  useEffect(() => {
    catalogReader.resume();
    const syncIfVisible = () => {
      if (document.visibilityState === "visible" && navigator.onLine !== false)
        void syncTasks(true).catch(() => {});
    };
    refresh()
      .then(catalog => { if (catalog) syncIfVisible(); })
      // A persisted source error still deserves the normal one fresh scan at
      // entry. Network failures wait for the existing retry/foreground paths.
      .catch(error => { if (error instanceof CatalogSourceError) syncIfVisible(); });
    const timer = setInterval(syncIfVisible, 45000);
    document.addEventListener("visibilitychange", syncIfVisible);
    window.addEventListener("online", syncIfVisible);
    window.addEventListener("pageshow", syncIfVisible);
    return () => {
      catalogReader.pause();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", syncIfVisible);
      window.removeEventListener("online", syncIfVisible);
      window.removeEventListener("pageshow", syncIfVisible);
    };
  }, [refresh, syncTasks, catalogReader]);
  const recentSelected = catalog.threads.find(thread => thread.id === selected);
  const recentSelectedAt = recentSelected && !recentSelected.archived && !recentSelected.missing && !recentSelected.sourceExcluded
    ? recentSelected.createdAt : undefined;
  const recentBackgroundAt = Math.max(0, ...taskOperations.creations.filter(operation => operation.creationStatus === "created" || operation.status === "succeeded")
    .map(operation => catalog.threads.find(thread => thread.id === operation.threadId)?.createdAt ?? operation.thread?.createdAt ?? 0));
  const recentCreatedAt = Math.max(recentSelectedAt ?? 0, recentBackgroundAt) || undefined;
  useEffect(() => startRecentThreadCatalogSync({ createdAt: recentCreatedAt, sync: () => syncTasks(true) }),
    [selected, recentCreatedAt, syncTasks]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        if (document.querySelector("dialog[open]")) return;
        e.preventDefault();
        if (matchMedia("(max-width:760px)").matches && selected) {
          flushSync(() => setSelected(null));
          openSearch();
        } else openSearch();
      }
      if (e.key === "Escape" && !document.querySelector("dialog[open]"))
        setMobile(false);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [openSearch, selected]);
  useEffect(() => {
    try {
      localStorage.setItem(
        machineStorageKey("navigator.view"),
        JSON.stringify(navigation),
      );
    } catch {}
  }, [navigation]);
  useLayoutEffect(() => { if (!catalogFromDisk) pocketReadState.observeCatalog(catalog.threads, pocketReadScope); }, [catalog.threads, pocketReadScope, catalogFromDisk]);
  const runtimeKnown = !taskStatuses.runtimeLoading && !taskStatuses.runtimeUnavailable;
  const runtimeStates = runtimeKnown ? taskStatuses.runtimeStates : undefined;
  const listRuntimeStates = taskStatuses.listRuntimeStates;
  const listRuntimeKnown = !taskStatuses.listRuntimeLoading && !taskStatuses.listRuntimeUnavailable;
  const prefetchExcluded = useMemo(() => {
    const ids = new Set(catalog.excludedThreadIds);
    for (const thread of catalog.threads) if (pocketHidden(thread)) ids.add(thread.id);
    for (const operation of taskOperations.operations) if (operation.threadId && activeOperation(operation)) ids.add(operation.threadId);
    for (const [id, draft] of conversationDrafts.current) if (draft.requestId) ids.add(id);
    for (const thread of catalog.threads) if (submissions.getThread(thread.id).some(item => !item.echoed && !item.dismissed &&
      ["submitting", "connecting", "pending", "unknown", "editing"].includes(item.status))) ids.add(thread.id);
    return [...ids];
  }, [catalog.threads, catalog.excludedThreadIds, taskOperations.operations, draftIndicatorRevision, conversationDrafts, submissions]);
  const prefetchPriority = useMemo(() => ({ now: Date.now(), selectedId: selected, runtimeStates, pocketActivity, draftIds,
    excludedThreadIds: prefetchExcluded }), [selected, runtimeStates, pocketActivity, draftIds, prefetchExcluded]);
  const { readTranscript, holdBackground } = useTranscriptPrefetch({ machine: currentMachineId(), scope: pocketReadScope, cache: readingCache,
    readerRef: transcriptReader, threads: displayCatalog.threads, priority: prefetchPriority,
    enabled: !loading && !catalogReading && !catalogFromDisk && !catalog.sourceError && !readError && !busy && !settings && !newConversationOpen && !mobile,
    catalogFresh: () => prefetchCatalogAt.current > 0 && Date.now() >= prefetchCatalogAt.current && Date.now() - prefetchCatalogAt.current < 60000 });
  // Runtime polling must not make the clock itself a new ranking signal.
  const rankingTime = useMemo(() => Date.now(), [catalog, pocketActivity]);
  useEffect(() => {
    if (!loading && catalog.sourceInfo && !catalog.sourceError && project && project !== UNASSIGNED_PROJECT &&
      !catalog.projects.some(item => item.id === project && !item.separator)) setNavigation(previous => ({ ...previous, project: "" }));
  }, [catalog.projects, catalog.sourceInfo, catalog.sourceError, loading, project]);
  const threads = useMemo(
    () =>
      filterThreads(
        displayCatalog.threads,
        scope,
        query,
        project,
        sort,
        listRuntimeStates,
        { now: rankingTime, draftIds, pocketActivity },
        activity,
      ),
    [displayCatalog, scope, activity, sort, query, project, listRuntimeStates, rankingTime, draftIds, pocketActivity],
  );
  const creationRows = taskOperations.creations.flatMap(operation => {
    const cue = creationCue(operation);
    if (!cue || cue.phase === "confirmed" && !recentCreationConfirmation(operation)) return [];
    const thread = displayCatalog.threads.find(item => item.id === operation.threadId);
    if (thread?.archived || thread?.sourceExcluded || catalog.excludedThreadIds?.includes(operation.threadId || "") ||
      catalog.excludedThreadStates?.some(state => state.id === operation.threadId)) return [];
    const saved = creationDrafts.current.get(operation.requestId);
    const preview = saved?.input.name?.trim() || saved?.input.initialQuery?.replace(/\s+/g, " ").trim().slice(0, 80);
    return [{ operation, thread, cue: taskOperations.errors[operation.requestId] && cue.phase !== "confirmed"
      ? { ...cue, phase: "attention" as const, label: "确认暂时中断" } : cue,
      title: thread?.title || preview || operation.thread?.title || tr("新会话"),
      projectName: thread?.projectName || saved?.location?.projectName || operation.thread?.projectName,
      startedAt: saved?.startedAt ?? operation.createdAt ?? 0,
      canOpen: !!operation.threadId && !!(thread || operation.thread) && (operation.status === "succeeded" || operation.creationStatus === "created") }];
  }).sort((a, b) => b.startedAt - a.startedAt);
  const creationCues = new Map<string, CreationCue>(creationRows.flatMap(row => row.thread ? [[row.thread.id, row.cue] as const] : []));
  const showCreationArrival = scope === "all" && !project && activity === "all" && !query.trim();
  const pendingCreationRows = showCreationArrival ? creationRows.filter(row => !row.thread) : [];
  const promotedThreads = showCreationArrival ? creationRows.flatMap(row => row.thread && !pocketHidden(row.thread) ? [row.thread] : []) : [];
  const promotedIds = new Set(promotedThreads.map(thread => thread.id));
  const listThreads = [...promotedThreads, ...threads.filter(thread => !promotedIds.has(thread.id))];
  const creationNoticeKey = (operation: TaskOperation) => JSON.stringify([operation.requestId, operation.status,
    operation.initialMessage?.status, taskOperations.errors[operation.requestId]]);
  const operationNotices = taskOperations.notices.filter(operation => operation.operation !== "create" ||
    creationNeedsAttention(operation, taskOperations.errors[operation.requestId]) && !hiddenCreationNotices.has(creationNoticeKey(operation)));
  const current = displayCatalog.threads.find((t) => t.id === selected);
  const feedback = usePocketFeedback({ readingScope: pocketReadScope, threadId: current?.id, title: current?.title });
  const protectedDraftIds = protectedDraftThreadIds(conversationDrafts.current, conversationHistory.current);
  const retainedInputThreads = catalog.threads.filter(thread => thread.sourceExcluded &&
    (protectedDraftIds.has(thread.id) || visibleSubmittedQueries(submissions.getThread(thread.id), [], []).length > 0));
  const currentOperation = current ? taskOperations.operations.find(operation => operation.threadId === current.id && operation.operation !== "create" && activeOperation(operation))
    || taskOperations.operations.find(operation => operation.threadId === current.id && operation.operation !== "create") : undefined;
  const title = navigationTitle(navigation, catalog.projects);
  const unreadKnown = catalog.sourceInfo?.pocketRead?.available === true || catalog.sourceInfo?.unread?.available === true;
  const hasCatalog = catalogLoaded || catalog.threads.length > 0;
  const catalogReadError = catalogReading ? "" : readError || (catalog.sourceError ? "暂时无法更新，请稍后重试。" : "");
  const { unread: unreadCount, running: runningCount } = navigationActivityCounts(displayCatalog.threads, navigation, query, listRuntimeStates);
  const guard = async (action: () => Promise<void>) => {
    setError("");
    try {
      await action();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const updateNavigation = (change: NavigationChange, clearSearch = false) => void guard(async () => {
    if (change.type === "setSort" && change.sort === sort) return;
    restoreScroll.current = 0;
    setNavigation(previous => changeNavigation(previous, change));
    if (clearSearch) { setQuery(""); setSearchOpen(false); }
    if (change.type !== "setSort") setSelected(null);
    setMobile(false);
    refreshAfterActivity();
  });
  const switchView = (view: View) => {
    if (view === "all" || view === "priority" || view === "codex-pinned" || view === "archived" || view === "hidden")
      updateNavigation({ type: "scope", scope: view }, true);
  };
  const switchProject = (id: string) => updateNavigation({ type: "project", project: id }, true);
  const searchAllProjects = () => {
    updateNavigation({ type: "scope", scope: "all" });
    setSearchOpen(true);
  };
  useEffect(() => {
    const pending = notificationTarget.current;
    if (!pending) {
      // Render-time reads must be pure: StrictMode may evaluate the initial
      // state twice. Clear a durable target only after this App accepted it,
      // or a newer explicit route/user selection superseded it.
      try {
        const retained = sessionStorage.getItem(machineStorageKey("pocket.pending-task"));
        if (retained) {
          if (readInitialNotificationTarget(sessionStorage, location.search) !== retained || selectionRevision.current > 0 && selected !== retained)
            clearNotificationTarget(sessionStorage);
          else if (selected === retained && !catalog.sourceError && catalog.threads.some(thread => thread.id === retained) && pinNotificationRoute(retained))
            clearNotificationTarget(sessionStorage);
        }
      } catch {}
      return;
    }
    if (pending.selection !== selectionRevision.current) {
      notificationTarget.current = null;
      try { clearNotificationTarget(sessionStorage); } catch {}
    } else if (pending.stack && pending.stack !== latestConversationStack.current) {
      // An in-message reference belongs to its original source. Unlike a
      // system notification it must not enter the same ID in a new scope.
      notificationTarget.current = null; notificationRouteOwner.current = null;
      try { clearNotificationTarget(sessionStorage); } catch {}
      try {
        const machine = currentMachineId();
        if (machine) history.replaceState(history.state, "", notificationRouteUrl(location.href, machine, selectedRef.current));
      } catch {}
    } else if (!catalog.sourceError && catalog.threads.some(thread => thread.id === pending.id)) {
      notificationTarget.current = null;
      setSelected(pending.id, false, pending.origin, pending.stack === latestConversationStack.current ? "push" : "root"); setMobile(false);
      if (pinNotificationRoute(pending.id)) try { clearNotificationTarget(sessionStorage); } catch {}
    }
  }, [catalog.threads, catalog.sourceError, selected, setSelected]);
  useEffect(() => {
    const fromNotification = (event: Event) => {
      const reference = event.type === "pocket-open-reference";
      const detail = (event as CustomEvent<string | { threadId: string; origin?: InspectorEntryOrigin }>).detail;
      const id = reference && typeof detail === "object" ? detail?.threadId : detail;
      if (typeof id !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)) return;
      const origin = reference && typeof detail === "object" && ["pointer", "keyboard"].includes(detail?.origin || "") ? detail.origin : "programmatic";
      if (!pinNotificationRoute(id)) { (event as NotificationEntryEvent).targetRejected = true; return; }
      event.preventDefault(); // The durable route now owns this click even if storage or auth later fails.
      if (catalog.threads.some(thread => thread.id === id)) {
        notificationTarget.current = null;
        setSelected(id, false, origin, reference ? "push" : "root"); setMobile(false);
        notificationRouteOwner.current = { id, selection: selectionRevision.current };
        try { clearNotificationTarget(sessionStorage); } catch {}
      } else notificationTarget.current = { id, selection: selectionRevision.current,
        ...(reference ? { stack: latestConversationStack.current, origin } : {}) };
      // A known conversation opens before this read. Unknown targets remain
      // retained and are entered by the catalog effect after a later success.
      void guard(() => syncTasks(true));
    };
    window.addEventListener("pocket-open-task", fromNotification);
    window.addEventListener("pocket-open-reference", fromNotification);
    return () => {
      window.removeEventListener("pocket-open-task", fromNotification);
      window.removeEventListener("pocket-open-reference", fromNotification);
    };
  });
  const open = useCallback(
    async (t: Thread, options?: ConnectOptions) => {
      const result = await api<OpenThreadResult>(`/api/open/${t.id}`, "POST",
        options?.intent === "reading" ? { intent: "reading" } : undefined);
      if (result.status === "skipped" || options?.intent === "reading") return result;
      catalogReader.invalidate();
      setCatalog((c) => ({
        ...c,
        threads: c.threads.map((x) => (x.id === t.id ? result.thread : x)),
      }));
      if (!options?.quiet) notify(result.readOnly ? "已在 Mac 打开" : result.connection?.status === "connected" ? "已连接" : "连接中…");
      return result;
    },
    [notify, catalogReader],
  );
  const prioritizeThread = async (thread: Thread) => {
    if (!hasPriorityState(thread)) throw new Error("请更新 Mac 上的 Pocket 后再使用优先关注。");
    const priority = !pocketPriority(thread);
    let result: Thread;
    try {
      result = await api<Thread>(`/api/tasks/${thread.id}/priority`, "POST", { priority }, { signal: AbortSignal.timeout(15000) });
    } catch (error) {
      const status = (error as Error & { status?: number }).status;
      if (status && status < 500) throw error;
      // A lost reply may follow a committed metadata write. Only read back;
      // retrying from the row will still set an explicit boolean, never toggle.
      try {
        const fresh = await api<Catalog>("/api/catalog", "GET", undefined, { signal: AbortSignal.timeout(15000) });
        const confirmed = fresh.threads.find(item => item.id === thread.id);
        if (!confirmed || !hasPriorityState(confirmed) || confirmed.pocketPriority !== priority || !Number.isSafeInteger(confirmed.pinRevision)) throw error;
        result = confirmed;
      } catch { throw new Error("关注状态尚未确认，请刷新后再试。"); }
    }
    if (result.id !== thread.id || !hasPriorityState(result) || result.pocketPriority !== priority || !Number.isSafeInteger(result.pinRevision))
      throw new Error("关注状态尚未确认，请刷新后再试。");
    catalogReader.invalidate();
    setCatalog(current => ({ ...current, threads: current.threads.map(item => item.id === thread.id
      ? { ...item, ...priorityFields(result) } : item) }));
    void refresh().catch(() => {});
  };
  const hideThread = async (thread: Thread) => {
    const requestScope = catalogScope.current;
    if (!requestScope) { void refresh().catch(() => {}); throw new Error("会话信息正在更新，请稍后再试。"); }
    const isCurrent = () => catalogScope.current === requestScope;
    const hidden = !pocketHidden(thread);
    if (!catalogFresh.current || catalogFromDisk) {
      const fresh = await refresh();
      if (!fresh || !isCurrent() || readingCatalogScope(fresh) !== requestScope)
        throw new Error("会话来源已变化，请重新选择。");
      const current = fresh.threads.find(item => item.id === thread.id);
      if (!current) throw new Error("会话暂不可用，请刷新。");
      thread = current;
    }
    const result = await updateThreadHidden(thread, api, { hidden, scope: requestScope, isCurrent });
    catalogReader.invalidate();
    visibilityCachePending.current = true;
    setCatalog(current => !isCurrent() ? current : ({ ...current, threads: current.threads.map(item => item.id === result.id
      ? { ...item, ...hiddenFields(result) } : item) }));
    void refresh().catch(() => {});
  };
  if (loading && !hasCatalog) return <BootSplash />;
  return (
    <TaskReferencesProvider machine={currentMachineId()} scope={pocketReadScope} threads={displayCatalog.threads}
      excluded={catalog.excludedThreadIds} states={runtimeStates}>
    <div className="app-shell">
      <Sidebar
        catalog={displayCatalog}
        view={scope}
        mobileOpen={mobile}
        onClose={() => setMobile(false)}
        onView={switchView}
        project={project}
        onProject={switchProject}
        onSettings={() => setSettings(true)}
      />
      <main className={`workspace ${current ? "with-inspector" : ""}`} inert={narrow && mobile}>
        <header className="workspace-header" inert={narrow && !!current}>
          <PocketUpdate taskId={selected} />
          <div className="heading-line">
            <IconButton type="button"
              className="icon-button mobile-only"
              onClick={() => setMobile(true)}
              aria-label={tr("打开导航")}
            >
              <AppIcon icon={Menu} kind="navigation" />
            </IconButton>
            <div className="heading">
              <h1 title={title}>
                <NetworkTitle className="workspace-title" machine={currentMachineId()}>{title}</NetworkTitle>
                <span className="workspace-count">{!hasCatalog || activity === "unread" && !unreadKnown || activity === "running" && !listRuntimeKnown ? "—" : listThreads.length + pendingCreationRows.length}</span>
              </h1>
            </div>
            <IconButton type="button"
              ref={searchToggle}
              className="icon-button search-toggle"
              aria-label={searchOpen ? tr("收起搜索") : tr("展开搜索")}
              aria-expanded={searchOpen}
              aria-controls="task-search-box"
              aria-keyshortcuts="Control+K Meta+K"
              onClick={searchOpen ? closeSearch : openSearch}
            >
              <AppIcon icon={Search} kind="action" /><span>{tr("搜索")}</span><kbd aria-hidden="true">⌘ K</kbd>
            </IconButton>
            <Button variant="soft" color="gray" type="button"
              className="new-conversation-button"
              aria-label={tr("新建会话")}
              onClick={() => void guard(showNewConversation)}
            >
              <AppIcon icon={Plus} kind="action" /><span>{tr("新建会话")}</span>
            </Button>
            <button
              className={`sync-button ${busy ? "spinning" : ""}`}
              onClick={() => { void syncTasks().catch(() => {}); }}
              disabled={busy || loading}
              aria-label={tr("刷新会话")}
            >
              <AppIcon icon={RefreshCw} kind="action" />
              <span>{tr("同步")}</span>
            </button>
          </div>
          <div className="filter-row">
            <div className="activity-filters">
              {scope !== "archived" && scope !== "hidden" && ([
                { activity: "unread", label: "未读", Icon: CircleDot, count: unreadKnown ? unreadCount : "—" },
                { activity: "running", label: "运行中", Icon: CirclePlay, count: listRuntimeKnown ? runningCount : "—" },
              ] as const).map(filter => (
                <button key={filter.activity} className={`needs-input-toggle ${filter.activity}-toggle`}
                  data-inbox={activity === filter.activity} aria-pressed={activity === filter.activity}
                  title={activity === filter.activity ? tr("取消{{label}}筛选", { label: tr(filter.label) }) : tr("查看{{label}}的会话", { label: tr(filter.label) })}
                  onClick={() => updateNavigation({ type: "activity", activity: filter.activity })}>
                  <AppIcon icon={filter.Icon} kind="auxiliary" aria-hidden="true" />
                  <span>{tr(filter.label)}</span><small>{filter.count}</small>
                </button>
              ))}
              {scope !== "archived" && scope !== "hidden" && <button className="needs-input-toggle priority-toggle"
                data-inbox={scope === "priority"} aria-pressed={scope === "priority"}
                aria-label={scope === "priority" ? tr("返回{{view}}", { view: navigationTitle(navigation.priorityReturn || { scope: "all", project: "" }, catalog.projects) }) : tr("查看 Pocket 关注的会话")}
                title={scope === "priority" ? tr("返回{{view}}", { view: navigationTitle(navigation.priorityReturn || { scope: "all", project: "" }, catalog.projects) }) : tr("查看 Pocket 关注的会话")}
                onClick={() => updateNavigation({ type: "togglePriority" })}>
                <AppIcon icon={Star} kind="auxiliary" aria-hidden="true" /><span>{locale === "en" && narrow ? tr("优先关注") : tr("关注")}</span>
              </button>}
              <ThreadSortMenu value={sort} onChange={sort => updateNavigation({ type: "setSort", sort })}
                disabled={narrow && (!!current || mobile)} />
            </div>
          </div>
          {searchOpen && <div className="search-box expanded-search" id="task-search-box">
            <input
              ref={search}
              aria-label={tr("搜索会话")}
              placeholder={tr("搜索{{view}}…", { view: title })}
              aria-describedby="task-search-help"
              inputMode="search"
              enterKeyHint="search"
              autoComplete="off"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
                if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeSearch(); }
                if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur(); }
              }}
            />
            <IconButton type="button" className="icon-button" onClick={closeSearch} aria-label={tr("清除并收起搜索")}>
              <AppIcon icon={X} kind="action" />
            </IconButton>
          </div>}
          {searchOpen && <p id="task-search-help" className="sr-only">{tr("在当前视图内搜索标题、项目和目录。")}</p>}
        </header>
        {error && (
          <div className="error-banner" role="alert">
            <AppIcon icon={AlertCircle} kind="auxiliary" />
            <span>
              {tr(error)}
            </span>
            <IconButton type="button"
              className="icon-button"
              aria-label={tr("关闭提示")}
              onClick={() => setError("")}
            >
              <AppIcon icon={X} kind="action" />
            </IconButton>
          </div>
        )}
        {operationNotices.length > 0 && <div className="task-operation-notices" aria-label={tr("会话操作状态")}>
            {operationNotices.map(operation => <TaskOperationStatus key={operation.requestId} operation={operation}
              autoDismissEnabled={!(narrow && (mobile || !!current))}
              title={operation.threadId ? catalog.threads.find(thread => thread.id === operation.threadId)?.title : undefined}
              error={taskOperations.errors[operation.requestId]}
              onCheck={() => void taskOperations.check(operation.requestId)} onCancel={() => void taskOperations.cancel(operation.requestId)}
              onOpen={operation.threadId ? () => void guard(() => openCreation(operation)) : undefined}
              onRetry={operation.operation === "create" && operation.status === "rejected" && !operation.creationStatus
                && creationDrafts.current.has(operation.requestId) ? () => reviewCreation(operation) : undefined}
              onDiscard={operation.operation === "create" && operation.status === "rejected" && !operation.creationStatus
                && creationDrafts.current.has(operation.requestId) ? () => discardCreation(operation) : undefined}
              onDismiss={() => operation.operation === "create"
                ? setHiddenCreationNotices(previous => new Set(previous).add(creationNoticeKey(operation)))
                : taskOperations.dismiss(operation.requestId)} />)}
        </div>}
        <div className="content">
          <TaskListPanel busy={busy || loading} onRefresh={syncTasks} scrollRef={listPanel} inert={narrow && !!current}
            feedback={<CollectionReadFeedback hasCatalog={hasCatalog} pending={busy || !hasCatalog && (loading || catalogReading)}
              error={catalogReadError} stale={taskStatuses.listRuntimeStale}
              cachedStatus={taskStatuses.listRuntimeCached} cachedList={catalogFromDisk}
              retry={() => { void syncTasks().catch(() => {}); void taskStatuses.refresh(); }} />}>
              {retainedInputThreads.length > 0 && <section className="retained-inputs" aria-label={tr("保留的输入")}>
                <p>{tr("保留的输入")}</p>
                {retainedInputThreads.map(thread => <button key={thread.id} aria-label={tr("继续输入：{{title}}", { title: thread.title })}
                  onClick={event => setSelected(thread.id, event.detail !== 0, inspectorEntryFromClick(event))}>
                  <span>{thread.title}</span><small>{tr("继续处理")}</small>
                </button>)}
              </section>}
              <CreationPendingRows items={pendingCreationRows} onOpen={operation => void guard(() => openCreation(operation))} onReview={reviewCreation} />
              {hasCatalog && (listThreads.length > 0 || !pendingCreationRows.length) && <TaskList
                onPriority={prioritizeThread}
                onHidden={hideThread}
                runtimeStates={listRuntimeStates}
                runtimeUnavailable={taskStatuses.listRuntimeUnavailable}
                runtimeLoading={taskStatuses.listRuntimeLoading}
                onCreate={() => void guard(showNewConversation)}
                onShowAll={() => switchView("all")}
                onSearchAll={searchAllProjects}
                onRefresh={() => void syncTasks().catch(() => {})}
                draftIds={draftIds}
                threads={listThreads}
                creationCues={creationCues}
                projectScope={project}
                selected={selected}
                view={scope}
                activity={activity}
                sort={sort}
                hasFilters={activity !== "all"}
                onClearFilters={() => updateNavigation({ type: "clearActivity" })}
                unreadAvailable={unreadKnown}
                unreadPending={catalog.sourceInfo?.pocketRead?.available ? 0 : catalog.sourceInfo?.unread?.pending ?? 0}
                onSelect={(id, animate, origin) =>
                  void guard(async () => {
                    const creation = taskOperations.creations.find(operation => operation.threadId === id);
                    if (creation) seedCreationMessage(creation, true);
                    setPocketActivity(previous => recordPocketVisit(previous, id));
                    setSelected(id, animate, origin);
                  })
                }
                onOpen={(t) =>
                  void guard(async () => {
                    await open(t);
                  })
                }
                busy={busy}
                query={query}
                onClearQuery={() => setQuery("")}
              />}
          </TaskListPanel>
          {current ? (
            <Inspector
              feedback={feedback}
              key={`${pocketReadScope ?? ""}:${current.id}`}
              animateEntry={animateSelection}
              entryOrigin={entryOrigin}
              thread={current}
              queryDrafts={conversationDrafts.current}
              submissions={submissions}
              historyCache={conversationHistory.current}
              onNativeListObservation={taskStatuses.observeNativeHistory}
              readingCache={readingCache} readingScope={pocketReadScope} readTranscript={readTranscript} holdPrefetch={holdBackground}
              onRenamed={thread => {
                catalogReader.invalidate();
                setCatalog(c => ({ ...c, threads: c.threads.map(old => old.id === thread.id
                  ? { ...old, title: thread.title, titleRevision: thread.titleRevision } : old) }));
                notify(tr("会话已重命名"));
                refreshAfterActivity();
              }}
              onOpen={open}
              operation={currentOperation}
              operationError={currentOperation ? taskOperations.errors[currentOperation.requestId] : undefined}
              onArchive={async (thread, archived) => {
                if (taskOperations.operations.some(operation => operation.threadId === thread.id && activeOperation(operation))) return;
                await taskOperations.start(archived ? "archive" : "restore", { archived }, thread.id);
              }}
              onCheckOperation={id => void taskOperations.check(id)}
              onCancelOperation={id => void taskOperations.cancel(id)}
              onActivity={refreshAfterActivity}
              onClose={origin =>
                void guard(async () => {
                  if (selectedRef.current !== current.id) return;
                  const panel = document.querySelector<HTMLElement>(".inspector"), list = listPanel.current;
                  const parent = latestConversationStack.current.back(current.id, id => displayCatalog.threads.some(thread =>
                    thread.id === id && !thread.separator && !thread.missing && !thread.sourceExcluded && !catalog.excludedThreadIds?.includes(id)));
                  setSelected(parent, false, origin, "back");
                  if (parent) { refreshAfterActivity(); return; }
                  const revision = selectionRevision.current, returnScope = catalogScope.current;
                  if (panel && list) {
                    const controller = new AbortController(); returnFocusController.current = controller;
                    scheduleInspectorReturnFocus(panel, list, current.id, origin,
                      () => selectedRef.current === null && selectionRevision.current === revision && catalogScope.current === returnScope,
                      window, controller.signal);
                  }
                  refreshAfterActivity();
                })
              }
            />
          ) : (
            <aside className="inspector-placeholder">
              <p>{tr("选择会话，查看进展")}</p>
            </aside>
          )}
        </div>
      </main>
      {feedback.element}
      {newConversationOpen && <NewConversationDialog preferredCwd={current?.cwd || catalog.projects.find(item => item.id === project)?.paths[0]}
        closeRequested={newConversationClosing}
        initialQuery={newConversationDraft?.text} clipboardRead={newConversationDraft?.clipboardRead}
        initialName={newConversationDraft?.name} initialSelection={newConversationDraft?.selection}
        operation={taskOperations.operations.find(operation => operation.requestId === createRequestId)}
        operationError={createRequestId ? taskOperations.errors[createRequestId] : undefined}
        onCreate={startCreation}
        onCheck={() => { if (createRequestId) void taskOperations.check(createRequestId); }}
        onCancelOperation={() => { if (createRequestId) void taskOperations.cancel(createRequestId); }}
        onClose={() => {
          const focusThread = newConversationClosing ? selectedRef.current : null;
          newDialogOpen.current = false; setNewConversationClosing(false); setNewConversationOpen(false);
          if (focusThread) requestAnimationFrame(() => {
            if (selectedRef.current === focusThread && document.activeElement === document.body && !document.querySelector("dialog[open]")) {
              const panel = document.querySelector<HTMLElement>('.inspector');
              if (panel) focusInspectorEntry(panel, "programmatic");
            }
          });
        }} />}
      {settings && (
        <SettingsDialog
          appearanceActions={appearanceActions}
          logoutAction={logoutAction}
          feedbackActions={<>{feedback.settings}{feedback.enabled && feedback.button(() => { setSettings(false); void feedback.open(current?.id); })}</>}
          onClose={() => setSettings(false)}
        />
      )}
    </div>
    </TaskReferencesProvider>
  );
}
