// The recording has already landed through /upload on the execution owner.
// Only references and the captured destination cross this small JSON door.
import { readAttachmentJson } from '../apps/code/native/uploads.mjs';
import { staleCommandError } from '../apps/code/native/public/js/session-logic.js';

const fault = (status, message) => Object.assign(new Error(message), { status });

export function createDictation({ runtime, hear, openAudio }) {
  function check(prompt) {
    const snapshot = runtime.snapshot(prompt.tab);
    if (prompt.session == null) {
      if (!prompt.instanceId || !snapshot.instanceId) throw fault(409, 'update imperfect on the session computer, or send a typed first message before recording; nothing was sent');
      if (prompt.instanceId !== snapshot.instanceId) throw fault(409, 'the session computer restarted; nothing was sent');
    }
    const tab = snapshot.tabs?.find(item => item.id === prompt.tab);
    if (!tab || !tab.focused || staleCommandError({ type: 'prompt', expectedTabId: prompt.tab, expectedSessionId: prompt.session }, snapshot)) throw fault(409, 'that session is no longer open here; nothing was sent');
  }
  return async function handle(req, res, path) {
    if (path !== '/dictate' || req.method !== 'POST') return false;
    const json = (status, value) => {
      if (res.headersSent || res.destroyed) return;
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(value));
    };
    if (!req.headers.origin) { json(403, { error: 'exact origin required' }); return true; }
    try {
      const prompt = await readAttachmentJson(req);
      if (typeof prompt?.tab !== 'string' || !prompt.tab || !prompt.audio) throw fault(400, 'recording reference and destination tab required');
      check(prompt);
      const audio = await openAudio(prompt);
      let words;
      try { words = (await hear(audio)).text?.trim() ?? ''; }
      finally { audio.destroy(); }
      if (!words) throw fault(422, 'no words were heard in the recording; nothing was sent');
      if (req.aborted || res.destroyed) return true;
      check(prompt); // Hearing may outlast a tab, session, or host lifetime.
      const text = [String(prompt.text ?? '').trim(), words].filter(Boolean).join('\n\n');
      if (text.length > 200000) throw fault(413, 'that is too long to send');
      const result = await runtime.command({ type: 'prompt', text,
        ...(prompt.attachments?.length ? { attachments: prompt.attachments } : {}),
        ...(prompt.images?.length ? { images: prompt.images } : {}),
        ...(prompt.requestId ? { requestId: String(prompt.requestId) } : {}),
        expectedTabId: prompt.tab, expectedSessionId: prompt.session,
        ...(prompt.session == null ? { expectedInstanceId: prompt.instanceId } : {}),
      }, prompt.tab, { isCancelled: () => req.aborted || res.destroyed });
      if (result?.accepted === false) throw fault(409, result.error || 'the session did not take it');
      json(200, { accepted: true, words, ...(result?.queued ? { queued: true } : {}) });
    } catch (error) { json(error.status || 422, { error: error.message }); }
    return true;
  };
}
