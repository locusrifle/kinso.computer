import { randomUUID } from 'node:crypto';

// The window's side of what a harness asks a person, not a terminal renderer:
// the dialogs (select, confirm, input, editor, AskUserQuestion's questions),
// and an extension's warnings and errors, which `notice` puts in the
// conversation. What else an extension would draw has nowhere to go here. Pi calls these methods directly;
// Claude asks through canUseTool; imperfect's tools through mcp.mjs.
export function createExtensionUI(changed, notice = () => {}) {
  const dialogs = new Map();
  const state = { dialogs: [] };
  const update = () => { state.dialogs = [...dialogs.values()].map(d => d.request); changed(); };
  function ask(method, title, fields = {}, opts = {}) {
    if (opts.signal?.aborted) return Promise.resolve(method === 'confirm' ? false : undefined);
    const id = randomUUID();
    return new Promise(resolve => {
      let timer;
      const finish = value => {
        clearTimeout(timer); opts.signal?.removeEventListener('abort', cancel);
        dialogs.delete(id); update(); resolve(value);
      };
      const cancel = () => finish(method === 'confirm' ? false : undefined);
      dialogs.set(id, { request: { id, method, title, ...fields }, finish, cancel });
      opts.signal?.addEventListener('abort', cancel, { once: true });
      if (opts.timeout > 0) timer = setTimeout(cancel, opts.timeout);
      update();
    });
  }
  const ignore = () => {};
  const ui = {
    // opts.message: words to read above the choices (what is being asked about, in full).
    select: (title, options, opts) => ask('select', title, { options, ...(opts?.message ? { message: String(opts.message) } : {}) }, opts),
    confirm: (title, message, opts) => ask('confirm', title, { message }, opts),
    // AskUserQuestion: one or more questions, each with its own options and
    // an implicit 'Other' free text. The reply is an answers map, one entry
    // per question, so it gets its own method rather than 'select'.
    askQuestions: (questions, opts) => ask('questions', questions[0]?.header || 'a question', { questions }, opts),
    input: (title, placeholder, opts) => ask('input', title, { placeholder }, opts),
    editor: (title, prefill) => ask('editor', title, { prefill }),
    notify: (message, type = 'info') => { if (type === 'error' || type === 'warning') notice(String(message)); },
    getEditorText: () => '',
    custom: async () => undefined,
    onTerminalInput: () => ignore,
    getToolsExpanded: () => false,
    getEditorComponent: () => undefined,
    getAllThemes: () => [], getTheme: () => undefined,
    setTheme: () => ({ success: false, error: 'imperfect is styled by its own themes' }),
    // Extensions may format status text; no ANSI is needed in a browser.
    theme: new Proxy({}, { get: (_, key) => key === 'fg' || key === 'bg' ? (_color, text) => text : text => text }),
  };
  for (const name of ['setWidget', 'setEditorText', 'pasteToEditor', 'setStatus', 'setTitle', 'setFooter', 'setHeader', 'setEditorComponent', 'addAutocompleteProvider', 'setToolsExpanded', 'setWorkingIndicator', 'setHiddenThinkingLabel', 'setWorkingMessage', 'setWorkingVisible']) ui[name] = ignore;
  return {
    ui, state,
    respond({ id, value, confirmed, cancelled }) {
      const d = dialogs.get(id);
      if (!d) throw new Error('Dialog expired or already answered');
      if (cancelled) return d.cancel();
      if (d.request.method === 'select' && !d.request.options.includes(value)) throw new Error('Invalid dialog option');
      if (d.request.method === 'questions') {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Answers required');
        d.finish(value);
        return;
      }
      if (d.request.method !== 'confirm' && typeof value !== 'string') throw new Error('Text response required');
      d.finish(d.request.method === 'confirm' ? confirmed === true : value);
    },
    reset() { for (const d of [...dialogs.values()]) d.cancel(); update(); },
  };
}
