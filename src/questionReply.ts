export function readableQuestionReply(text: string) {
  const source = text.trim(), start = "<send_user_message_question_reply>", end = "</send_user_message_question_reply>";
  if (!source.startsWith(start) || !source.endsWith(end)) return text;
  try {
    const value = JSON.parse(source.slice(start.length, -end.length));
    const rows = Array.isArray(value) ? value : [value];
    if (!rows.length || rows.some(row => !row || typeof row.question !== "string" || typeof row.answer !== "string" || typeof row.questionItemId !== "string")) return text;
    return rows.map(row => `回答：${row.question}\n\n${row.answer}`).join("\n\n");
  } catch { return text; }
}
