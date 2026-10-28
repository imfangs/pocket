import type { TaskOperation } from "./taskOperations";
import type { CreationCue } from "./creationList";
import "./task-list-status.css";
import "./creation-list.css";

export type CreationPendingItem = {
  operation: TaskOperation;
  title: string;
  projectName?: string;
  cue: CreationCue;
  canOpen: boolean;
};

export default function CreationPendingRows({ items, onOpen, onReview }: {
  items: readonly CreationPendingItem[];
  onOpen: (operation: TaskOperation) => void;
  onReview: (operation: TaskOperation) => void;
}) {
  if (!items.length) return null;
  return <div className="task-list-surface creation-pending-list">
    <div className="task-list" role="list" aria-label="创建中的会话">
      {items.map(({ operation, title, projectName, cue, canOpen }) => {
        const canReview = cue.phase === "attention";
        return <div key={operation.requestId} role="listitem"
          className={`task-row ${cue.phase === "confirmed" ? "is-recently-created" : `is-creation-${cue.phase}`}`}>
          <button type="button" className="task-select"
            data-creation-request-id={operation.requestId} data-creation-state={cue.phase}
            data-row-state={cue.phase === "confirmed" ? undefined : `creation-${cue.phase}`}
            data-creation-action={canOpen ? "open" : canReview ? "review" : "wait"}
            disabled={!canOpen && !canReview} title={title}
            onClick={() => { if (canOpen) onOpen(operation); else if (canReview) onReview(operation); }}>
            <div className="row-first">
              <strong>{title}</strong>
              <span className="row-status-slot" data-list-status="primary" data-list-status-key={`creation-${cue.phase}`}>
                <span className="creation-state-label" data-creation-phase={cue.phase} role="status">{cue.label}</span>
              </span>
            </div>
            {projectName && <div className="row-second"><span className="project-label">
              {projectName === "无项目" ? "独立会话" : projectName}
            </span></div>}
          </button>
        </div>;
      })}
    </div>
  </div>;
}
