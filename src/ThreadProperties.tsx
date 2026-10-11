import AutoTextarea from "./AutoTextarea";

type Values = { note: string };
export default function ThreadProperties({ value, disabled, onChange, onSave }: {
  value: Values; disabled: boolean; onChange: (patch: Partial<Values>) => void; onSave: () => Promise<void>;
}) {
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
  </fieldset>;
}
