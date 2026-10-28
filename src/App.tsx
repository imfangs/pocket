import { IconButton } from "./ui/IconButton";
import { Button } from "./ui/Button";
import {
  Menu,
  Search,
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
import CollectionReadFeedback from "./CollectionReadFeedback";
import Inspector from "./Inspector";
import BootSplash from "./BootSplash";
import type { HistoryCache } from "./conversationFeed";
import type { OpenThreadResult } from "./threadConnection";
import { SettingsDialog } from "./Dialogs";
import { api, setToken, clearReadResponses } from "./api";
import { CatalogSourceError, createCatalogReader } from "./catalogReader";
import { startRecentThreadCatalogSync } from "./recentThreadCatalog";
import { useReloadGuard } from "./updateSafety";
import { hasUpdateBlockingDraft, protectedDraftThreadIds } from "./updateDrafts";
import PocketUpdate from "./PocketUpdate";
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
import { focusInspectorEntry, inspectorEntryFromClick, type InspectorEntryOrigin } from "./inspectorFocus";
import { machineStorageKey, currentMachineId } from "./machineScope";
import { createReadingCache, readingCatalogScope, type ReadingCache } from "./readingCache";
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
      try { id ||= sessionStorage.getItem(machineStorageKey("pocket.pending-task")); sessionStorage.removeItem(machineStorageKey("pocket.pending-task")); } catch {}
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
  const taskStatuses = useTaskStatuses({ threads: catalog.threads, activity: pocketActivity,
    selectedId: selected, excludedThreadIds: catalog.excludedThreadIds });
  const selectedRef = useRef(selected);
  const [animateSelection, setAnimateSelection] = useState(false);
  const [entryOrigin, setEntryOrigin] = useState<InspectorEntryOrigin>("programmatic");
  const [newConversationClosing, setNewConversationClosing] = useState(false);
  const setSelected = useCallback((id: string | null, animate = false, origin: InspectorEntryOrigin = "programmatic") => {
    selectedRef.current = id;
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
  const [readingCache, setReadingCache] = useState<ReadingCache | null>(null);
  const [catalogFromDisk, setCatalogFromDisk] = useState(false);
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
    toast.success(s, { id: "pocket-feedback" });
  }, []);
  const [catalogReader] = useState(() => createCatalogReader({
    request: sync => api<Catalog>(sync ? "/api/sync" : "/api/catalog", sync ? "POST" : "GET",
      undefined, { signal: AbortSignal.timeout(15000) }),
    onData(c) {
      if (c.csrfToken) setToken(c.csrfToken);
      const scope = readingCatalogScope(c);
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
    onSettled(error) { setLoading(false); setReadError(error ? catalogError(error) : ""); },
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
    if (operation.status !== "rejected" || operation.creationStatus || !window.confirm("放弃本次新建并清除保留的输入？")) return;
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
  const readRevision = useSyncExternalStore(pocketReadState.subscribe, pocketReadState.getSnapshot, pocketReadState.getSnapshot);
  const pocketReadScope = catalog.sourceInfo?.pocketRead?.scope;
  useLayoutEffect(() => { if (!catalogFromDisk) pocketReadState.observeCatalog(catalog.threads, pocketReadScope); }, [catalog.threads, pocketReadScope, catalogFromDisk]);
  const displayCatalog = useMemo(() => ({ ...catalog, threads: catalog.threads.map(thread => {
    const unread = pocketReadState.unread(thread);
    if (typeof unread === "boolean") return { ...thread, pocketUnread: unread };
    if (Object.hasOwn(thread, "pocketUnread")) {
      const { pocketUnread: _ignored, ...original } = thread;
      return original;
    }
    return thread;
  }) }), [catalog, readRevision]);
  const runtimeKnown = !taskStatuses.runtimeLoading && !taskStatuses.runtimeUnavailable;
  const runtimeStates = runtimeKnown ? taskStatuses.runtimeStates : undefined;
  const draftIds = useMemo(() => draftThreadIds(conversationDrafts.current), [conversationDrafts, draftIndicatorRevision]);
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
        runtimeStates,
        { now: rankingTime, draftIds, pocketActivity },
        activity,
      ),
    [displayCatalog, scope, activity, sort, query, project, runtimeStates, rankingTime, draftIds, pocketActivity],
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
      title: thread?.title || preview || operation.thread?.title || "新会话",
      projectName: thread?.projectName || saved?.location?.projectName || operation.thread?.projectName,
      startedAt: saved?.startedAt ?? operation.createdAt ?? 0,
      canOpen: !!operation.threadId && !!(thread || operation.thread) && (operation.status === "succeeded" || operation.creationStatus === "created") }];
  }).sort((a, b) => b.startedAt - a.startedAt);
  const creationCues = new Map<string, CreationCue>(creationRows.flatMap(row => row.thread ? [[row.thread.id, row.cue] as const] : []));
  const showCreationArrival = scope === "all" && !project && activity === "all" && !query.trim();
  const pendingCreationRows = showCreationArrival ? creationRows.filter(row => !row.thread) : [];
  const promotedThreads = showCreationArrival ? creationRows.flatMap(row => row.thread ? [row.thread] : []) : [];
  const promotedIds = new Set(promotedThreads.map(thread => thread.id));
  const listThreads = [...promotedThreads, ...threads.filter(thread => !promotedIds.has(thread.id))];
  const creationNoticeKey = (operation: TaskOperation) => JSON.stringify([operation.requestId, operation.status,
    operation.initialMessage?.status, taskOperations.errors[operation.requestId]]);
  const operationNotices = taskOperations.notices.filter(operation => operation.operation !== "create" ||
    creationNeedsAttention(operation, taskOperations.errors[operation.requestId]) && !hiddenCreationNotices.has(creationNoticeKey(operation)));
  const current = displayCatalog.threads.find((t) => t.id === selected);
  const protectedDraftIds = protectedDraftThreadIds(conversationDrafts.current, conversationHistory.current);
  const retainedInputThreads = catalog.threads.filter(thread => thread.sourceExcluded &&
    (protectedDraftIds.has(thread.id) || visibleSubmittedQueries(submissions.getThread(thread.id), [], []).length > 0));
  const currentOperation = current ? taskOperations.operations.find(operation => operation.threadId === current.id && operation.operation !== "create" && activeOperation(operation))
    || taskOperations.operations.find(operation => operation.threadId === current.id && operation.operation !== "create") : undefined;
  const title = navigationTitle(navigation, catalog.projects);
  const unreadKnown = catalog.sourceInfo?.pocketRead?.available === true || catalog.sourceInfo?.unread?.available === true;
  const hasCatalog = catalogLoaded || catalog.threads.length > 0;
  const catalogReadError = catalogReading ? "" : readError || (catalog.sourceError ? "暂时无法更新，请稍后重试。" : "");
  const { unread: unreadCount, running: runningCount } = navigationActivityCounts(displayCatalog.threads, navigation, query, runtimeStates);
  const guard = async (action: () => Promise<void>) => {
    setError("");
    try {
      await action();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const updateNavigation = (change: NavigationChange, clearSearch = false) => void guard(async () => {
    restoreScroll.current = 0;
    setNavigation(previous => changeNavigation(previous, change));
    if (clearSearch) { setQuery(""); setSearchOpen(false); }
    setSelected(null);
    setMobile(false);
    refreshAfterActivity();
  });
  const switchView = (view: View) => {
    if (view === "all" || view === "priority" || view === "codex-pinned" || view === "archived")
      updateNavigation({ type: "scope", scope: view }, true);
  };
  const switchProject = (id: string) => updateNavigation({ type: "project", project: id }, true);
  const searchAllProjects = () => {
    updateNavigation({ type: "scope", scope: "all" });
    setSearchOpen(true);
  };
  useEffect(() => {
    const fromNotification = (event: Event) => {
      const id = (event as CustomEvent<string>).detail;
      if (typeof id !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)) return;
      void guard(async () => {
        await syncTasks(true);
        setSelected(id);
        setMobile(false);
        try { sessionStorage.removeItem(machineStorageKey("pocket.pending-task")); } catch {}
      });
    };
    window.addEventListener("pocket-open-task", fromNotification);
    return () => window.removeEventListener("pocket-open-task", fromNotification);
  });
  const open = useCallback(
    async (t: Thread, options?: { quiet?: boolean }) => {
      const result = await api<OpenThreadResult>(`/api/open/${t.id}`, "POST");
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
  if (loading && !hasCatalog) return <BootSplash />;
  return (
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
              aria-label="打开导航"
            >
              <Menu size={20} />
            </IconButton>
            <div className="heading">
              <h1 title={title}>
                <span className="workspace-title">{title}</span>
                <span className="workspace-count">{!hasCatalog || activity === "unread" && !unreadKnown || activity === "running" && !runtimeKnown ? "—" : listThreads.length + pendingCreationRows.length}</span>
              </h1>
            </div>
            <Button variant="soft" color="gray" type="button"
              className="new-conversation-button"
              aria-label="新建会话"
              onClick={() => void guard(showNewConversation)}
            >
              <Plus size={16} /><span>新建会话</span>
            </Button>
            <button
              className={`sync-button ${busy ? "spinning" : ""}`}
              onClick={() => { void syncTasks().catch(() => {}); }}
              disabled={busy || loading}
              aria-label="刷新会话"
            >
              <RefreshCw size={16} />
              <span>同步</span>
            </button>
          </div>
          <div className="filter-row">
            <div className="activity-filters">
              {scope !== "archived" && ([
                { activity: "unread", label: "未读", count: unreadKnown ? unreadCount : "—" },
                { activity: "running", label: "运行中", count: runtimeKnown ? runningCount : "—" },
              ] as const).map(filter => (
                <button key={filter.activity} className={`needs-input-toggle ${filter.activity}-toggle`}
                  data-inbox={activity === filter.activity} aria-pressed={activity === filter.activity}
                  title={activity === filter.activity ? `取消${filter.label}筛选` : `查看${filter.label}的会话`}
                  onClick={() => updateNavigation({ type: "activity", activity: filter.activity })}>
                  <span className={`${filter.activity}-dot`} aria-hidden="true" />
                  <span>{filter.label}</span><small>{filter.count}</small>
                </button>
              ))}
              {scope !== "archived" && <button className="needs-input-toggle priority-toggle"
                data-inbox={scope === "priority"} aria-pressed={scope === "priority"}
                title={scope === "priority" ? `返回${navigationTitle(navigation.priorityReturn || { scope: "all", project: "" }, catalog.projects)}` : "查看 Pocket 关注的会话"}
                onClick={() => updateNavigation({ type: "togglePriority" })}>
                <Star size={15} aria-hidden="true" /><span>关注</span>
              </button>}
              <div className="thread-sort-controls" role="group" aria-label="会话排序">
                {([
                  { sort: "created", label: "创建", title: "按创建时间从新到旧排列" },
                  { sort: "activity", label: "活动", title: "按最后消息时间从新到旧排列" },
                ] as const).map(option => (
                  <button key={option.sort} className={`needs-input-toggle ${option.sort}-toggle`}
                    data-inbox={sort === option.sort} aria-pressed={sort === option.sort}
                    title={sort === option.sort ? "恢复智能排序" : option.title}
                    onClick={() => updateNavigation({ type: "sort", sort: option.sort })}>
                    <span>{option.label}</span>
                  </button>
                ))}
              </div>
            </div>
            <div className="list-controls">
              <IconButton type="button"
                ref={searchToggle}
                className="icon-button search-toggle"
                aria-label={searchOpen ? "收起搜索" : "展开搜索"}
                aria-expanded={searchOpen}
                aria-controls="task-search-box"
                aria-keyshortcuts="Control+K Meta+K"
                onClick={searchOpen ? closeSearch : openSearch}
              >
                <Search size={17} /><span>搜索</span><kbd aria-hidden="true">⌘ K</kbd>
              </IconButton>
            </div>
          </div>
          {searchOpen && <div className="search-box expanded-search" id="task-search-box">
            <input
              ref={search}
              aria-label="搜索会话"
              placeholder={`搜索${title}…`}
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
            <IconButton type="button" className="icon-button" onClick={closeSearch} aria-label="清除并收起搜索">
              <X size={17} />
            </IconButton>
          </div>}
          {searchOpen && <p id="task-search-help" className="sr-only">在当前视图内搜索标题、项目和目录。</p>}
        </header>
        {error && (
          <div className="error-banner" role="alert">
            <AlertCircle size={17} />
            <span>
              {error}
            </span>
            <IconButton type="button"
              className="icon-button"
              aria-label="关闭提示"
              onClick={() => setError("")}
            >
              <X size={15} />
            </IconButton>
          </div>
        )}
        {operationNotices.length > 0 && <div className="task-operation-notices" aria-label="会话操作状态">
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
              error={catalogReadError} retry={() => void syncTasks().catch(() => {})} />}>
              {retainedInputThreads.length > 0 && <section className="retained-inputs" aria-label="保留的输入">
                <p>保留的输入</p>
                {retainedInputThreads.map(thread => <button key={thread.id} aria-label={`继续输入：${thread.title}`}
                  onClick={event => setSelected(thread.id, event.detail !== 0, inspectorEntryFromClick(event))}>
                  <span>{thread.title}</span><small>继续处理</small>
                </button>)}
              </section>}
              <CreationPendingRows items={pendingCreationRows} onOpen={operation => void guard(() => openCreation(operation))} onReview={reviewCreation} />
              {hasCatalog && (listThreads.length > 0 || !pendingCreationRows.length) && <TaskList
                onPriority={prioritizeThread}
                runtimeStates={taskStatuses.runtimeStates}
                runtimeUnavailable={taskStatuses.runtimeUnavailable}
                runtimeLoading={taskStatuses.runtimeLoading}
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
              key={`${pocketReadScope ?? ""}:${current.id}`}
              animateEntry={animateSelection}
              entryOrigin={entryOrigin}
              thread={current}
              queryDrafts={conversationDrafts.current}
              submissions={submissions}
              historyCache={conversationHistory.current}
              readingCache={readingCache} readingScope={pocketReadScope}
              onRenamed={thread => {
                catalogReader.invalidate();
                setCatalog(c => ({ ...c, threads: c.threads.map(old => old.id === thread.id
                  ? { ...old, title: thread.title, titleRevision: thread.titleRevision } : old) }));
                notify("会话已重命名");
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
              onClose={() =>
                void guard(async () => {
                  setSelected(null);
                  requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(`.task-select[data-thread-id="${current.id}"]`)?.focus({ preventScroll: true }));
                  refreshAfterActivity();
                })
              }
            />
          ) : (
            <aside className="inspector-placeholder">
              <p>选择会话，查看进展</p>
            </aside>
          )}
        </div>
      </main>
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
          onClose={() => setSettings(false)}
        />
      )}
    </div>
  );
}
