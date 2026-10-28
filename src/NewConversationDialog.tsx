import { IconButton } from "./ui/IconButton";
import { Button } from "./ui/Button";
import { useEffect, useMemo, useRef, useState } from "react";
import { ClipboardPaste, Search, X } from "lucide-react";
import { Modal } from "./Dialogs";
import { api } from "./api";
import { activeOperation, type CreateLocation, type TaskOperation } from "./taskOperations";
import TaskOperationStatus from "./TaskOperationStatus";
import { useReloadGuard } from "./updateSafety";
import { creationDirectories, creationDirectoryChoices, creationLocation, creationProjectChoices, searchCreationDirectories } from "./creationLocations";
import { initialCreationSelection, readCreationPreference, saveCreationPreference, type CreationPreference } from "./creationPreference";
import AutoTextarea from "./AutoTextarea";
import AnimatedDetails from "./AnimatedDetails";
import { applyCreationClipboard, beginCreationClipboard, createCreationClipboardReader, creationQueryPayload, editCreationQuery, type CreationClipboard, type CreationQueryDraft } from "./creationQuery";
import { createCreationOptionsReader, type CreationOptions } from "./creationOptions";
import { readAutoDirectPreference } from "./sendingPreference";

export type NewConversationInput = { locationId: string; name?: string; initialQuery?: string; autoDirect?: boolean };

