import { useState } from "react";
import ConversationMessage from "./ConversationMessage";
import type { Message } from "./conversationFeed";

// Local disclosure only. UserQueryBody already keeps its own DOM, selection and
// animation anchor; historical rows never acquire query delivery controls.
export default function EarlierHistoryMessage({ message, threadId }: { message: Message; threadId: string }) {
  const [expanded, setExpanded] = useState(false);
  return <ConversationMessage message={message} threadId={threadId}
    queryDisclosure={message.role === "user" ? { expanded, toggle: open => setExpanded(open) } : undefined} />;
}
