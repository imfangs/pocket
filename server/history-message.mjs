const uuid = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const validTurn = new RegExp(`^${uuid}$`);
const delegation = new RegExp(`^\\s*<codex_delegation>\\s*<source_thread_id>(${uuid})</source_thread_id>\\s*<input>([\\s\\S]*)</input>\\s*</codex_delegation>\\s*$`);

// A Codex-created chat receives its actual starting request as this named tool
// output, not as userMessage. Ordinary tool outputs and runtime instructions
// stay invisible. The projection is display-only and carries no send receipt.
export function historyMessageProjection(record) {
  if (record?.type !== 'response_item') return null;
  const item = record.payload;
  if (item?.type === 'message') return { item, origin: null };
  if (item?.type !== 'function_call_output' || item.namespace !== 'codex_app' || item.name !== 'create_thread' ||
      typeof item.id !== 'string' || !/^fco_[a-zA-Z0-9_-]{1,128}$/.test(item.id) || typeof item.output !== 'string') return null;
  const turnId = item.internal_chat_message_metadata_passthrough?.turn_id;
  if (!validTurn.test(typeof turnId === 'string' ? turnId : '')) return null;
  const match = delegation.exec(item.output);
  if (!match || !match[2].trim()) return null;
  // This transport does not define nested boundary tags. Reject ambiguity
  // instead of absorbing a second input or sibling runtime block as the Query.
  if (/<\/?(?:codex_delegation|source_thread_id)\b|<\/input\s*>/i.test(match[2])) return null;
  return { origin: 'codex_delegation', item: {
    type: 'message', id: item.id, role: 'user', content: [{ type: 'input_text', text: match[2] }],
    internal_chat_message_metadata_passthrough: { turn_id: turnId, content_item_kinds: ['user.text'] },
  } };
}
