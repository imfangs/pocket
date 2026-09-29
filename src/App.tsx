import {
  Menu,
  Search,
  RefreshCw,
  ArrowDownWideNarrow,
  X,
  ArrowUpRight,
  PanelRightOpen,
  Folder,
  AlertCircle,
  ChevronLeft,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { toast } from "sonner";
import Sidebar from "./Sidebar";
import TaskList from "./TaskList";
import TaskListPanel from "./TaskListPanel";
import Inspector from "./Inspector";
import BootSplash from "./BootSplash";
import type { QueryDraft } from "./Conversation";
import type { HistoryCache } from "./conversationFeed";
import { GroupDialog, SettingsDialog } from "./Dialogs";
import { api, setToken } from "./api";
import { filterThreads, groupPath } from "./model";
import type { Catalog, Group, Thread, View } from "./types";
function readPrefs() {
  try {
    return JSON.parse(localStorage.getItem("navigator.view") || "{}");
  } catch {
    return {};
  }
}
const catalogError = (error: Error) => ["TimeoutError", "AbortError"].includes(error.name) ? "读取任务较慢，请刷新重试。" : error.message;
const empty: Catalog = {
  threads: [],
  groups: [],
  projects: [],
  sourceInfo: null,
  sourceError: null,
};
const titles: Record<View, string> = {
  all: "全部任务",
  unread: "待我输入",
  pinned: "置顶",
  active: "正在推进",
  later: "稍后继续",
  reference: "留作参考",
  recent: "最近打开",
  archived: "归档",
  unassigned: "未分组",
  group: "",
};
export default function App({
  footerActions,
}: {
  footerActions?: React.ReactNode;
}) {
  const [prefs] = useState(readPrefs);
  const [catalog, setCatalog] = useState<Catalog>(empty),
    [loading, setLoading] = useState(true),
    [view, setView] = useState<View>(
      Object.keys(titles).includes(prefs.view) ? prefs.view : "pinned",
    ),
    [groupId, setGroupId] = useState<string | null>(
      typeof prefs.groupId === "string" ? prefs.groupId : null,
    ),
    [selected, setSelected] = useState<string | null>(() => {
      let id = new URLSearchParams(location.search).get("task");
      try { id ||= sessionStorage.getItem("pocket.pending-task"); sessionStorage.removeItem("pocket.pending-task"); } catch {}
      return id && /^[a-f0-9-]{36}$/i.test(id) ? id : null;
    }),
    [query, setQuery] = useState(""),
    [searchOpen, setSearchOpen] = useState(false),
    [project, setProject] = useState(""),
    [sort, setSort] = useState(
      prefs.sortVersion === 2 &&
        ["pinned", "updated"].includes(prefs.sort)
        ? prefs.sort
        : "updated",
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [mobile, setMobile] = useState(false),
    [checked, setChecked] = useState<Set<string>>(new Set()),
    [groupDialog, setGroupDialog] = useState<Group | null | undefined>(
      undefined,
    ),
    [settings, setSettings] = useState(false),
    [showSeparators, setShowSeparators] = useState(
      () => localStorage.getItem("navigator.separators") === "true",
    );
  const search = useRef<HTMLInputElement>(null),
    searchToggle = useRef<HTMLButtonElement>(null),
    conversationDrafts = useRef(new Map<string, QueryDraft>()),
    conversationHistory = useRef<HistoryCache>(new Map()),
    flushRef = useRef<(() => Promise<void>) | null>(null);
  const syncing = useRef<Promise<void> | null>(null);
  const listPanel = useRef<HTMLElement>(null);
  const restoreScroll = useRef<number | null>(null);
  const returnView = useRef<{ view: View; groupId: string | null; project: string; query: string; searchOpen: boolean; sort: string; scrollTop: number; selected: string | null }>({
    view: "pinned", groupId: null, project: "", query: "", searchOpen: false, sort: "updated", scrollTop: 0, selected: null,
  });
  const openSearch = useCallback(() => {
    // Focus during the tap so iOS opens the keyboard on the first interaction.
    flushSync(() => setSearchOpen(true));
    search.current?.focus();
  }, []);
  const closeSearch = useCallback(() => {
    setQuery("");
    setChecked(new Set());
    setSearchOpen(false);
    searchToggle.current?.focus();
  }, []);
  useLayoutEffect(() => {
    if (restoreScroll.current === null || !listPanel.current) return;
    listPanel.current.scrollTop = restoreScroll.current;
    restoreScroll.current = null;
  }, [view, groupId, project, query, sort]);
  const notify = useCallback((s: string) => {
    toast.success(s, { id: "pocket-feedback" });
  }, []);
  const refresh = useCallback(async (sync = false) => {
    const c = await api<Catalog>(
      sync ? "/api/sync" : "/api/catalog",
      sync ? "POST" : "GET",
      undefined,
      { signal: AbortSignal.timeout(15000) },
    );
    if (c.csrfToken) setToken(c.csrfToken);
    setCatalog(c);
    return c;
  }, []);
  const syncTasks = useCallback((silent = false) => {
    if (!syncing.current) {
      const operation = refresh(true).then(() => {}).finally(() => {
        if (syncing.current === operation) syncing.current = null;
      });
      syncing.current = operation;
    }
    if (silent) return syncing.current;
    setBusy(true);
    setError("");
    return syncing.current.then(() => {
      notify("任务已刷新");
    }).catch((error: Error) => {
      setError(catalogError(error));
      throw error;
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
  useEffect(() => {
    const syncIfVisible = () => {
      if (document.visibilityState === "visible" && navigator.onLine !== false)
        void syncTasks(true).catch(() => {});
    };
    refresh()
      .then(syncIfVisible)
      .catch((e) => setError(catalogError(e)))
      .finally(() => setLoading(false));
    const timer = setInterval(syncIfVisible, 45000);
    document.addEventListener("visibilitychange", syncIfVisible);
    window.addEventListener("online", syncIfVisible);
    window.addEventListener("pageshow", syncIfVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", syncIfVisible);
      window.removeEventListener("online", syncIfVisible);
      window.removeEventListener("pageshow", syncIfVisible);
    };
  }, [refresh, syncTasks]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        if (document.querySelector("dialog[open]")) return;
        e.preventDefault();
        openSearch();
      }
      if (e.key === "Escape" && !document.querySelector("dialog[open]"))
        setMobile(false);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [openSearch]);
  useEffect(() => {
    try {
      localStorage.setItem(
        "navigator.view",
        JSON.stringify({ view, groupId, sort, sortVersion: 2 }),
      );
    } catch {}
  }, [view, groupId, sort]);
  useEffect(() => {
    if (
      !loading &&
      view === "group" &&
      !catalog.groups.some((g) => g.id === groupId)
    ) {
      setView("all");
      setGroupId(null);
    }
  }, [loading, catalog.groups, view, groupId]);
  const threads = useMemo(
    () =>
      filterThreads(
        catalog.threads,
        catalog.groups,
        view,
        groupId,
        query,
        project,
        showSeparators,
        sort,
      ),
    [catalog, view, groupId, query, project, showSeparators, sort],
  );
  const current = catalog.threads.find((t) => t.id === selected);
  const selectedGroup = catalog.groups.find((g) => g.id === groupId);
  const title = view === "group" ? selectedGroup?.name || "分组" : titles[view];
  const unreadKnown = catalog.sourceInfo?.unread?.available === true;
  const unreadCount = catalog.threads.filter(t => t.needsInput && !t.archived && !t.missing && !t.separator).length;
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
  const openUnread = () => {
    if (view === "unread") return;
    void guard(async () => {
      await flush();
      returnView.current = { view, groupId, project, query, searchOpen, sort, selected, scrollTop: listPanel.current?.scrollTop ?? 0 };
      restoreScroll.current = 0;
      setView("unread");
      setGroupId(null);
      setProject("");
      setQuery("");
      setSearchOpen(false);
      setSort("updated");
      setSelected(null);
      setChecked(new Set());
      setMobile(false);
      refreshAfterActivity();
    });
  };
  const returnFromUnread = () => void guard(async () => {
    await flush();
    const previous = returnView.current;
    restoreScroll.current = previous.scrollTop;
    setView(previous.view);
    setGroupId(previous.groupId);
    setProject(previous.project);
    setQuery(previous.query);
    setSearchOpen(previous.searchOpen);
    setSort(previous.sort);
    setSelected(previous.selected);
    setChecked(new Set());
    refreshAfterActivity();
  });
  const switchView = (v: View, id?: string) => {
    if (v === "unread") return openUnread();
    if (view === "unread" && v === returnView.current.view && (id || null) === returnView.current.groupId)
      return returnFromUnread();
    void guard(async () => {
      await flush();
      setView(v);
      setGroupId(id || null);
      setProject("");
      setChecked(new Set());
      setSelected(null);
      setMobile(false);
      refreshAfterActivity();
    });
  };
  useEffect(() => {
    const fromNotification = (event: Event) => {
      const id = (event as CustomEvent<string>).detail;
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
    [refresh],
  );
  const open = useCallback(
    async (t: Thread) => {
      const result = await api<{ thread: Thread }>(`/api/open/${t.id}`, "POST");
      setCatalog((c) => ({
        ...c,
        threads: c.threads.map((x) => (x.id === t.id ? result.thread : x)),
      }));
      notify("已请求在 Codex 打开原会话");
    },
    [notify],
  );
  const batch = async (
    ids: string[],
    change: { intent?: string; groupId?: string },
  ) => {
    setBusy(true);
    try {
      await flush();
      const c = await api<Catalog>("/api/batch", "POST", { ids, change });
      setCatalog(c);
      setChecked(new Set());
      notify(
        change.groupId
          ? `已将 ${ids.length} 条任务加入分组`
          : `已将 ${ids.length} 条任务放到稍后继续`,
      );
    } finally {
      setBusy(false);
    }
  };
  if (loading) return <BootSplash />;
  return (
    <div className="app-shell">
      <Sidebar
        footerActions={footerActions}
        catalog={catalog}
        view={view}
        groupId={groupId}
        mobileOpen={mobile}
        onClose={() => setMobile(false)}
        onView={switchView}
        onGroup={(g) => setGroupDialog(g || null)}
        onDrop={(id, g) => void guard(() => batch([id], { groupId: g }))}
        onSettings={() => setSettings(true)}
      />
      <main className={`workspace ${current ? "with-inspector" : ""}`}>
        <header className="workspace-header">
          <div className="heading-line">
            <button
              className="icon-button mobile-only"
              onClick={() => setMobile(true)}
              aria-label="打开导航"
            >
              <Menu size={20} />
            </button>
            <div className="heading">
              <div className="breadcrumb">
                Pocket
                {view === "group" && selectedGroup?.parentId && (
                  <>
                    <span>/</span>
                    {groupPath(catalog.groups, selectedGroup.parentId)}
                  </>
                )}
              </div>
              <h1>
                {title}
                <span>{view === "unread" && !unreadKnown ? "—" : threads.length}</span>
              </h1>
            </div>
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
            <button className="needs-input-toggle" data-inbox={view === "unread"} onClick={view === "unread" ? returnFromUnread : openUnread}
              title={view === "unread" ? "返回之前的列表、搜索与位置" : "查看所有项目的待输入任务"}>
              {view === "unread" ? <ChevronLeft size={16} aria-hidden="true" /> : <span className="unread-dot" aria-hidden="true" />}
              <span>{view === "unread" ? "返回列表" : "待我输入"}</span>
              {view !== "unread" && <small>{unreadKnown ? unreadCount : "—"}</small>}
            </button>
            <div className="list-controls">
              <select
                className="project-filter"
                aria-label="筛选来源项目"
                value={project}
                onChange={(e) => setProject(e.target.value)}
              >
                <option value="">所有来源项目</option>
                {catalog.projects
                  .filter((p) => !p.separator)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
              </select>
              <label className="sort-control">
                <ArrowDownWideNarrow size={16} />
                <select
                  aria-label="排序方式"
                  value={sort}
                  onChange={(e) => setSort(e.target.value)}
                >
                  <option value="pinned">置顶优先</option>
                  <option value="updated">最近活动</option>
                </select>
              </label>
              <button
                ref={searchToggle}
                className="icon-button search-toggle"
                aria-label={searchOpen ? "收起搜索" : "展开搜索"}
                aria-expanded={searchOpen}
                aria-controls="task-search-box"
                aria-keyshortcuts="Control+K Meta+K"
                onClick={searchOpen ? closeSearch : openSearch}
              >
                <Search size={20} />
              </button>
            </div>
          </div>
          {searchOpen && <div className="search-box expanded-search" id="task-search-box">
            <Search size={17} aria-hidden="true" />
            <input
              ref={search}
              aria-label="搜索任务"
              inputMode="search"
              enterKeyHint="search"
              autoComplete="off"
              value={query}
              onChange={(e) => { setQuery(e.target.value); setChecked(new Set()); }}
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
        </header>
        {(error || catalog.sourceError) && (
          <div className="error-banner" role="alert">
            <AlertCircle size={17} />
            <span>
              {error ||
                `原版暂时无法读取，保留上次同步结果。${catalog.sourceError}`}
            </span>
            <button
              className="icon-button"
              aria-label={error ? "关闭提示" : "重新读取来源"}
              onClick={() => {
                if (error) setError("");
                else
                  void guard(async () => {
                    await refresh(true);
                  });
              }}
            >
              {error ? <X size={15} /> : <RefreshCw size={15} />}
            </button>
          </div>
        )}
        <div className="content">
          <TaskListPanel busy={busy || loading} onRefresh={syncTasks} scrollRef={listPanel}>
              <TaskList
                threads={threads}
                groups={catalog.groups}
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
                checked={checked}
                onCheck={(id) =>
                  setChecked((old) => {
                    const n = new Set(old);
                    n.has(id) ? n.delete(id) : n.add(id);
                    return n;
                  })
                }
                onCheckAll={() =>
                  setChecked(
                    threads.every((t) => checked.has(t.id))
                      ? new Set()
                      : new Set(threads.map((t) => t.id)),
                  )
                }
                onBatch={(change) =>
                  void guard(() => batch([...checked], change))
                }
                onClear={() => setChecked(new Set())}
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
              historyCache={conversationHistory.current}
              groups={catalog.groups}
              onSave={saveTask}
              onOpen={open}
              onActivity={refreshAfterActivity}
              onClose={() =>
                void guard(async () => {
                  await flush();
                  setSelected(null);
                  refreshAfterActivity();
                })
              }
              flushRef={flushRef}
              onToast={notify}
            />
          ) : (
            <aside className="inspector-placeholder">
              <div className="placeholder-symbol">
                <PanelRightOpen size={30} />
              </div>
              <h2>继续一段对话</h2>
              <p>
                选择左侧任务，查看进展或发一条新消息。
              </p>
              <div>
                <Folder size={15} />
                拖动任务到左侧，快速加入分组
              </div>
              <div>
                <ArrowUpRight size={15} />
                始终打开原来的会话
              </div>
            </aside>
          )}
        </div>
        <footer className="workspace-footer">
          <span>
            <i />
            {catalog.sourceInfo
              ? `最近同步 ${new Date(catalog.sourceInfo.syncedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`
              : "等待来源"}
          </span>
        </footer>
      </main>
      {groupDialog !== undefined && (
        <GroupDialog
          group={groupDialog || undefined}
          groups={catalog.groups}
          onClose={() => setGroupDialog(undefined)}
          onSave={async (g, id) => {
            await flush();
            await api(
              `/api/groups${id ? "/" + id : ""}`,
              id ? "PATCH" : "POST",
              g,
            );
            await refresh();
            notify(id ? "分组已更新" : "分组已创建");
          }}
          onDelete={async (id) => {
            await flush();
            await api(`/api/groups/${id}`, "DELETE");
            await refresh();
            if (groupId === id) {
              setView("all");
              setGroupId(null);
            }
            notify("分组已删除，任务和说明已保留");
          }}
        />
      )}
      {settings && (
        <SettingsDialog
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
            setCatalog(c);
            setSelected(null);
            setGroupId(null);
            setView("all");
            notify("整理结果已恢复");
          }}
        />
      )}
    </div>
  );
}
