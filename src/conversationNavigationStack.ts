export type ConversationNavigationOwner = { machine: string | null; readingScope?: string };
export const conversationNavigationStackLimit = 32;

// Page-local visit history only. Selection, pending links, read positions and
// availability belong to the caller; this stack retains only parent IDs.
export class ConversationNavigationStack {
  private owner: ConversationNavigationOwner;
  private parents: string[] = [];

  constructor(owner: ConversationNavigationOwner) {
    this.owner = { ...owner };
  }

  get depth() { return this.parents.length; }

  setOwner(owner: ConversationNavigationOwner) {
    if (this.owner.machine === owner.machine && this.owner.readingScope === owner.readingScope) return false;
    this.owner = { ...owner };
    this.clear();
    return true;
  }

  // Call only after the destination has actually become selected. Starting a
  // pending request must not add a parent or erase the existing visit chain.
  push(from: string | null, to: string) {
    if (!to) return false;
    if (!from) { this.clear(); return false; }
    if (from === to || !this.owner.machine || !this.owner.readingScope || this.owner.readingScope === "unknown") return false;
    this.parents.push(from);
    if (this.parents.length > conversationNavigationStackLimit) this.parents.shift();
    return true;
  }

  // A list selection or other root replacement begins a new visit chain.
  replace() { this.clear(); }

  clear() { this.parents.length = 0; }

  back(current: string | null, isAvailable: (threadId: string) => boolean): string | null {
    if (!current) { this.clear(); return null; }
    while (this.parents.length) {
      const parent = this.parents.pop()!;
      if (parent !== current && isAvailable(parent)) return parent;
    }
    return null;
  }
}