export default function NewConversationDialog({ preferredCwd, initialQuery, initialName, initialSelection, clipboardRead, operation, operationError, onCreate, onCheck, onCancelOperation, onClose, closeRequested = false }: {
  preferredCwd?: string; operation?: TaskOperation; operationError?: string;
  initialQuery?: string;
  initialName?: string;
  initialSelection?: CreationPreference;
  clipboardRead?: Promise<CreationClipboard>;
  onCreate: (input: NewConversationInput, location?: CreateLocation) => Promise<unknown>;
  onCheck: () => void; onCancelOperation: () => void; onClose: () => void;
  closeRequested?: boolean;
}) {
  const [locations, setLocations] = useState<CreateLocation[]>([]), [directoryCwd, setDirectoryCwd] = useState("");
  const [projectLocationId, setProjectLocationId] = useState("");
  const [directoryQuery, setDirectoryQuery] = useState(""), [selectionTouched, setSelectionTouched] = useState(false);
  const [directorySearchOpen, setDirectorySearchOpen] = useState(false);
  const [rememberedSelection] = useState(() => initialSelection ?? readCreationPreference());
  const [rememberedUnavailable, setRememberedUnavailable] = useState(false);
  const [locationRequired, setLocationRequired] = useState(false);
  const [selectionError, setSelectionError] = useState<"directory" | "project" | null>(null);
  const [queryDraft, setQueryDraft] = useState<CreationQueryDraft>(() => ({ text: initialQuery ?? "", revision: 0 }));
  const [clipboardPending, setClipboardPending] = useState(false);
  const clipboardReader = useRef<ReturnType<typeof createCreationClipboardReader> | null>(null);
  const query = queryDraft.text;
  const queryTooLong = query.length > 16000;
  const queryBox = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState(false);
  const [name, setName] = useState(initialName ?? ""), [loading, setLoading] = useState(true), [error, setError] = useState("");
  const [optionsError, setOptionsError] = useState("");
  const optionsReader = useRef<ReturnType<typeof createCreationOptionsReader> | null>(null);
  const selection = useRef({ cwd: "", locationId: "" }), optionsLoaded = useRef(false);
  const selectLocation = (cwd: string, locationId: string) => {
    selection.current = { cwd, locationId };
    setDirectoryCwd(cwd); setProjectLocationId(locationId);
  };
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
    const reader = createCreationClipboardReader({
      onPending: setClipboardPending,
      onResult: (result, revision) => setQueryDraft(draft => applyCreationClipboard(draft, result, revision)),
    });
    clipboardReader.current = reader;
    return () => { reader.dispose(); if (clipboardReader.current === reader) clipboardReader.current = null; };
  }, []);
  useEffect(() => {
    if (!clipboardRead || activeOperation(operation)) return;
    clipboardReader.current?.watch(clipboardRead, 0);
    return () => clipboardReader.current?.cancel();
  }, [clipboardRead, operation?.requestId]);
  useEffect(() => { if (directorySearchOpen) directorySearch.current?.focus(); }, [directorySearchOpen]);
  useReloadGuard(() => busy ? "会话正在创建，请稍后更新。" : dirty ? "新会话还有未提交的内容，请先处理。" : null);
  useEffect(() => {
    const reader = createCreationOptionsReader({
      request: signal => api<CreationOptions>("/api/tasks/create-options", "GET", undefined, { signal }),
      onData(result) {
        setAvailable(result.available && result.locations.length > 0);
        // Failed reads retain the current choice for a later successful retry.
        if (!result.available || !result.locations.length) return;
        setLocations(result.locations);
        const nextDirectories = creationDirectories(result.locations);
        const initial: CreationPreference & { unavailable?: true } = optionsLoaded.current && !selection.current.cwd ? selection.current
          : initialCreationSelection(nextDirectories, optionsLoaded.current ? selection.current : rememberedSelection, startingCwd.current);
        optionsLoaded.current = true;
        selectLocation(initial.cwd, initial.locationId);
        setRememberedUnavailable(!!initial.unavailable);
        // Once required choices are exposed, keep their place for this dialog.
        if (!creationLocation(nextDirectories, initial.cwd, initial.locationId)) setLocationRequired(true);
      },
      onError: setOptionsError,
      onLoading: setLoading,
    });
    optionsReader.current = reader;
    const online = () => { if (navigator.onLine !== false) void reader.reconnect(); };
    const offline = () => reader.offline();
    window.addEventListener("online", online); window.addEventListener("offline", offline);
    void reader.read();
    return () => {
      reader.dispose(); if (optionsReader.current === reader) optionsReader.current = null;
      window.removeEventListener("online", online); window.removeEventListener("offline", offline);
    };
  }, []);
  const locationFields = <div className="new-conversation-location-fields" data-required={locationRequired || undefined}>
    <div className="new-conversation-field new-conversation-directory">
      <div className="new-directory-heading">
        <label className="field-label" htmlFor="new-conversation-location">工作目录</label>
        <Button type="button" className="text-button directory-search-toggle" variant="ghost" color="gray" size="2" aria-expanded={directorySearchOpen} aria-controls="new-directory-search"
          disabled={locked} onClick={() => { setDirectorySearchOpen(value => !value); setDirectoryQuery(""); }}>
          <Search size={14} aria-hidden="true" />{directorySearchOpen ? "收起查找" : "查找目录"}
        </Button>
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
        selectLocation(event.target.value, "");
        setSelectionTouched(true);
        setDirectoryQuery("");
        setError(""); setSelectionError(null);
        const location = creationLocation(directories, event.target.value, "");
        saveCreationPreference({ cwd: event.target.value, locationId: location?.id || "" });
      }} required aria-invalid={selectionError === "directory" || undefined}
        aria-describedby={selectionError === "directory" ? "new-conversation-directory-error" : undefined}>
        <option value="">{loading ? "正在读取目录…" : "选择一个工作目录"}</option>
        {hiddenSelection && <optgroup label="当前选择"><option value={hiddenSelection.directory.cwd}>{hiddenSelection.label}</option></optgroup>}
        {directoryResults.map(choice => <option key={choice.directory.cwd} value={choice.directory.cwd}>{choice.label}</option>)}
      </select>
      {selectionError === "directory" && <p id="new-conversation-directory-error" className="inline-error" role="alert">请选择工作目录后创建。</p>}
      {rememberedUnavailable && !selectionTouched && <p className="field-help">上次的目录或项目已不可用，请重新选择。</p>}
      {directoryQuery && !loading && <p className="field-help directory-search-feedback" role="status">
        {directoryResults.length ? `找到 ${directoryResults.length} 个目录。` : "没有匹配目录，试试路径中的词。"}
        {hiddenSelection && ` 当前选择仍是「${hiddenSelection.label}」。`}
      </p>}
      {directory && <p className="field-help new-conversation-path">{directory.cwd}</p>}
    </div>
    {projects.length > 1 ? <div className="new-conversation-field new-conversation-project">
      <label className="field-label" htmlFor="new-conversation-project">归属项目</label>
      <select ref={projectSelect} id="new-conversation-project" value={projectLocationId} disabled={loading || locked}
        onChange={event => {
          selectLocation(directoryCwd, event.target.value); setSelectionTouched(true);
          setError(""); setSelectionError(null);
          saveCreationPreference({ cwd: directoryCwd, locationId: event.target.value });
        }} required aria-invalid={selectionError === "project" || undefined}
          aria-describedby={selectionError === "project" ? "new-conversation-project-error" : undefined}>
        <option value="">选择归属项目</option>
        {projects.map(choice => <option key={choice.location.id} value={choice.location.id}>{choice.label}</option>)}
      </select>
      {selectionError === "project" && <p id="new-conversation-project-error" className="inline-error" role="alert">请选择归属项目后创建。</p>}
    </div> : projects.length === 1 ? <p className="field-help">归属项目：{projects[0].label}</p> : null}
  </div>;
  return <Modal title="新建会话" className="new-conversation-dialog" onClose={() => (closeRequested || !busy) && onClose()} busy={busy} dirty={dirty} closeRequested={closeRequested}>
    <form className="new-conversation-form" noValidate onSubmit={async event => {
      event.preventDefault(); if (!available || loading || locked || submitting.current || queryTooLong) return;
      if (!selectedLocation) {
        setSelectionError(directory ? "project" : "directory");
        if (!locationRequired && settings.current) settings.current.open = true;
        (directory ? projectSelect.current : directorySelect.current)?.focus();
        return;
      }
      clipboardReader.current?.cancel();
      setQueryDraft(draft => editCreationQuery(draft, draft.text));
      submitting.current = true; setBusy(true); setError("");
      try {
        saveCreationPreference({ cwd: selectedLocation.cwd, locationId: selectedLocation.id });
        const message = creationQueryPayload(query);
        await onCreate({ locationId: selectedLocation.id, ...(name.trim() ? { name: name.trim() } : {}), ...message,
          ...(message.initialQuery ? { autoDirect: readAutoDirectPreference() } : {}) }, selectedLocation);
      }
      catch (failure) { setError((failure as Error).message); }
      finally { submitting.current = false; setBusy(false); }
    }}>
      <div className="quick-create-query" ref={queryBox}>
        <div className="quick-create-query-input">
          <label className="sr-only" htmlFor="quick-create-query">首条消息</label>
          <AutoTextarea id="quick-create-query" data-autofocus value={query} disabled={locked} maxLength={16000}
            aria-invalid={queryTooLong || undefined} placeholder={clipboardPending ? "正在读取剪贴板…" : "写下想讨论或完成的事，也可以粘贴内容"}
            onChange={event => { const text = event.target.value; clipboardReader.current?.cancel(); setQueryDraft(draft => editCreationQuery(draft, text)); }} />
          {query.length > 0 && <IconButton type="button" size="2" className="icon-button quick-create-clear" title="清空输入" aria-label="清空输入" disabled={locked} onClick={() => {
            clipboardReader.current?.cancel();
            setQueryDraft(draft => editCreationQuery(draft, ""));
            queryBox.current?.querySelector("textarea")?.focus();
          }}><X size={16} aria-hidden="true" /></IconButton>}
          {!query.length && !locked && <IconButton type="button" size="2" className="icon-button quick-create-clear" title="粘贴剪贴板" aria-label="粘贴剪贴板"
            onMouseDown={event => { if (event.button === 0 && document.activeElement === queryBox.current?.querySelector("textarea")) event.preventDefault(); }}
            onClick={() => {
              if (locked || submitting.current) return;
              const claimed = editCreationQuery(queryDraft, query);
              setQueryDraft(claimed);
              queryBox.current?.querySelector("textarea")?.focus({ preventScroll: true });
              const read = beginCreationClipboard(() => navigator.clipboard.readText());
              if (read) clipboardReader.current?.watch(read.then(result => !result.text && !result.hint
                ? { ...result, hint: "剪贴板中没有文字。" } : result), claimed.revision);
            }}><ClipboardPaste size={16} aria-hidden="true" /></IconButton>}
        </div>
        {queryDraft.hint && <p className="field-help">{queryDraft.hint}</p>}
        {queryTooLong && <p className="inline-error" role="alert">首条消息超过16000字，请缩短后再创建并发送。</p>}
      </div>
      {locationRequired && locationFields}
      <AnimatedDetails ref={settings} className="new-conversation-settings">
        <summary>更多设置</summary>
        <div className="new-conversation-settings-body">
          {!locationRequired && locationFields}
          <div className="new-conversation-field new-conversation-title">
            <label className="field-label" htmlFor="new-conversation-name">标题 <small>可选</small></label>
            <input id="new-conversation-name" value={name} disabled={locked} maxLength={220} placeholder="留空自动命名"
              onChange={event => setName(event.target.value)} />
          </div>
        </div>
      </AnimatedDetails>
      {operation && <TaskOperationStatus operation={operation} error={operationError} onCheck={onCheck} onCancel={onCancelOperation} />}
      {(error || optionsError) && <p className="inline-error" role="alert">{error || optionsError}</p>}
      <footer>
        {optionsError && <Button type="button" className="secondary" variant="soft" color="gray" disabled={loading || locked} onClick={() => { setError(""); void optionsReader.current?.read(); }}>{loading ? "正在读取…" : "重新读取目录"}</Button>}
        {activeOperation(operation) && <Button type="button" className="secondary" variant="soft" color="gray" disabled={busy} onClick={onClose}>返回列表</Button>}
        <Button type="submit" className="primary" disabled={loading || !available || locked || queryTooLong}>{busy || operation?.status === "pending" ? "正在创建…" : loading ? "正在准备…" : query.trim() ? "创建并发送" : "创建会话"}</Button>
      </footer>
    </form>
  </Modal>;
}
