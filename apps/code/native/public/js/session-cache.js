// A snapshot carries the newest part of a conversation, from messagesFrom
// in the whole of it (server.mjs); older pages are fetched as the reader
// scrolls up. A whole snapshot of the session already held keeps what was
// fetched before it, and the same message objects, so a redraw can reuse
// its nodes; a delta (messagesBase, messagesTail) appends. Null when the
// delta does not follow what is held, and the whole must be asked for.
const same = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b);
export function joinSnapshot(previous, data) {
  const held = previous?.sessionId === data?.sessionId ? previous : null;
  const heldFrom = held?.messagesFrom ?? 0, heldMessages = held?.messages ?? [];
  if (Array.isArray(data?.messagesTail)) {
    if (!held || heldFrom + heldMessages.length !== data.messagesBase) return null;
    const { messagesTail, messagesBase, ...rest } = data;
    return { ...rest, messagesFrom: heldFrom, messages: messagesTail.length ? heldMessages.concat(messagesTail) : heldMessages };
  }
  if (!Array.isArray(data?.messages)) return null;
  const from = data.messagesFrom ?? 0;
  const offset = from - heldFrom;
  if (!held || offset < 0 || offset > heldMessages.length) return { ...data, messagesFrom: from };
  let messages = data.messages.map((message, i) => same(message, heldMessages[offset + i]) ? heldMessages[offset + i] : message);
  // What was held before it only belongs if it leads up to it unchanged.
  if (offset && messages[0] !== heldMessages[offset]) return { ...data, messagesFrom: from };
  if (offset) messages = heldMessages.slice(0, offset).concat(messages);
  if (messages.length === heldMessages.length && messages.every((m, i) => m === heldMessages[i])) messages = heldMessages;
  return { ...data, messagesFrom: heldFrom, messages };
}

// Memory only, scoped to one live connection. A reconnect discards it.
// Keep message objects stable so revisiting a transcript can reuse its DOM.
export function createSessionCache(limit = 32) {
  const entries = new Map();
  return {
    clear() { entries.clear(); },
    get(id, sessionId) {
      const data = entries.get(id);
      return data && (!sessionId || data.sessionId === sessionId) ? data : null;
    },
    accept(id, data) {
      if (!id || !data?.sessionId) return null;
      const fresh = joinSnapshot(entries.get(id), data);
      if (!fresh) { entries.delete(id); return null; }
      entries.delete(id); entries.set(id, fresh);
      for (const key of entries.keys()) { if (entries.size <= limit) break; entries.delete(key); }
      return fresh;
    },
    // Kept as it is, joined to nothing: a view seen before, to show again at
    // once (marked stale) while the current one is fetched.
    keep(id, data) {
      if (!id || !data?.sessionId) return;
      entries.delete(id); entries.set(id, data);
      for (const key of entries.keys()) { if (entries.size <= limit) break; entries.delete(key); }
    },
    prune(tabs) {
      for (const [id, data] of entries) if (!tabs.some(tab => tab.id === id && tab.sessionId === data.sessionId)) entries.delete(id);
    },
  };
}
