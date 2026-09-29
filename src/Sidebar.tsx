import {
  Archive,
  BookOpen,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  Clock3,
  Folder,
  FolderOpen,
  Layers3,
  Pocket,
  MoreHorizontal,
  Pin,
  Plus,
  RotateCcw,
  Settings2,
  X,
} from "lucide-react";
import { useState, useEffect, useRef } from "react";
import type { Catalog, Group, View } from "./types";
import { descendantIds } from "./model";
interface Props {
  footerActions?: React.ReactNode;
  catalog: Catalog;
  view: View;
  groupId: string | null;
  mobileOpen: boolean;
  onClose: () => void;
  onView: (v: View, id?: string) => void;
  onGroup: (g?: Group) => void;
  onDrop: (id: string, groupId: string) => void;
  onSettings: () => void;
}
export default function Sidebar(p: Props) {
  const [narrow, setNarrow] = useState(
    () => matchMedia("(max-width:760px)").matches,
  );
  const asideRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const m = matchMedia("(max-width:760px)");
    const update = () => setNarrow(m.matches);
    m.addEventListener("change", update);
    return () => m.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    if (narrow && p.mobileOpen)
      asideRef.current
        ?.querySelector<HTMLButtonElement>(".brand button")
        ?.focus();
  }, [narrow, p.mobileOpen]);
  useEffect(() => {
    if (p.view === "group" && p.groupId) {
      asideRef.current
        ?.querySelector(`[data-group-id="${CSS.escape(p.groupId)}"]`)
        ?.scrollIntoView({ block: "nearest" });
    }
  }, [p.view, p.groupId, p.catalog.groups.length, p.mobileOpen]);
  const [collapsed, setCollapsed] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem("navigator.collapsed") || "[]");
    } catch {
      return [];
    }
  });
  const toggle = (id: string) => {
    const next = collapsed.includes(id)
      ? collapsed.filter((x) => x !== id)
      : [...collapsed, id];
    setCollapsed(next);
    localStorage.setItem("navigator.collapsed", JSON.stringify(next));
  };
  const active = p.catalog.threads.filter((t) => !t.archived && !t.separator);
  const all = p.catalog.threads.filter((t) => !t.separator);
  const navs: [View, string, typeof Layers3, number][] = [
    ["all", "全部任务", Layers3, active.length],
    ["pinned", "置顶", Pin, active.filter((t) => t.pinned).length],
    [
      "active",
      "正在推进",
      CircleDashed,
      all.filter((t) => t.intent === "active").length,
    ],
    [
      "later",
      "稍后继续",
      Clock3,
      all.filter((t) => t.intent === "later").length,
    ],
    [
      "reference",
      "留作参考",
      BookOpen,
      all.filter((t) => t.intent === "reference").length,
    ],
    ["recent", "最近打开", RotateCcw, all.filter((t) => t.lastOpenedAt).length],
  ];
  const renderGroup = (g: Group, depth = 0) => {
    const children = p.catalog.groups.filter((x) => x.parentId === g.id),
      isCollapsed = collapsed.includes(g.id);
    const descendants = descendantIds(p.catalog.groups, g.id);
    const n = active.filter((t) =>
      t.groupIds.some((id) => descendants.has(id)),
    ).length;
    const selected = p.view === "group" && p.groupId === g.id;
    return (
      <div key={g.id} className="tree-branch">
        <div
          className={`group-row ${selected ? "selected" : ""}`}
          data-group-id={g.id}
          style={{ paddingLeft: 12 + depth * 16 }}
          onDragOver={(e) => {
            e.preventDefault();
            e.currentTarget.classList.add("drop-target");
          }}
          onDragLeave={(e) => e.currentTarget.classList.remove("drop-target")}
          onDrop={(e) => {
            e.preventDefault();
            e.currentTarget.classList.remove("drop-target");
            const id = e.dataTransfer.getData("application/x-codex-thread");
            if (id) p.onDrop(id, g.id);
          }}
        >
          <button
            className="tree-toggle"
            aria-expanded={children.length ? !isCollapsed : undefined}
            aria-label={`${isCollapsed ? "展开" : "折叠"} ${g.name}`}
            disabled={!children.length}
            onClick={() => toggle(g.id)}
          >
            {children.length ? (
              isCollapsed ? (
                <ChevronRight size={12} />
              ) : (
                <ChevronDown size={12} />
              )
            ) : (
              <span />
            )}
          </button>
          <button
            className="group-select"
            onClick={() => p.onView("group", g.id)}
            title={g.name}
          >
            {selected ? (
              <FolderOpen size={16} color={g.color} />
            ) : (
              <Folder size={16} color={g.color} />
            )}
            <span>{g.name}</span>
            <small>{n}</small>
          </button>
          <button
            className="group-edit icon-button"
            aria-label={`编辑分组 ${g.name}`}
            onClick={() => p.onGroup(g)}
          >
            <MoreHorizontal size={15} />
          </button>
        </div>
        {!isCollapsed && children.map((c) => renderGroup(c, depth + 1))}
      </div>
    );
  };
  return (
    <>
      <button
        className={`sidebar-backdrop ${p.mobileOpen ? "shown" : ""}`}
        tabIndex={-1}
        aria-hidden="true"
        onClick={p.onClose}
      />
      <aside
        ref={asideRef}
        inert={narrow && !p.mobileOpen}
        className={`sidebar ${p.mobileOpen ? "mobile-open" : ""}`}
        onKeyDown={(e) => {
          if (!narrow || !p.mobileOpen) return;
          if (e.key === "Escape") {
            p.onClose();
            return;
          }
          if (e.key === "Tab") {
            const els = Array.from(
              asideRef.current?.querySelectorAll<HTMLButtonElement>(
                "button:not([disabled])",
              ) || [],
            ).filter((el) => el.offsetWidth > 0);
            const first = els[0],
              last = els[els.length - 1];
            if (e.shiftKey && document.activeElement === first) {
              e.preventDefault();
              last?.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
              e.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <div className="brand">
          <div className="brand-mark">
            <Pocket size={22} />
          </div>
          <div>
            <strong>Pocket</strong>
            <span>Codex 随身入口</span>
          </div>
          <button
            className="icon-button mobile-only"
            onClick={p.onClose}
            aria-label="关闭导航"
          >
            <X size={18} />
          </button>
        </div>
        <nav aria-label="任务视图">
          {navs.map(([v, label, Icon, n]) => (
            <button
              key={v}
              className={`nav-item ${p.view === v ? "selected" : ""}`}
              onClick={() => p.onView(v)}
            >
              <Icon size={18} />
              <span>{label}</span>
              <small>{n}</small>
            </button>
          ))}
        </nav>
        <div className="sidebar-section-head">
          <span>我的分组</span>
          <button
            className="icon-button"
            title="新建分组"
            aria-label="新建分组"
            onClick={() => p.onGroup()}
          >
            <Plus size={17} />
          </button>
        </div>
        <div className="group-tree">
          {p.catalog.groups
            .filter((g) => !g.parentId)
            .map((g) => renderGroup(g))}
          <button
            className={`nav-item unassigned ${p.view === "unassigned" ? "selected" : ""}`}
            onClick={() => p.onView("unassigned")}
          >
            <CircleDashed size={16} />
            <span>未分组</span>
            <small>{active.filter((t) => !t.groupIds.length).length}</small>
          </button>
        </div>
        <div className="sidebar-bottom">
          {p.footerActions}
          <button
            className={`nav-item ${p.view === "archived" ? "selected" : ""}`}
            onClick={() => p.onView("archived")}
          >
            <Archive size={17} />
            <span>归档</span>
            <small>
              {
                p.catalog.threads.filter((t) => t.archived && !t.separator)
                  .length
              }
            </small>
          </button>
          <button className="nav-item" onClick={p.onSettings}>
            <Settings2 size={17} />
            <span>数据与备份</span>
          </button>
          <div className="local-status">
            <i />
            保存在这台 Mac
          </div>
        </div>
      </aside>
    </>
  );
}
