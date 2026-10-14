import { useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import { Modal } from "./Dialogs";
import { api } from "./api";
import { activeOperation, type CreateLocation, type TaskOperation } from "./taskOperations";
import TaskOperationStatus from "./TaskOperationStatus";
import { useReloadGuard } from "./updateSafety";
import { creationDirectories, creationDirectoryChoices, creationLocation, creationProjectChoices, searchCreationDirectories } from "./creationLocations";
import { initialCreationSelection, readCreationPreference, saveCreationPreference } from "./creationPreference";
import AutoTextarea from "./AutoTextarea";
import AnimatedDetails from "./AnimatedDetails";
import { applyCreationClipboard, creationQueryPayload, editCreationQuery, type CreationClipboard, type CreationQueryDraft } from "./creationQuery";

export default function NewConversationDialog({ preferredCwd, initialQuery, clipboardRead, operation, operationError, onCreate, onCheck, onCancelOperation, onClose, closeRequested = false }: {
  preferredCwd?: string; operation?: TaskOperation; operationError?: string;
  initialQuery?: string;
  clipboardRead?: Promise<CreationClipboard>;
  onCreate: (input: { locationId: string; name?: string; initialQuery?: string }) => Promise<unknown>;
  onCheck: () => void; onCancelOperation: () => void; onClose: () => void;
  closeRequested?: boolean;
}) {
  const [locations, setLocations] = useState<CreateLocation[]>([]), [directoryCwd, setDirectoryCwd] = useState("");
  const [projectLocationId, setProjectLocationId] = useState("");
  const [directoryQuery, setDirectoryQuery] = useState(""), [selectionTouched, setSelectionTouched] = useState(false);
  const [directorySearchOpen, setDirectorySearchOpen] = useState(false);
  const [rememberedSelection] = useState(readCreationPreference);
  const [rememberedUnavailable, setRememberedUnavailable] = useState(false);
  const [queryDraft, setQueryDraft] = useState<CreationQueryDraft>(() => ({ text: initialQuery ?? "", revision: 0 }));
  const query = queryDraft.text;
  const queryTooLong = query.length > 16000;
  const queryBox = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState(false);
  const [name, setName] = useState(""), [loading, setLoading] = useState(true), [error, setError] = useState("");
  const submitting = useRef(false), [busy, setBusy] = useState(false);
  const directorySelect = useRef<HTMLSelectElement>(null);
  const settings = useRef<HTMLDetailsElement>(null);
  const projectSelect = useRef<HTMLSelectElement>(null);
  const directorySearch = useRef<HTMLInputElement>(null);
  const startingCwd = useRef(preferredCwd);
  const directories = useMemo(() => creationDirectories(locations), [locations]);
  const directoryChoices = useMemo(() => creationDirectoryChoices(directories), [directories]);
  const directoryResults = useMemo(() => searchCreationDirectories(directoryChoices, directoryQuery), [directoryChoices, directoryQuery]);
  const hiddenSelection = directoryChoices.find(choice => choice.directory.cwd === directoryCwd && !directoryResults.some(result => result.directory.cwd === directoryCwd));
  const directory = directories.find(item => item.cwd === directoryCwd);
  const selectedLocation = creationLocation(directories, directoryCwd, projectLocationId);
  const projects = directory ? creationProjectChoices(directory) : [];
  const locked = busy || activeOperation(operation) || operation?.status === "succeeded";
  const dirty = !activeOperation(operation) && operation?.status !== "succeeded" && (!!name || selectionTouched || !!query);
  useEffect(() => {
    if (!clipboardRead || activeOperation(operation)) return;
    let current = true;
    void clipboardRead.then(result => { if (current) setQueryDraft(draft => applyCreationClipboard(draft, result)); });
    return () => { current = false; };
  }, [clipboardRead, operation?.requestId]);
  useEffect(() => { if (directorySearchOpen) directorySearch.current?.focus(); }, [directorySearchOpen]);
  useReloadGuard(() => busy ? "会话正在创建，请稍后更新。" : dirty ? "新会话还有未提交的内容，请先处理。" : null);
  useEffect(() => {
    const controller = new AbortController();
    void api<{ available: boolean; locations: CreateLocation[] }>("/api/tasks/create-options", "GET", undefined, { signal: controller.signal })
      .then(result => {
        if (controller.signal.aborted) return;
        setLocations(result.locations);
        setAvailable(result.available);
        const initial = initialCreationSelection(creationDirectories(result.locations), rememberedSelection, startingCwd.current);
        setDirectoryCwd(initial.cwd);
        setProjectLocationId(initial.locationId);
        setRememberedUnavailable(!!initial.unavailable);
        if (!result.available || !result.locations.length) setError("暂时没有可用的工作目录，请同步任务后重试。");
      }).catch(failure => { if (!controller.signal.aborted) setError(failure.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);
  return <Modal title="新建会话" onClose={() => (closeRequested || !busy) && onClose()} busy={busy} dirty={dirty} closeRequested={closeRequested}>
    <form className="new-conversation-form" noValidate onSubmit={async event => {
      event.preventDefault(); if (!available || loading || locked || submitting.current || queryTooLong) return;
      if (!selectedLocation) {
        setError(directory ? "请选择归属项目后创建。" : "请选择工作目录后创建。");
        if (settings.current) settings.current.open = true;
        (directory ? projectSelect.current : directorySelect.current)?.focus();
        return;
      }
      setQueryDraft(draft => editCreationQuery(draft, draft.text));
      submitting.current = true; setBusy(true); setError("");
      try {
        saveCreationPreference({ cwd: selectedLocation.cwd, locationId: selectedLocation.id });
        await onCreate({ locationId: selectedLocation.id, ...(name.trim() ? { name: name.trim() } : {}), ...creationQueryPayload(query) });
      }
      catch (failure) { setError((failure as Error).message); }
      finally { submitting.current = false; setBusy(false); }
    }}>
      <div className="quick-create-query" ref={queryBox}>
        <div className="quick-create-query-heading">
          <label className="field-label" htmlFor="quick-create-query">Query <small>首条消息，可留空</small></label>
          <button type="button" className="text-button" aria-label="清空 Query" disabled={locked} onClick={() => {
            setQueryDraft(draft => editCreationQuery(draft, ""));
            queryBox.current?.querySelector("textarea")?.focus();
          }}>清空</button>
        </div>
        <AutoTextarea id="quick-create-query" data-autofocus value={query} disabled={locked} maxLength={16000}
          aria-invalid={queryTooLong || undefined} placeholder="写下想讨论或完成的事，也可以粘贴内容"
          onChange={event => { const text = event.target.value; setQueryDraft(draft => editCreationQuery(draft, text)); }} />
        {queryDraft.hint && <p className="field-help">{queryDraft.hint}</p>}
        {queryTooLong && <p className="inline-error" role="alert">首条消息超过16000字，请缩短后再创建并发送。</p>}
      </div>
      <AnimatedDetails ref={settings} className="new-conversation-settings">
      <summary>更多设置</summary>
      <div className="new-conversation-settings-body">
      <div className="new-directory-heading">
        <label className="field-label" htmlFor="new-conversation-location">工作目录</label>
        <button type="button" className="text-button directory-search-toggle" aria-expanded={directorySearchOpen} aria-controls="new-directory-search"
          disabled={locked} onClick={() => { setDirectorySearchOpen(value => !value); setDirectoryQuery(""); }}>
          <Search size={14} aria-hidden="true" />{directorySearchOpen ? "收起查找" : "查找目录"}
        </button>
      </div>
      {directorySearchOpen && <div className="directory-search" id="new-directory-search">
        <Search size={16} aria-hidden="true" />
        <input ref={directorySearch} type="search" aria-label="搜索工作目录" placeholder="搜索目录名或路径" value={directoryQuery} disabled={locked}
          onChange={event => setDirectoryQuery(event.target.value)} onKeyDown={event => {
            if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
            if (event.key === "Enter") { event.preventDefault(); directorySelect.current?.focus(); return; }
            if (event.key === "Escape" && directoryQuery) { event.preventDefault(); event.stopPropagation(); setDirectoryQuery(""); }
          }} />
      </div>}
      <select ref={directorySelect} id="new-conversation-location" value={directoryCwd} disabled={loading || locked} onChange={event => {
        setDirectoryCwd(event.target.value);
        setProjectLocationId("");
        setSelectionTouched(true);
        setDirectoryQuery("");
        setError("");
        const location = creationLocation(directories, event.target.value, "");
        saveCreationPreference({ cwd: event.target.value, locationId: location?.id || "" });
      }} required>
        <option value="">{loading ? "正在读取目录…" : "选择一个工作目录"}</option>
        {hiddenSelection && <optgroup label="当前选择"><option value={hiddenSelection.directory.cwd}>{hiddenSelection.label}</option></optgroup>}
        {directoryResults.map(choice => <option key={choice.directory.cwd} value={choice.directory.cwd}>{choice.label}</option>)}
      </select>
      {rememberedUnavailable && !selectionTouched && <p className="field-help">上次的目录或项目已不可用，请重新选择。</p>}
      {directoryQuery && !loading && <p className="field-help directory-search-feedback" role="status">
        {directoryResults.length ? `找到 ${directoryResults.length} 个目录。` : "没有匹配目录，试试路径中的词。"}
        {hiddenSelection && ` 当前选择仍是「${hiddenSelection.label}」。`}
      </p>}
      {directory && <p className="field-help new-conversation-path">{directory.cwd}</p>}
      {projects.length > 1 ? <>
        <label className="field-label" htmlFor="new-conversation-project">归属项目</label>
        <select ref={projectSelect} id="new-conversation-project" value={projectLocationId} disabled={loading || locked}
          onChange={event => {
            setProjectLocationId(event.target.value); setSelectionTouched(true);
            setError("");
            saveCreationPreference({ cwd: directoryCwd, locationId: event.target.value });
          }} required>
          <option value="">选择归属项目</option>
          {projects.map(choice => <option key={choice.location.id} value={choice.location.id}>{choice.label}</option>)}
        </select>
      </> : projects.length === 1 ? <p className="field-help">归属项目：{projects[0].label}</p> : null}
      <label className="field-label" htmlFor="new-conversation-name">标题 <small>可选</small></label>
      <input id="new-conversation-name" value={name} disabled={locked} maxLength={220} placeholder="留空自动命名"
        onChange={event => setName(event.target.value)} />
      </div>
      </AnimatedDetails>
      {operation && <TaskOperationStatus operation={operation} error={operationError} onCheck={onCheck} onCancel={onCancelOperation} />}
      {error && <p className="inline-error" role="alert">{error}</p>}
      <footer>
        {activeOperation(operation) && <button type="button" className="secondary" disabled={busy} onClick={onClose}>返回列表</button>}
        <button className="primary" disabled={loading || !available || locked || queryTooLong}>{busy || operation?.status === "pending" ? "正在创建…" : loading ? "正在准备…" : query.trim() ? "创建并发送" : "创建会话"}</button>
      </footer>
    </form>
  </Modal>;
}
