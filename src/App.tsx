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
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Sidebar from "./Sidebar";
import TaskList from "./TaskList";
import Inspector from "./Inspector";
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
const empty: Catalog = {
  threads: [],
  groups: [],
  projects: [],
  sourceInfo: null,
  sourceError: null,
};
const titles: Record<View, string> = {
  all: "全部任务",
  pinned: "原版置顶",
  active: "正在推进",
  later: "稍后继续",
  reference: "留作参考",
  recent: "最近打开",
  archived: "原版归档",
  unassigned: "未分组",
  group: "",
};
const subtitles: Record<View, string> = {
  all: "每段讨论，都留有再接上的入口。",
  pinned: "熟悉的置顶任务，换一种更从容的整理方式。",
  active: "把注意力留给正在向前走的事。",
  later: "先放在这里，想继续时随时接上。",
  reference: "值得留下的讨论，不必都变成待办。",
  recent: "从 Pocket 打开过的原会话。",
  archived: "原版归档记录仍可检索，整理说明会一直保留。",
  unassigned: "还没有放入分组的会话。",
  group: "这里聚合分组和子分组里的原会话。",
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
    [selected, setSelected] = useState<string | null>(null),
    [query, setQuery] = useState(""),
    [project, setProject] = useState(""),
    [sort, setSort] = useState(
      prefs.sortVersion === 2 &&
        ["pinned", "updated", "title", "review"].includes(prefs.sort)
        ? prefs.sort
        : "updated",
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [toast, setToast] = useState(""),
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
    conversationDrafts = useRef(new Map<string, QueryDraft>()),
    conversationHistory = useRef<HistoryCache>(new Map()),
    flushRef = useRef<(() => Promise<void>) | null>(null),
    toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const notify = useCallback((s: string) => {
    setToast(s);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 3500);
  }, []);
  const refresh = useCallback(async (sync = false) => {
    const c = await api<Catalog>(
      sync ? "/api/sync" : "/api/catalog",
      sync ? "POST" : "GET",
    );
    if (c.csrfToken) setToken(c.csrfToken);
    setCatalog(c);
    return c;
  }, []);
  useEffect(() => {
    refresh()
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
    const timer = setInterval(() => {
      refresh().catch(() => {});
    }, 45000);
    return () => clearInterval(timer);
  }, [refresh]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        search.current?.focus();
      }
      if (e.key === "Escape" && !document.querySelector("dialog[open]"))
        setMobile(false);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
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
  const switchView = (v: View, id?: string) =>
    void guard(async () => {
      await flush();
      setView(v);
      setGroupId(id || null);
      setProject("");
      setChecked(new Set());
      setSelected(null);
      setMobile(false);
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
                <span>{threads.length}</span>
              </h1>
              <p>{subtitles[view]}</p>
            </div>
            <button
              className={`sync-button ${busy ? "spinning" : ""}`}
              onClick={() =>
                void guard(async () => {
                  setBusy(true);
                  try {
                    await refresh(true);
                    notify("已同步原版任务，整理结果已保留");
                  } finally {
                    setBusy(false);
                  }
                })
              }
              disabled={busy || loading}
              aria-label="同步原版任务"
            >
              <RefreshCw size={16} />
              <span>同步</span>
            </button>
          </div>
          <div className="filter-row">
            <div className="search-box">
              <Search size={17} />
              <input
                ref={search}
                placeholder="搜索任务、项目或接续说明"
                aria-label="搜索任务"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setChecked(new Set());
                }}
              />
              {query ? (
                <button
                  className="icon-button"
                  onClick={() => setQuery("")}
                  aria-label="清除搜索"
                >
                  <X size={15} />
                </button>
              ) : (
                <kbd>⌘ K</kbd>
              )}
            </div>
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
                <option value="title">按标题</option>
                <option value="review">回顾日期</option>
              </select>
            </label>
          </div>
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
          <section className="list-panel">
            {loading ? (
              <div className="loading">正在读取本机任务…</div>
            ) : (
              <TaskList
                threads={threads}
                groups={catalog.groups}
                selected={selected}
                view={view}
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
            )}
          </section>
          {current ? (
            <Inspector
              key={current.id}
              thread={current}
              queryDrafts={conversationDrafts.current}
              historyCache={conversationHistory.current}
              groups={catalog.groups}
              onSave={saveTask}
              onOpen={open}
              onClose={() =>
                void guard(async () => {
                  await flush();
                  setSelected(null);
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
              <h2>从一段讨论，接着往前</h2>
              <p>
                选中任务，留下一句接续说明，
                <br />
                或直接回到 Codex 继续。
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
          <span>沿用原任务 · 整理独立保存</span>
        </footer>
      </main>
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
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
