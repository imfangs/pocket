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
  MessageCircle,
  Pin,
  Plus,
  RotateCcw,
  Settings2,
  X,
} from "lucide-react";
import { Fragment, useState, useEffect, useMemo, useRef } from "react";
import type { Catalog, Group, View } from "./types";
import { descendantIds } from "./model";
import { groupAncestorIds, navigationViewCount } from "./navigationModel";
interface Props {
  catalog: Catalog;
  view: View;
  groupId: string | null;
  mobileOpen: boolean;
  onClose: () => void;
  onView: (v: View, id?: string) => void;
  onGroup: (g?: Group) => void;
  onDrop: (id: string, groupId: string) => void;
  onSettings: () => void;
  showSeparators?: boolean;
}
export default function Sidebar(p: Props) {
  const [narrow, setNarrow] = useState(
    () => matchMedia("(max-width:760px)").matches,
  );
  const asideRef = useRef<HTMLElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null), wasOpen = useRef(false);
  useEffect(() => {
    const m = matchMedia("(max-width:760px)");
    const update = () => setNarrow(m.matches);
    m.addEventListener("change", update);
    return () => m.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    const isOpen = narrow && p.mobileOpen;
    if (isOpen && !wasOpen.current) {
      returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      asideRef.current
        ?.querySelector<HTMLButtonElement>(".brand button")
        ?.focus();
    } else if (!isOpen && wasOpen.current) {
      const target = returnFocus.current;
      const active = document.activeElement;
      if (target?.isConnected && (active === document.body || asideRef.current?.contains(active)) && !document.querySelector("dialog[open]"))
        target.focus({ preventScroll: true });
    }
    wasOpen.current = isOpen;
  }, [narrow, p.mobileOpen]);
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
    try { localStorage.setItem("navigator.collapsed", JSON.stringify(next)); } catch {}
  };
  useEffect(() => {
    if (p.view !== "group" || !p.groupId) return;
    const ancestors = groupAncestorIds(p.catalog.groups, p.groupId);
    setCollapsed(previous => {
      const next = previous.filter(id => !ancestors.has(id));
      if (next.length === previous.length) return previous;
      try { localStorage.setItem("navigator.collapsed", JSON.stringify(next)); } catch {}
      return next;
    });
  }, [p.view, p.groupId, p.catalog.groups]);
  useEffect(() => {
    if (p.view === "group" && p.groupId) asideRef.current
      ?.querySelector(`[data-group-id="${CSS.escape(p.groupId)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [p.view, p.groupId, p.catalog.groups.length, p.mobileOpen, collapsed]);
  const counts = useMemo(() => Object.fromEntries((["all", "pinned", "active", "later", "reference", "recent", "unread", "archived", "unassigned"] as View[])
    .map(view => [view, navigationViewCount(p.catalog, view, p.showSeparators)])), [p.catalog, p.showSeparators]);
  const active = p.catalog.threads.filter((t) => !t.archived && (p.showSeparators || !t.separator));
  const navs: [View, string, typeof Layers3, number | string][] = [
    ["unread", "待我输入", MessageCircle, p.catalog.sourceInfo?.unread?.available ? counts.unread : "—"],
    ["all", "全部会话", Layers3, counts.all],
    ["pinned", "置顶", Pin, counts.pinned],
    ["recent", "最近打开", RotateCcw, counts.recent],
    [
      "active",
      "正在推进",
      CircleDashed,
      counts.active,
    ],
    [
      "later",
      "稍后继续",
      Clock3,
      counts.later,
    ],
    [
      "reference",
      "留作参考",
      BookOpen,
      counts.reference,
    ],
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
            aria-current={selected ? "page" : undefined}
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
        role={narrow ? "dialog" : undefined}
        aria-modal={narrow && p.mobileOpen ? true : undefined}
        aria-label="工作区导航"
        className={`sidebar ${p.mobileOpen ? "mobile-open" : ""}`}
        onKeyDown={(e) => {
          if (!narrow || !p.mobileOpen) return;
          if (e.key === "Escape") {
            p.onClose();
            return;
          }
          if (e.key === "Tab") {
            const els = Array.from(
              asideRef.current?.querySelectorAll<HTMLElement>(
                "button, a[href], input, select, textarea, [tabindex]",
              ) || [],
            ).filter(el => el.tabIndex >= 0 && !el.matches(":disabled") && !el.closest("[hidden],[inert]") && el.getClientRects().length > 0);
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
          </div>
          <button
            className="icon-button mobile-only"
            onClick={p.onClose}
            aria-label="关闭导航"
          >
            <X size={18} />
          </button>
        </div>
        <nav aria-label="会话视图">
          {navs.map(([v, label, Icon, n], index) => (
            <Fragment key={v}>
            {index === 4 && <div className="sidebar-section-head sidebar-arrangements-heading"><span>我的安排</span></div>}
            <button
              data-view={v}
              aria-current={p.view === v ? "page" : undefined}
              className={`nav-item ${p.view === v ? "selected" : ""}`}
              onClick={() => p.onView(v)}
            >
              <Icon size={18} />
              <span>{label}</span>
              <small>{n}</small>
            </button>
            </Fragment>
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
            aria-current={p.view === "unassigned" ? "page" : undefined}
            onClick={() => p.onView("unassigned")}
          >
            <CircleDashed size={16} />
            <span>未分组</span>
            <small>{counts.unassigned}</small>
          </button>
        </div>
        <div className="sidebar-bottom">
          <div className="sidebar-tools">
            <button
              className={`nav-item ${p.view === "archived" ? "selected" : ""}`}
              aria-current={p.view === "archived" ? "page" : undefined}
              onClick={() => p.onView("archived")}
            >
              <Archive size={17} />
              <span>归档</span>
              <small>
                {counts.archived}
              </small>
            </button>
            <button
              className="icon-button sidebar-settings"
              onClick={p.onSettings}
              aria-label="设置"
              title="设置"
            >
              <Settings2 size={17} aria-hidden="true" />
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}
