import { AppIcon } from "./ui/AppIcon";
import { t as tr, useLocale } from "./i18n";
import { IconButton } from "./ui/IconButton";
import PocketLogo from "./PocketLogo";
import { Archive, EyeOff, Folder, Layers3, Pin, Settings2, Star, X } from "lucide-react";
import { useState, useEffect, useMemo, useRef } from "react";
import type { Catalog, View } from "./types";
import { projectNavigationItems } from "./projectNavigation";
import { sidebarNavigationCounts } from "./navigationModel";
import "./project-navigation.css";
interface Props {
  catalog: Catalog;
  view: View;
  project?: string;
  mobileOpen: boolean;
  onClose: () => void;
  onView: (v: View) => void;
  onProject?: (id: string) => void;
  onSettings: () => void;
}
export default function Sidebar(p: Props) {
  useLocale();
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
      asideRef.current?.focus({ preventScroll: true });
    } else if (!isOpen && wasOpen.current) {
      const target = returnFocus.current;
      const active = document.activeElement;
      if (target?.isConnected && (active === document.body || asideRef.current?.contains(active)) && !document.querySelector("dialog[open]"))
        target.focus({ preventScroll: true });
    }
    wasOpen.current = isOpen;
  }, [narrow, p.mobileOpen]);
  const projects = useMemo(() => projectNavigationItems(p.catalog.projects || [], p.catalog.threads), [p.catalog.projects, p.catalog.threads]);
  const counts = useMemo(() => sidebarNavigationCounts(p.catalog.threads), [p.catalog.threads]);
  const projectScopedView = p.view === "all" || p.view === "unread" || p.view === "running" || p.view === "created";
  const allSelected = !p.project && projectScopedView;
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
        tabIndex={-1}
        style={{ outline: "none" }}
        inert={narrow && !p.mobileOpen}
        role={narrow ? "dialog" : undefined}
        aria-modal={narrow && p.mobileOpen ? true : undefined}
        aria-label={tr("工作区导航")}
        className={`sidebar project-navigation ${p.mobileOpen ? "mobile-open" : ""}`}
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
            if (document.activeElement === asideRef.current) {
              e.preventDefault();
              (e.shiftKey ? last : first)?.focus();
              return;
            }
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
            <PocketLogo />
          </div>
          <div>
            <strong>Pocket</strong>
          </div>
          <IconButton type="button"
            className="icon-button mobile-only"
            onClick={p.onClose}
            aria-label={tr("关闭导航")}
          >
            <AppIcon icon={X} kind="action" />
          </IconButton>
        </div>
        <div className="sidebar-scroll">
          <nav aria-label={tr("会话视图")}>
            <button
              data-view="all"
              aria-label={tr("{{label}}，{{count}} 个会话", { label: tr("全部"), count: counts.all })}
              aria-current={allSelected ? "page" : undefined}
              className={`nav-item ${allSelected ? "selected" : ""}`}
              onClick={() => p.onView("all")}
            >
              <AppIcon icon={Layers3} kind="navigation" aria-hidden="true" />
              <span>{tr("全部")}</span>
              <small className="sidebar-nav-count" aria-hidden="true">{counts.all}</small>
            </button>
            <button
              data-view="priority"
              aria-label={tr("{{label}}，{{count}} 个会话", { label: tr("关注"), count: counts.priority })}
              aria-current={p.view === "priority" ? "page" : undefined}
              className={`nav-item ${p.view === "priority" ? "selected" : ""}`}
              onClick={() => p.onView("priority")}
            >
              <AppIcon icon={Star} kind="navigation" aria-hidden="true" />
              <span>{tr("关注")}</span>
              <small className="sidebar-nav-count" aria-hidden="true">{counts.priority}</small>
            </button>
            <button
              data-view="codex-pinned"
              aria-label={tr("{{label}}，{{count}} 个会话", { label: tr("置顶"), count: counts.codexPinned })}
              aria-current={p.view === "codex-pinned" ? "page" : undefined}
              className={`nav-item ${p.view === "codex-pinned" ? "selected" : ""}`}
              onClick={() => p.onView("codex-pinned")}
            >
              <AppIcon icon={Pin} kind="navigation" aria-hidden="true" />
              <span>{tr("置顶")}</span>
              <small className="sidebar-nav-count" aria-hidden="true">{counts.codexPinned}</small>
            </button>
            <button
              data-view="hidden"
              aria-label={tr("{{label}}，{{count}} 个会话", { label: tr("隐藏"), count: counts.hidden })}
              aria-current={p.view === "hidden" ? "page" : undefined}
              className={`nav-item ${p.view === "hidden" ? "selected" : ""}`}
              onClick={() => p.onView("hidden")}
            >
              <AppIcon icon={EyeOff} kind="navigation" aria-hidden="true" />
              <span>{tr("隐藏")}</span>
              <small className="sidebar-nav-count" aria-hidden="true">{counts.hidden}</small>
            </button>
            <button
              data-view="archived"
              aria-label={tr("已归档")}
              aria-current={p.view === "archived" ? "page" : undefined}
              className={`nav-item ${p.view === "archived" ? "selected" : ""}`}
              onClick={() => p.onView("archived")}
            >
              <AppIcon icon={Archive} kind="navigation" aria-hidden="true" />
              <span>{tr("已归档")}</span>
            </button>
          </nav>
          {projects.length > 0 && <nav className="sidebar-projects" aria-label={tr("项目")}>
            <p className="sidebar-projects-heading">{tr("项目")}</p>
            {projects.map(project => {
              const selected = p.project === project.id && projectScopedView;
              const count = counts.projects.get(project.id) || 0;
              return <button
                key={project.id}
                data-project-id={project.id}
                aria-current={selected ? "page" : undefined}
                aria-label={tr("{{label}}，{{count}} 个会话", { label: project.id === "__unassigned__" ? tr("未归属项目") : project.ariaLabel, count })}
                title={project.id === "__unassigned__" ? tr("未归属项目") : project.title}
                className={`nav-item sidebar-project ${selected ? "selected" : ""}`}
                onClick={() => p.onProject?.(project.id)}
              >
                <AppIcon icon={Folder} kind="navigation" aria-hidden="true" />
                <span className="sidebar-project-label"><span className="sidebar-project-name">{project.id === "__unassigned__" ? tr("未归属项目") : project.name}</span>
                  {project.suffix && <small className="sidebar-project-suffix">{project.suffix}</small>}
                </span>
                <small className="sidebar-nav-count" aria-hidden="true">{count}</small>
              </button>;
            })}
          </nav>}
        </div>
        <div className="sidebar-bottom">
          <div className="sidebar-tools">
            <button type="button"
              className="nav-item sidebar-settings"
              onClick={p.onSettings}
              aria-label={tr("设置")}
              title={tr("设置")}
            >
              <AppIcon icon={Settings2} kind="navigation" aria-hidden="true" />
              <span>{tr("设置")}</span>
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}
