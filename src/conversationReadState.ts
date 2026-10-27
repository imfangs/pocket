type ConversationReadState = {
  online: boolean;
  loading: boolean;
  transcriptLoading: boolean;
  historyFailed: boolean;
  messageCount: number;
  submissionCount: number;
  outboxCount: number;
};

export function emptyConversationState(state: ConversationReadState): "loading" | "empty" | null {
  if (state.messageCount || state.submissionCount || state.outboxCount) return null;
  // Either source can provide the first readable message. An empty response
  // from one source does not settle the conversation while the other is reading.
  if (state.loading || state.transcriptLoading) return state.online ? "loading" : null;
  return state.historyFailed ? null : "empty";
}
