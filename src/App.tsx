import {
  Menu,
  Search,
  RefreshCw,
  X,
  Folder,
  AlertCircle,
  ChevronLeft,
  Plus,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { SetStateAction } from "react";
import { flushSync } from "react-dom";
import { toast } from "sonner";
import Sidebar from "./Sidebar";
import ViewControls from "./ViewControls";
import TaskList from "./TaskList";
import TaskListPanel from "./TaskListPanel";
import Inspector from "./Inspector";
import BootSplash from "./BootSplash";
import type { HistoryCache } from "./conversationFeed";
import type { OpenThreadResult } from "./threadConnection";
import { SettingsDialog } from "./Dialogs";
import { api, setToken } from "./api";
import { createCatalogReader } from "./catalogReader";
import { useReloadGuard } from "./updateSafety";
import { hasUpdateBlockingDraft } from "./updateDrafts";
import PocketUpdate from "./PocketUpdate";
import { filterThreads } from "./model";
import type { Catalog, Thread, View } from "./types";
import NewConversationDialog from "./NewConversationDialog";
import { createSubmittedQueryStore, seedSubmittedQuery } from "./submittedQueries";
import { prepareCreationDialog, type CreationClipboard } from "./creationQuery";
import type { TaskOperation } from "./taskOperations";
import TaskOperationStatus from "./TaskOperationStatus";
import useTaskOperations from "./useTaskOperations";
import useTaskStatuses from "./useTaskStatuses";
import { activeOperation } from "./taskOperations";
import { createDraftMap, draftThreadIds } from "./draftIndicators";
import { preserveNewerThreadMetadata } from "./threadMetadata";
import { normalizeNavigationPrefs } from "./navigationModel";
import "./task-operations.css";
function readPrefs() {
  try {
    return normalizeNavigationPrefs(JSON.parse(localStorage.getItem("navigator.view") || "{}"));
  } catch {
    return normalizeNavigationPrefs(null);
  }
}
const catalogError = (error: Error) => ["TimeoutError", "AbortError"].includes(error.name)
  ? "读取任务较慢，保留当前列表。"
  : /failed to fetch|networkerror|load failed/i.test(error.message)
    ? "连接暂时中断，保留当前列表。"
    : error.message;
const empty: Catalog = {
  threads: [],
  groups: [],
  projects: [],
  sourceInfo: null,
  sourceError: null,
};
const titles: Record<View, string> = {
  all: "全部会话",
  unread: "待我输入",
  running: "运行中",
  pinned: "置顶",
  recent: "最近打开",
  archived: "归档",
};
export default function App({
  footerActions,
}: {
  footerActions?: React.ReactNode;
}) {
  const [prefs] = useState(readPrefs);
  const taskStatuses = useTaskStatuses();
  const [, setDraftIndicatorRevision] = useState(0);
  const [conversationDrafts] = useState(() => ({ current: createDraftMap(() => setDraftIndicatorRevision(value => value + 1)) }));
  const [submissions] = useState(createSubmittedQueryStore);
  const creationQueries = useRef(new Map<string, string>());
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
    [view, setView] = useState<View>(prefs.view),
    [selected, setSelected] = useState<string | null>(() => {
      let id = new URLSearchParams(location.search).get("task");
      try { id ||= sessionStorage.getItem("pocket.pending-task"); sessionStorage.removeItem("pocket.pending-task"); } catch {}
      return id && /^[a-f0-9-]{36}$/i.test(id) ? id : null;
    }),
    [query, setQuery] = useState(""),
    [searchOpen, setSearchOpen] = useState(false),
    [project, setProject] = useState(""),
    [sort, setSortState] = useState<string>(prefs.sort),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [readError, setReadError] = useState(""),
    [mobile, setMobile] = useState(false),
    [settings, setSettings] = useState(false),
    [newConversationOpen, setNewConversationOpen] = useState(false),
    [newConversationDraft, setNewConversationDraft] = useState<{ text: string; clipboardRead?: Promise<CreationClipboard> } | null>(null),
    [createRequestId, setCreateRequestId] = useState<string | null>(null),
    [showSeparators, setShowSeparators] = useState(
      () => localStorage.getItem("navigator.separators") === "true",
    );
  const search = useRef<HTMLInputElement>(null),
    searchToggle = useRef<HTMLButtonElement>(null),
    conversationHistory = useRef<HistoryCache>(new Map()),
    flushRef = useRef<(() => Promise<void>) | null>(null);
  const latestSort = useRef<string>(sort);
  const setSort = useCallback((value: string) => { latestSort.current = value; setSortState(value); }, []);
  const setCatalog = useCallback((update: SetStateAction<Catalog>) => {
    setCatalogState(current => preserveNewerThreadMetadata(current, typeof update === "function" ? update(current) : update));
  }, []);
  const syncing = useRef<Promise<Catalog | undefined> | null>(null);
  const createRequest = useRef<string | null>(null), newDialogOpen = useRef(false);
  useEffect(() => {
    window.dispatchEvent(new Event("pocket-reading-visibility-change"));
  }, [mobile, settings, newConversationOpen]);
  useReloadGuard(() => hasUpdateBlockingDraft(conversationDrafts.current, conversationHistory.current)
    ? "还有未完成的输入，请处理后再更新。" : busy ? "操作尚未完成，请稍后更新。" : null);
  const listPanel = useRef<HTMLElement>(null);
  const restoreScroll = useRef<number | null>(null);
  const returnView = useRef<{ view: View; project: string; query: string; searchOpen: boolean; sort: string; scrollTop: number; selected: string | null }>({
    view: "pinned", project: "", query: "", searchOpen: false, sort: "updated", scrollTop: 0, selected: null,
  });
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
  }, [view, project, query, sort]);
  const notify = useCallback((s: string) => {
    toast.success(s, { id: "pocket-feedback" });
  }, []);
  const [catalogReader] = useState(() => createCatalogReader({
    request: sync => api<Catalog>(sync ? "/api/sync" : "/api/catalog", sync ? "POST" : "GET",
      undefined, { signal: AbortSignal.timeout(15000) }),
    onData(c) { if (c.csrfToken) setToken(c.csrfToken); setCatalog(c); },
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
    setError("");
    return syncing.current.then(catalog => {
      if (catalog) notify("任务已刷新");
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
    setSelected(id); setView("all"); setProject(""); setQuery("");
    setSearchOpen(false); setMobile(false);
  };
  const seedCreationMessage = (operation: TaskOperation) => {
    const text = creationQueries.current.get(operation.requestId);
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
      const found = previous.threads.some(thread => thread.id === operation.thread!.id);
      return { ...previous, threads: found ? previous.threads.map(thread => thread.id === operation.thread!.id ? { ...thread, archived: operation.thread!.archived, missing: operation.thread!.missing } : thread)
        : [...previous.threads, operation.thread!] };
    });
    refreshAfterActivity();
    if (operation.operation === "create" && operation.threadId && newDialogOpen.current && createRequest.current === operation.requestId) {
      openCreatedThread(operation.threadId);
      newDialogOpen.current = false; setNewConversationOpen(false);
    }
  });
  useEffect(() => { taskOperations.operations.forEach(seedCreationMessage); }, [taskOperations.operations, submissions]);
  const showNewConversation = async () => {
    const prepared = await prepareCreationDialog({
      existing: taskOperations.operations.find(operation => operation.operation === "create" && activeOperation(operation)),
      getLatest: taskOperations.get,
      readText: () => navigator.clipboard.readText(),
      flush: async () => { await flushRef.current?.(); },
    });
    if (prepared.kind === "open") { seedCreationMessage(prepared.operation); openCreatedThread(prepared.threadId); return; }
    const { operation: existing, clipboardRead } = prepared;
    const existingQuery = existing ? creationQueries.current.get(existing.requestId) ??
      (existing.threadId && submissions.getThread(existing.threadId).find(entry => entry.requestId === existing.initialMessage?.requestId)?.text) : "";
    setNewConversationDraft({ text: existingQuery || "", clipboardRead });
    createRequest.current = existing?.requestId ?? null;
    setCreateRequestId(createRequest.current);
    newDialogOpen.current = true; setNewConversationOpen(true);
  };
  const startCreation = async (input: { locationId: string; name?: string; initialQuery?: string }) => {
    if (createRequest.current && activeOperation(taskOperations.operations.find(operation => operation.requestId === createRequest.current))) return;
    const requestId = crypto.randomUUID(); createRequest.current = requestId; setCreateRequestId(requestId);
    if (input.initialQuery) creationQueries.current.set(requestId, input.initialQuery);
    const result = await taskOperations.start("create", input, undefined, requestId);
    seedCreationMessage(result);
    if (result.status === "rejected") creationQueries.current.delete(requestId);
    if (result.requestId !== requestId) { createRequest.current = result.requestId; setCreateRequestId(result.requestId); }
    return result;
  };
  useEffect(() => {
    catalogReader.resume();
    const syncIfVisible = () => {
      if (document.visibilityState === "visible" && navigator.onLine !== false)
        void syncTasks(true).catch(() => {});
    };
    refresh()
      .then(catalog => { if (catalog) syncIfVisible(); })
      .catch(() => {});
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
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        if (document.querySelector("dialog[open]")) return;
        e.preventDefault();
        if (matchMedia("(max-width:760px)").matches && selected) {
          void (async () => {
            await flushRef.current?.();
            flushSync(() => setSelected(null));
            openSearch();
          })().catch(failure => setError((failure as Error).message));
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
        "navigator.view",
        JSON.stringify({ view, sort, sortVersion: 2 }),
      );
    } catch {}
  }, [view, sort]);
  const threads = useMemo(
    () =>
      filterThreads(
        catalog.threads,
        view,
        query,
        project,
        showSeparators,
        sort,
        taskStatuses.runtimeLoading || taskStatuses.runtimeUnavailable ? undefined : taskStatuses.runtimeStates,
      ),
    [catalog, view, query, project, showSeparators, sort, taskStatuses],
  );
  const current = catalog.threads.find((t) => t.id === selected);
  const currentOperation = current ? taskOperations.operations.find(operation => operation.threadId === current.id && operation.operation !== "create" && activeOperation(operation))
    || taskOperations.operations.find(operation => operation.threadId === current.id && operation.operation !== "create") : undefined;
  const title = titles[view];
  const unreadKnown = catalog.sourceInfo?.unread?.available === true;
  const unreadCount = catalog.threads.filter(t => t.needsInput && !t.archived && !t.missing && !t.separator).length;
  const runtimeKnown = !taskStatuses.runtimeLoading && !taskStatuses.runtimeUnavailable;
  const runningCount = filterThreads(catalog.threads, "running", "", "", false, "updated",
    runtimeKnown ? taskStatuses.runtimeStates : undefined).length;
  const flush = async () => {
    await flushRef.current?.();
  };
  const guard = async (action: () => Promise<void>) => {
    setError("");
    try {
      await action();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const openActivity = (target: "unread" | "running") => {
    if (view === target) return;
    void guard(async () => {
      await flush();
      if (view !== "unread" && view !== "running")
        returnView.current = { view, project, query, searchOpen, sort: latestSort.current, selected, scrollTop: listPanel.current?.scrollTop ?? 0 };
      restoreScroll.current = 0;
      setView(target);
      setProject("");
      setQuery("");
      setSearchOpen(false);
      setSort("updated");
      setSelected(null);
      setMobile(false);
      refreshAfterActivity();
    });
  };
  const returnFromActivity = () => void guard(async () => {
    await flush();
    const previous = returnView.current;
    restoreScroll.current = previous.scrollTop;
    setView(previous.view);
    setProject(previous.project);
    setQuery(previous.query);
    setSearchOpen(previous.searchOpen);
    setSort(previous.sort);
    setSelected(previous.selected);
    refreshAfterActivity();
  });
  const switchView = (v: View) => {
    if (v === "unread" || v === "running") return openActivity(v);
    if ((view === "unread" || view === "running") && v === returnView.current.view)
      return returnFromActivity();
    void guard(async () => {
      await flush();
      setView(v);
      setProject("");
      setSelected(null);
      setMobile(false);
      refreshAfterActivity();
    });
  };
  useEffect(() => {
    const fromNotification = (event: Event) => {
      const id = (event as CustomEvent<string>).detail;
      if (typeof id !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)) return;
      void guard(async () => {
        await flush();
        await syncTasks(true);
        setSelected(id);
        setMobile(false);
        try { sessionStorage.removeItem("pocket.pending-task"); } catch {}
      });
    };
    window.addEventListener("pocket-open-task", fromNotification);
    return () => window.removeEventListener("pocket-open-task", fromNotification);
  });
  const saveTask = useCallback(
    async (id: string, patch: unknown) => {
      try {
        const t = await api<Thread>(`/api/tasks/${id}`, "PATCH", patch);
        catalogReader.invalidate();
        setCatalog((c) => ({
          ...c,
          threads: c.threads.map((old) => (old.id === id ? t : old)),
        }));
        return t;
      } catch (e) {
        if ((e as Error & { status?: number }).status === 409) await refresh();
        throw e;
      }
    },
    [refresh, catalogReader],
  );
  const open = useCallback(
    async (t: Thread) => {
      const result = await api<OpenThreadResult>(`/api/open/${t.id}`, "POST");
      catalogReader.invalidate();
      setCatalog((c) => ({
        ...c,
        threads: c.threads.map((x) => (x.id === t.id ? result.thread : x)),
      }));
      notify(result.readOnly ? `已请求在 Mac 打开「${t.title}」` : result.connection?.status === "connected" ? `已连接「${t.title}」` : `正在连接「${t.title}」…`);
      return result;
    },
    [notify, catalogReader],
  );
  const pinThread = async (thread: Thread) => {
    const pinned = !thread.pinned;
    let result: Thread;
    try {
      result = await api<Thread>(`/api/tasks/${thread.id}/pin`, "POST", { pinned }, { signal: AbortSignal.timeout(15000) });
    } catch (error) {
      const status = (error as Error & { status?: number }).status;
      if (status && status < 500) throw error;
      // A lost reply may follow a committed metadata write. Only read back;
      // retrying from the row will still set an explicit boolean, never toggle.
      try {
        const fresh = await api<Catalog>("/api/catalog", "GET", undefined, { signal: AbortSignal.timeout(15000) });
        const confirmed = fresh.threads.find(item => item.id === thread.id);
        if (!confirmed || confirmed.pinned !== pinned || confirmed.pinSource !== "pocket" || !Number.isSafeInteger(confirmed.pinRevision)) throw error;
        result = confirmed;
      } catch { throw new Error("置顶结果暂未确认，请刷新列表后再试。"); }
    }
    if (result.id !== thread.id || result.pinned !== pinned || result.pinSource !== "pocket" || !Number.isSafeInteger(result.pinRevision))
      throw new Error("置顶状态尚未确认，请刷新列表后再试。");
    catalogReader.invalidate();
    setCatalog(current => ({ ...current, threads: current.threads.map(item => item.id === thread.id
      ? { ...item, pinned: result.pinned, pinnedOrder: result.pinnedOrder, pinRevision: result.pinRevision, pinSource: result.pinSource } : item) }));
    if (pinned) { setSort("pinned"); returnView.current = { ...returnView.current, sort: "pinned" }; }
    void refresh().catch(() => {});
  };
  if (loading) return <BootSplash />;
  return (
    <div className="app-shell">
      <Sidebar
        showSeparators={showSeparators}
        catalog={catalog}
        view={view}
        mobileOpen={mobile}
        onClose={() => setMobile(false)}
        onView={switchView}
        onSettings={() => setSettings(true)}
      />
      <main className={`workspace ${current ? "with-inspector" : ""}`} inert={narrow && mobile}>
        <header className="workspace-header" inert={narrow && !!current}>
          <PocketUpdate taskId={selected} />
          <div className="heading-line">
            <button
              className="icon-button mobile-only"
              onClick={() => setMobile(true)}
              aria-label="打开导航"
            >
              <Menu size={20} />
            </button>
            <div className="heading">
              <h1>
                {title}
                <span>{view === "unread" && !unreadKnown || view === "running" && !runtimeKnown ? "—" : threads.length}</span>
              </h1>
            </div>
            <button
              className="new-conversation-button"
              aria-label="新建会话"
              onClick={() => void guard(showNewConversation)}
            >
              <Plus size={16} /><span>新建会话</span>
            </button>
            <button
              className={`sync-button ${busy ? "spinning" : ""}`}
              onClick={() => { void syncTasks().catch(() => {}); }}
              disabled={busy || loading}
              aria-label="刷新任务"
            >
              <RefreshCw size={16} />
              <span>同步</span>
            </button>
          </div>
          <div className="filter-row">
            <div className="activity-filters">
            <button className="needs-input-toggle" data-inbox={view === "unread"} onClick={view === "unread" ? returnFromActivity : () => openActivity("unread")}
              title={view === "unread" ? "返回之前的列表、搜索与位置" : "查看所有项目的待输入任务"}>
              {view === "unread" ? <ChevronLeft size={16} aria-hidden="true" /> : <span className="unread-dot" aria-hidden="true" />}
              <span>{view === "unread" ? "返回列表" : "待我输入"}</span>
              {view !== "unread" && <small>{unreadKnown ? unreadCount : "—"}</small>}
            </button>
            <button className="needs-input-toggle running-toggle" data-inbox={view === "running"} aria-pressed={view === "running"}
              title={view === "running" ? "返回之前的列表、搜索与位置" : "查看所有项目中已确认运行的任务"}
              onClick={view === "running" ? returnFromActivity : () => openActivity("running")}>
              <span className="running-dot" aria-hidden="true" />
              <span>运行中</span><small>{runtimeKnown ? runningCount : "—"}</small>
            </button>
            </div>
            <div className="list-controls">
              <button
                ref={searchToggle}
                className="icon-button search-toggle"
                aria-label={searchOpen ? "收起搜索" : "展开搜索"}
                aria-expanded={searchOpen}
                aria-controls="task-search-box"
                aria-keyshortcuts="Control+K Meta+K"
                onClick={searchOpen ? closeSearch : openSearch}
              >
                <Search size={17} /><span>搜索</span><kbd aria-hidden="true">⌘ K</kbd>
              </button>
              <ViewControls projects={catalog.projects} project={project} sort={sort}
                onProject={setProject}
                onSort={setSort} />
            </div>
          </div>
          {project && <div className="active-filters" aria-label="已应用的筛选">
            <button onClick={() => setProject("")} aria-label="清除来源项目筛选">
              <Folder size={13} aria-hidden="true" />{catalog.projects.find(item => item.id === project)?.name || "来源项目"}<X size={13} aria-hidden="true" />
            </button>
          </div>}
          {searchOpen && <div className="search-box expanded-search" id="task-search-box">
            <input
              ref={search}
              aria-label="搜索任务"
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
            <button className="icon-button" onClick={closeSearch} aria-label="清除并收起搜索">
              <X size={17} />
            </button>
          </div>}
          {searchOpen && <p id="task-search-help" className="sr-only">在当前视图内搜索标题、项目、目录和接续说明。</p>}
        </header>
        {(error || readError || catalog.sourceError) && (
          <div className="error-banner" role="alert">
            <AlertCircle size={17} />
            <span>
              {error || readError ||
                `原版暂时无法读取，保留上次同步结果。${catalog.sourceError}`}
            </span>
            <button
              className="icon-button"
              aria-label={error ? "关闭提示" : readError ? "重新读取任务" : "重新读取来源"}
              disabled={!error && busy}
              onClick={() => {
                if (error) setError("");
                else void syncTasks().catch(() => {});
              }}
            >
              {error ? <X size={15} /> : <RefreshCw size={15} />}
            </button>
          </div>
        )}
        {taskOperations.notices.length > 0 && <div className="task-operation-notices" aria-label="会话操作状态">
            {taskOperations.notices.map(operation => <TaskOperationStatus key={operation.requestId} operation={operation}
              autoDismissEnabled={!(narrow && (mobile || !!current))}
              title={operation.threadId ? catalog.threads.find(thread => thread.id === operation.threadId)?.title : undefined}
              error={taskOperations.errors[operation.requestId]}
              onCheck={() => void taskOperations.check(operation.requestId)} onCancel={() => void taskOperations.cancel(operation.requestId)}
              onOpen={operation.threadId ? () => void guard(async () => {
                await flush();
                if (activeOperation(operation)) await syncTasks(true);
                seedCreationMessage(operation);
                openCreatedThread(operation.threadId!);
                if (!activeOperation(operation)) taskOperations.dismiss(operation.requestId);
              }) : undefined}
              onDismiss={() => taskOperations.dismiss(operation.requestId)} />)}
        </div>}
        <div className="content">
          <TaskListPanel busy={busy || loading} onRefresh={syncTasks} scrollRef={listPanel} inert={narrow && !!current}>
              <TaskList
                onPin={pinThread}
                runtimeStates={taskStatuses.runtimeStates}
                runtimeUnavailable={taskStatuses.runtimeUnavailable}
                runtimeLoading={taskStatuses.runtimeLoading}
                onCreate={() => void guard(showNewConversation)}
                onShowAll={() => switchView("all")}
                onRefresh={() => void syncTasks().catch(() => {})}
                onClearFilters={() => { setQuery(""); setProject(""); }}
                hasFilters={!!(query.trim() || project)}
                draftIds={draftThreadIds(conversationDrafts.current)}
                threads={threads}
                projectScope={project}
                selected={selected}
                view={view}
                unreadAvailable={unreadKnown}
                unreadPending={catalog.sourceInfo?.unread?.pending ?? 0}
                onSelect={(id) =>
                  void guard(async () => {
                    await flush();
                    setSelected(id);
                  })
                }
                onOpen={(t) =>
                  void guard(async () => {
                    await flush();
                    await open(t);
                  })
                }
                busy={busy}
                query={query}
                onClearQuery={() => setQuery("")}
              />
          </TaskListPanel>
          {current ? (
            <Inspector
              key={current.id}
              thread={current}
              queryDrafts={conversationDrafts.current}
              submissions={submissions}
              historyCache={conversationHistory.current}
              onSave={saveTask}
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
                  await flush();
                  setSelected(null);
                  requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(`.task-select[data-thread-id="${current.id}"]`)?.focus({ preventScroll: true }));
                  refreshAfterActivity();
                })
              }
              flushRef={flushRef}
              onToast={notify}
            />
          ) : (
            <aside className="inspector-placeholder">
              <p>选择会话，查看进展</p>
            </aside>
          )}
        </div>
      </main>
      {newConversationOpen && <NewConversationDialog preferredCwd={current?.cwd || catalog.projects.find(item => item.id === project)?.paths[0]}
        initialQuery={newConversationDraft?.text} clipboardRead={newConversationDraft?.clipboardRead}
        operation={taskOperations.operations.find(operation => operation.requestId === createRequestId)}
        operationError={createRequestId ? taskOperations.errors[createRequestId] : undefined}
        onCreate={startCreation}
        onCheck={() => { if (createRequestId) void taskOperations.check(createRequestId); }}
        onCancelOperation={() => { if (createRequestId) void taskOperations.cancel(createRequestId); }}
        onClose={() => { newDialogOpen.current = false; setNewConversationOpen(false); }} />}
      {settings && (
        <SettingsDialog
          accountActions={footerActions}
          catalog={catalog}
          showSeparators={showSeparators}
          onSeparators={(b) => {
            setShowSeparators(b);
            localStorage.setItem("navigator.separators", String(b));
          }}
          onClose={() => setSettings(false)}
          onImport={async (data) => {
            await flush();
            const c = await api<Catalog>("/api/import", "POST", data);
            catalogReader.invalidate();
            setCatalog(c);
            setSelected(null);
            setView("all");
            notify("整理数据已恢复");
          }}
        />
      )}
    </div>
  );
}
