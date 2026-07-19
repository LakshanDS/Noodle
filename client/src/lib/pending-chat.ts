/**
 * Ephemeral cross-route handoff for a chat's first message.
 *
 * When the user submits a prompt from the ChatsView composer, the chat row is
 * created and the router flips to /chats/:id — but the prompt text needs to
 * reach ChatDetailView so it can kick off the first run. Router state would
 * survive a reload (fragile + leaks into the URL), so we keep it in a plain
 * module-scoped variable instead: ChatsView `set`s it before navigating,
 * ChatDetailView `take`s it on mount (which also clears it). A hard reload
 * after navigation loses the pending prompt — acceptable, the chat row still
 * exists and the user can retype.
 */
let pending: string | null = null;

/** Stash the first prompt so ChatDetailView can send it on mount. */
export function setPendingFirstMessage(text: string): void {
  pending = text || null;
}

/** Read and clear the pending prompt. Returns "" if nothing is pending. */
export function takePendingFirstMessage(): string {
  const out = pending ?? "";
  pending = null;
  return out;
}
