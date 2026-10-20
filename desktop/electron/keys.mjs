// The windows' keys (harness.js), wherever the keyboard is in imperfect's
// window, held with Super, the window's modifier (public/js/pi-card.js).
// Super+W closes, Super+Left and Super+Right bring the next window out of
// sight on that side into view (never the website's history or tabs),
// Super+L tiles the windows the other way, Super+Up and Super+Down
// are the session before and after, Super+F is full screen, Super+Shift+Enter
// lays the input bar over it, Super+Shift+Left and Super+Shift+Right move the
// columns along, Super+Shift+B is the browser, Super+1 to Super+5 select the
// first five sessions, Super+Shift+V is what was copied (Super+V pastes,
// edit.mjs); Super itself going down
// and up (hold, release) lets the canvas pick a window up under the pointer.
// The canvas hears them itself, except in a page playing in a frame of it; a
// website in a tab never does. From those they come here (main.mjs), and go
// to the canvas.

// Whether Alt answers for Super too, unannounced: only under a window manager
// that keeps Super keys for itself (Hyprland on Omarchy only).
// Under imperfect OS's sway nothing takes Super, and Alt is left to apps and
// text. Told by the session the window runs in, never the computer's name.
export function altAlias(env = process.env) {
  if (env.SWAYSOCK || /(^|:)sway(:|$)/i.test(env.XDG_CURRENT_DESKTOP ?? '')) return false;
  return Boolean(env.HYPRLAND_INSTANCE_SIGNATURE) || /(^|:)Hyprland(:|$)/i.test(env.XDG_CURRENT_DESKTOP ?? '');
}

// The window's modifier: Super ('meta'), but on a Mac Option ('alt'). Cmd
// there is the Mac's own (copy, paste, tabs, quit), and Option is what
// imperfect is held with in any browser on a Mac too (public/js/pi-card.js).
export const deskModifier = (platform = process.platform) => (platform === 'darwin' ? 'alt' : 'meta');
const modHeld = ({ alt, meta }, alias, mod) => (mod === 'alt' ? alt && !meta : meta ? !alt : alias && alt);

// The key an input event is, or ''. Super and Alt together are neither.
export function windowKey({ type, code, key, alt, control, meta, shift }, { alias = true, mod = 'meta' } = {}) {
  if (type !== 'keyDown' || control || !modHeld({ alt, meta }, alias, mod)) return '';
  if (/^(Arrow(?:Left|Right|Up|Down)|Enter)$/.test(code) && key !== code) return '';
  if (code === 'ArrowLeft') return shift ? 'back' : 'previous';
  if (code === 'ArrowRight') return shift ? 'along' : 'next';
  if (code === 'ArrowUp' || code === 'ArrowDown') return shift ? '' : code === 'ArrowUp' ? 'up' : 'down';
  if (!shift && /^Digit[1-5]$/.test(code)) return `session${code.slice(5)}`;
  if (code === 'KeyV') return Boolean(shift) === (mod === 'meta') ? 'clipboard' : '';
  return (shift ? { Enter: 'over', KeyB: 'browser', KeyF: 'fullWindow' } : { KeyW: 'close', KeyF: 'full', KeyL: 'layout' })[code] ?? '';
}

// The modifier key itself pressed or let go: 'hold', 'release' or ''. Never
// taken from the page; it only says so.
export function modifierKey({ type, code, key }, { alias = true, mod = 'meta' } = {}) {
  const isMod = mod === 'alt' ? /^Alt(Left|Right)$/.test(code) : /^Meta(Left|Right)$/.test(code) || key === 'Meta' || (alias && /^Alt(Left|Right)$/.test(code));
  if (!isMod) return '';
  return type === 'keyDown' ? 'hold' : type === 'keyUp' ? 'release' : '';
}
