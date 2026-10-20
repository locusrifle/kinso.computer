// The keys: one registry of every binding, which answers the key and teaches
// it (MOD+K lists activeKeyBindings()).

// Alt and Option are the same physical key, but a visitor reads the label printed
// on the hardware in front of them. The bindings themselves are keyed by event.code
// and are unaffected; only what we call the key changes.
export function isApplePlatform() {
  const ua = navigator.userAgent || "";
  const platform = navigator.userAgentData?.platform || navigator.platform || "";
  if (/windows|win32|linux|android|cros/i.test(platform)) return false;
  if (/mac|iphone|ipad|ipod/i.test(platform)) return true;
  return /macintosh|mac os x|iphone|ipad|ipod/i.test(ua) && !/windows|android/i.test(ua);
}

// The one modifier every imperfect key is held with, and what it is called.
// In imperfect's own desktop window (preload.cjs gives it imperfectDesk) it is
// Super: under imperfect OS no window manager takes Super, and Alt is left to
// apps and text. Alt answers there too, unannounced, only under a window
// manager that keeps most Super keys for itself (Hyprland), as the window
// says (desktop/electron/keys.mjs); a window opened before it said keeps it.
// Electron hears them in websites and frames too (desktop/electron/main.mjs).
// Anywhere else (a browser, the phone, the demo) it is Alt, or Option on a
// Mac: Super there is the Windows key or Cmd, and the browser keeps those
// (Cmd+1 to 5 are its tabs).
// On a Mac the desktop window is held with Option, as a browser there is:
// Cmd stays the Mac's own (desktop/electron/keys.mjs).
const DESK = Boolean(globalThis.imperfectDesk);
const DESK_OPTION = DESK && globalThis.imperfectDesk.mod === "alt";
const ALT_ALIAS = DESK && globalThis.imperfectDesk.altAlias !== false;
export const MOD = DESK && !DESK_OPTION ? "Super" : isApplePlatform() ? "Opt" : "Alt";

// Whether the modifier, and only it of Alt and Super, is held.
export function heldMod(event) {
  if (!DESK || DESK_OPTION) return event.altKey && !event.metaKey;
  return event.metaKey ? !event.altKey : ALT_ALIAS && event.altKey;
}

const KEY_BINDINGS = [];

function matches(binding, event) {
  // A synthetic keyboard (wtype) sends its first typed key as Escape's
  // physical code: Super+L arrived as Super+Esc and closed sessions. Named
  // keys must agree with what was typed; letters stay physical, so every
  // keyboard layout keeps its shortcuts.
  const named = /^(Escape|Backspace|Delete|Enter|Tab|Arrow(?:Up|Down|Left|Right)|Home|End|PageUp|PageDown)$/.test(binding.code);
  if (named && event.key !== binding.code) return false;
  return event.code === binding.code && event.ctrlKey === binding.ctrl && event.shiftKey === binding.shift &&
    (binding.mod ? heldMod(event) : !event.altKey && !event.metaKey);
}

// A binding is both the handler and the description used by the guide. Keeping
// those together prevents the guide from teaching a key that the surface does
// not actually answer. Auto-repeat is refused by asking the event.
// A binding held with the modifier says mod: true, and its label names it (MOD).
// A late one hears the key last, and only if nothing nearer used it first.
export function registerKeyBinding({ label, description, code, mod = false, ctrl = false, shift = false, when, handler, consumeRepeat = false, target = window, late = false }) {
  const binding = { label, description, code, mod, ctrl, shift, when: when ?? (() => true), handler };
  KEY_BINDINGS.push(binding);
  target.addEventListener("keydown", event => {
    if ((event.repeat && !consumeRepeat) || (late && event.defaultPrevented) || !matches(binding, event) || !binding.when(event)) return;
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat) binding.handler?.(event);
  }, !late);
  return binding;
}

export function activeKeyBindings() {
  // Electron owns these before DOM dispatch (desktop/electron/edit.mjs).
  // Teach them here, without installing a second renderer key handler.
  const editing = MOD === 'Super' ? [
    ['C', 'copy'], ['V', 'paste'], ['X', 'cut'], ['A', 'select all'],
    ['Z', 'undo'], ['Shift+Z', 'redo'],
  ].map(([key, description]) => ({ label: `Super+${key}`, description })) : [];
  return editing.concat(KEY_BINDINGS.filter(binding => {
    try { return binding.when(); } catch { return false; }
  }).map(({ label, description }) => ({ label, description })));
}

// Still imported by site.js, which another session is editing: both go
// with site.js's own calls to them.
export function grid() {}
export function bindHarnessKeys() {}
