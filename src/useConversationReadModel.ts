import { useLayoutEffect, useMemo, useRef } from "react";
import { conversationReadModel, type ConversationReadInput, type DesktopReadingProjection } from "./conversationReadModel";
import { currentMachineId } from "./machineScope";

// Commit the last desktop projection only after its render is committed. A
// cancelled render cannot lend its messages to a later rollout fallback.
export function useConversationReadModel(input: Omit<ConversationReadInput, "scope"> & { threadId: string }) {
  const scope = JSON.stringify([currentMachineId(), input.readingScope, input.threadId]);
  const nativeReading = useRef<DesktopReadingProjection | null>(null);
  const { history, transcript, submitted, cachedPreview, previewAllowed, readingScope } = input;
  const model = useMemo(() => conversationReadModel({
    scope, history, transcript, submitted, cachedPreview, previewAllowed, readingScope,
  }, nativeReading.current), [scope, history, transcript, submitted, cachedPreview, previewAllowed, readingScope]);
  useLayoutEffect(() => {
    if (nativeReading.current?.scope !== scope) nativeReading.current = null;
    if (history?.source === "desktop") nativeReading.current = { scope, view: model.freshDisplay };
  }, [scope, history?.source, model.freshDisplay]);
  return model;
}
