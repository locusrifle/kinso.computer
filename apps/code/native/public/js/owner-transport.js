// One instance per verified owner. Selection and reconnect policy belong to the UI.
export const ownerSessionKey = (owner, session) => JSON.stringify([owner, session]);
export function ownerSocketURL(base, owner, selfId) {
  if (!owner || !selfId) throw new Error('Execution owner required');
  const url = new URL(owner === selfId ? '/pi' : `/peer/${encodeURIComponent(owner)}/pi`, base);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.href;
}

// A socket still opening after connectTimeoutMs is given up: a phone whose
// network is coming back can leave one opening for minutes, and nothing else
// would ever replace it.
export function createOwnerTransport({ owner, selfId, base, WebSocketImpl = WebSocket,
  onMessage = () => {}, onStatus = () => {}, timeoutMs = 30000, connectTimeoutMs = 8000,
  now = () => Date.now(), requestId = () => crypto.randomUUID(), limit = 100 * 1024 * 1024 }) {
  const url = ownerSocketURL(base, owner, selfId);
  let socket = null, snapshot = null, openedAt = 0, opening = 0, checking = null;
  const pending = new Map();
  const failure = (message, id, acceptanceUnknown) => Object.assign(new Error(message), { owner, requestId: id, acceptanceUnknown });
  function disconnect(next) {
    if (socket !== next) return;
    socket = null; openedAt = 0;
    clearTimeout(opening);
    for (const [id, waiter] of pending) { clearTimeout(waiter.timer); waiter.reject(failure('Connection lost; acceptance may be unknown', id, true)); }
    pending.clear();
    next.close();
    onStatus(owner, 'closed');
  }
  const transport = {
    owner,
    get snapshot() { return snapshot; },
    get socket() { return socket; },
    // When the socket in use opened: what arrives on it is no older than this.
    get openedAt() { return openedAt; },
    connect() {
      if (socket) return socket;
      const next = socket = new WebSocketImpl(url);
      opening = setTimeout(() => { if (socket === next && next.readyState !== 1) disconnect(next); }, connectTimeoutMs);
      next.onopen = () => { if (socket !== next) return; clearTimeout(opening); openedAt = now(); onStatus(owner, 'open'); };
      next.onclose = next.onerror = () => disconnect(next);
      next.onmessage = event => {
        if (socket !== next) return;
        let message;
        try { message = JSON.parse(event.data); } catch { disconnect(next); return; }
        if (!message || typeof message !== 'object') { disconnect(next); return; }
        if (message.type === 'response') {
          const waiter = pending.get(message.id);
          if (waiter) {
            pending.delete(message.id); clearTimeout(waiter.timer);
            if (message.success) waiter.resolve(message.data);
            else waiter.reject(failure(message.error || 'Command rejected', message.id, false));
          }
          return;
        }
        if (message.type === 'snapshot') snapshot = message.data;
        onMessage(owner, message);
      };
      return next;
    },
    // A command may carry its own deadline: a probe of a socket that may be
    // dead has to give up in a moment, not in half a minute.
    command(type, fields = {}, { timeoutMs: deadline = timeoutMs } = {}) {
      const id = fields.id ?? requestId();
      if (!socket || socket.readyState !== 1) return Promise.reject(failure('Owner not connected', id, false));
      if (pending.has(id)) return Promise.reject(failure('Request already pending', id, false));
      const data = JSON.stringify({ ...fields, type, id });
      if (new TextEncoder().encode(data).length + socket.bufferedAmount > limit) return Promise.reject(failure('Owner transport buffer full', id, false));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(failure('Command timed out; acceptance may be unknown', id, true)); }, deadline);
        pending.set(id, { resolve, reject, timer });
        try { socket.send(data); } catch { disconnect(socket); }
      });
    },
    // Is the socket alive now? A socket that reads as open may be long dead (a
    // phone's network goes with its screen, and TCP takes minutes to say so),
    // so it is asked, and one that does not answer within timeoutMs is let go
    // (onStatus 'closed'). None, or one still opening: it is (re)connected and
    // the answer is null, for what arrives once it opens to settle. An answer
    // is { at }: when the question was sent. Everything the socket carried
    // before that has arrived by the time it is answered, in order.
    check({ timeoutMs: deadline = 1500, fields = {} } = {}) {
      if (!socket || socket.readyState !== 1) { transport.connect(); return Promise.resolve(null); }
      if (checking) return checking;
      const asked = socket, at = now();
      checking = transport.command('hello', fields, { timeoutMs: deadline })
        .then(() => (socket === asked ? { at } : null), error => {
          // Refused is still an answer: only silence is a dead socket.
          if (socket === asked && error.acceptanceUnknown) disconnect(asked);
          return socket === asked && !error.acceptanceUnknown ? { at } : null;
        })
        .finally(() => { checking = null; });
      return checking;
    },
    close() { if (socket) disconnect(socket); },
  };
  return transport;
}
