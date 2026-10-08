import { useMemo, useState } from "react";
import { CalendarDays, Folder } from "lucide-react";
import AutoTextarea from "./AutoTextarea";
import { groupPath } from "./model";
import { intentLabels } from "./types";
import type { Group, Intent } from "./types";

type Values = { intent: Intent; note: string; reviewAt: string | null; groupIds: string[] };
export default function ThreadProperties({ value, groups, disabled, onChange, onSave }: {
  value: Values; groups: Group[]; disabled: boolean; onChange: (patch: Partial<Values>) => void; onSave: () => Promise<void>;
}) {
  const [groupQuery, setGroupQuery] = useState("");
  const choices = useMemo(() => groups.map(group => ({ group, label: groupPath(groups, group.id) })), [groups]);
  const terms = groupQuery.normalize("NFKC").toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  const visible = choices.filter(choice => terms.every(term => choice.label.normalize("NFKC").toLocaleLowerCase().includes(term)));
  const selected = choices.filter(choice => value.groupIds.includes(choice.group.id));
  return <fieldset disabled={disabled} className="inspector-fields inspector-properties">
    <section className="property-section">
      <label className="field-label note-label" htmlFor="continuation">接续说明</label>
      <p className="field-description">留一句下次接着做的事。</p>
      <AutoTextarea id="continuation" value={value.note} maxLength={12000} rows={3}
        onInput={event => onChange({ note: event.currentTarget.value })}
        onChange={event => onChange({ note: event.target.value })}
        onKeyDown={event => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); void onSave().catch(() => {}); }
        }} />
    </section>
    <section className="property-section" role="group" aria-labelledby="intent-label">
      <span className="field-label" id="intent-label">我的安排</span>
      <div className="intent-options" id="intent">
        {(["none", "active", "later", "reference"] as Intent[]).map(intent => <button key={intent} type="button"
          className={value.intent === intent ? "chosen" : ""} aria-pressed={value.intent === intent}
          onClick={() => onChange({ intent })}>{intentLabels[intent]}</button>)}
      </div>
      {value.intent === "later" && <label className="review-date">
        <span><CalendarDays size={15} />哪天再看 <small>可选</small></span>
        <input type="date" aria-label="回顾日期" value={value.reviewAt || ""}
          onChange={event => onChange({ reviewAt: event.target.value || null })} />
      </label>}
    </section>
    <section className="property-section">
      <details className="inspector-group-picker">
        <summary className="property-summary">
          <span>分组</span>
          <span>{selected.length ? selected.map(choice => choice.group.name).join("、") : "未分组"}</span>
          <small>{selected.length ? `${selected.length} 个` : "选择分组"}</small>
        </summary>
        {!!groups.length && <div className="group-picker-search"><input type="search" aria-label="搜索分组" placeholder="搜索分组"
          value={groupQuery} onChange={event => setGroupQuery(event.target.value)} /></div>}
        <div className="membership-list">
          {visible.map(({ group, label }) => <label key={group.id}>
            <input type="checkbox" checked={value.groupIds.includes(group.id)} onChange={event => onChange({ groupIds: event.target.checked
              ? [...value.groupIds, group.id] : value.groupIds.filter(id => id !== group.id) })} />
            <Folder size={14} color={group.color} /><span>{label}</span>
          </label>)}
          {!groups.length && <p className="field-help">还没有分组，可以从导航中新建。</p>}
          {!!groups.length && !visible.length && <p className="field-help" role="status">没有匹配的分组，已选分组仍会保留。</p>}
        </div>
      </details>
    </section>
  </fieldset>;
}
