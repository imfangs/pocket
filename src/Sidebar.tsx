import PocketLogo from "./PocketLogo";
import { Archive, Folder, Layers3, Settings2, X } from "lucide-react";
import { useState, useEffect, useMemo, useRef } from "react";
import type { Catalog, View } from "./types";
import { projectNavigationItems } from "./projectNavigation";
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
  const projects = useMemo(() => projectNavigationItems(p.catalog.projects || [], p.catalog.threads), [p.catalog.projects, p.catalog.threads]);
  const allSelected = !p.project && p.view !== "archived";
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
          <button
            className="icon-button mobile-only"
            onClick={p.onClose}
            aria-label="关闭导航"
          >
            <X size={18} />
          </button>
        </div>
        <div className="sidebar-scroll">
          <nav aria-label="会话视图">
            <button
              data-view="all"
              aria-current={allSelected ? "page" : undefined}
              className={`nav-item ${allSelected ? "selected" : ""}`}
              onClick={() => p.onView("all")}
            >
              <Layers3 size={18} aria-hidden="true" />
              <span>全部会话</span>
            </button>
          </nav>
          {projects.length > 0 && <nav className="sidebar-projects" aria-label="项目">
            <p className="sidebar-projects-heading">项目</p>
            {projects.map(project => {
              const selected = p.project === project.id && p.view !== "archived";
              return <button
                key={project.id}
                data-project-id={project.id}
                aria-current={selected ? "page" : undefined}
                aria-label={project.ariaLabel}
                title={project.title}
                className={`nav-item sidebar-project ${selected ? "selected" : ""}`}
                onClick={() => p.onProject?.(project.id)}
              >
                <Folder size={17} aria-hidden="true" />
                <span className="sidebar-project-label"><span className="sidebar-project-name">{project.name}</span>
                  {project.suffix && <small className="sidebar-project-suffix">{project.suffix}</small>}
                </span>
              </button>;
            })}
          </nav>}
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
