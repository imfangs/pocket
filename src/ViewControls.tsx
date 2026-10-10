import * as Popover from "@radix-ui/react-popover";
import { SlidersHorizontal, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { Project } from "./types";

export default function ViewControls({ projects, project, sort, onProject, onSort, onSelectTasks, selectionDisabled }: {
  projects: Project[];
  project: string;
  sort: string;
  onProject: (id: string) => void;
  onSort: (sort: string) => void;
  onSelectTasks?: () => void;
  selectionDisabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => { window.dispatchEvent(new Event("pocket-reading-visibility-change")); }, [open]);
  return <Popover.Root open={open} onOpenChange={setOpen}>
    <Popover.Trigger className="view-options-trigger" data-filtered={!!project || undefined} aria-label="筛选与排序">
      <SlidersHorizontal size={17} aria-hidden="true" />
      <span>筛选</span>
    </Popover.Trigger>
    <Popover.Portal>
      <Popover.Content className="view-options-popover" data-reading-overlay="" align="end" sideOffset={8} collisionPadding={12} aria-label="筛选与排序">
        <header><label className="field-label" htmlFor="view-project">来源项目</label><Popover.Close className="icon-button" aria-label="关闭筛选"><X size={16} /></Popover.Close></header>
        <select id="view-project" value={project} onChange={event => onProject(event.target.value)}>
          <option value="">所有来源项目</option>
          {projects.filter(item => !item.separator).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
        <label className="field-label" htmlFor="view-sort">排列方式</label>
        <select id="view-sort" value={sort} onChange={event => onSort(event.target.value)}>
          <option value="updated">最近活动</option>
          <option value="pinned">置顶优先</option>
        </select>
        <footer>{project && <button type="button" className="text-button" onClick={() => onProject("")}>清除筛选</button>}
          {onSelectTasks && <button type="button" className="text-button" disabled={selectionDisabled} onClick={() => { setOpen(false); onSelectTasks(); }}>批量选择</button>}
        </footer>
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>;
}
