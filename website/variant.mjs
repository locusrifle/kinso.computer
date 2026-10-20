// Who the site is for. imperfect.computer is imperfect. kinso.computer is Noah's application to Kinso: the same launch,
// told as "here's what I would do if I were Kinso" (~/workbench/kinso-computer/script.md). ?for=kinso shows the Kinso
// one on any address (a local server, a preview). Everything that differs between the two is read from `variant`.
export const KINSO_HOSTS = Object.freeze(['kinso.computer', 'www.kinso.computer']);

export function variantId({ hostname = '', search = '' } = {}) {
  if (KINSO_HOSTS.includes(String(hostname).toLowerCase())) return 'kinso';
  try { if (new URLSearchParams(search).get('for') === 'kinso') return 'kinso'; } catch { /* no company */ }
  return 'imperfect';
}

const DOCK = Object.freeze({
  imperfect: [
    ['finder', 'Finder'], ['safari', 'Safari'], ['claude', 'Claude'], ['chatgpt', 'ChatGPT'],
    ['imperfect', 'imperfect'], ['final-cut', 'Final Cut Pro'], ['imovie', 'iMovie'],
    ['notes', 'Notes'], ['settings', 'System Settings'], ['app-store', 'App Store'],
    ['launchpad', 'Launchpad'], ['trash', 'Trash'],
  ],
  // The harnesses, files, browser and the three inboxes all fold into Kinso; nothing goes to the Trash.
  kinso: [
    ['finder', 'Finder'], ['safari', 'Safari'], ['claude', 'Claude Code'], ['chatgpt', 'Codex'],
    ['gmail', 'Gmail'], ['linkedin', 'LinkedIn'], ['instagram', 'Instagram'],
    ['kinso', 'Kinso'], ['settings', 'System Settings'], ['app-store', 'App Store'],
    ['launchpad', 'Launchpad'], ['trash', 'Trash'],
  ],
});

// A word drawn white on transparent, filling a w x h box (a quarter of it, as the wordmark only scales it): the
// stand-in for a wordmark that could not be loaded.
function standIn(word, [w, h]) {
  const canvas = document.createElement('canvas'); canvas.width = Math.round(w / 4); canvas.height = Math.round(h / 4);
  const ctx = canvas.getContext('2d'), size = canvas.height * .98;
  ctx.font = `600 ${size}px -apple-system, BlinkMacSystemFont, system-ui, 'Segoe UI', Roboto, sans-serif`;
  const bare = ctx.measureText(word).width, gap = Math.max(0, (canvas.width - bare) / (word.length - 1));
  ctx.fillStyle = '#fff'; ctx.textBaseline = 'alphabetic';
  let x = 0; const base = canvas.height * .86, squeeze = Math.min(1, canvas.width / bare);
  for (const letter of word) {
    const width = ctx.measureText(letter).width * squeeze;
    ctx.save(); ctx.translate(x, base); ctx.scale(squeeze, 1); ctx.fillText(letter, 0, 0); ctx.restore();
    x += width + gap * squeeze;
  }
  return canvas;
}

export const VARIANTS = Object.freeze({
  imperfect: Object.freeze({
    id: 'imperfect',
    // The app in the Dock and the menu bar, and the Mac window's title.
    app: 'imperfect', name: 'imperfect',
    title: null, // index.html's own
    // The word the bubble bursts into (wordmark.mjs): its white-on-transparent mask, its pixel size, and where its
    // ink's mass sits from the image's centre (a share of the image, x right, y down; intro/goat.mjs).
    lettering: Object.freeze({ src: new URL('assets/wordmark/imperfect-spiky.png', import.meta.url).href, size: [1301, 728], mass: [-0.02658, -0.00128] }),
    lock: null, // macos/lock.mjs LOCK_USER
    dock: DOCK.imperfect,
    // The steps the product inside paints, in order (launch.mjs, apps/code/native/public/js/assembly.js).
    assembly: Object.freeze(['bare', 'claude', 'codex', 'files', 'browser', 'done']),
    // What the framed computer is told it is for (launch.mjs), and the Shop it opens (shop.mjs): none.
    for: null,
    phone: true,
    menu: Object.freeze({ last: 'Shop', help: 'imperfect.computer' }),
  }),
  kinso: Object.freeze({
    id: 'kinso',
    app: 'kinso', name: 'Kinso',
    title: 'Kinso Computer',
    // Kinso's own wordmark, KINSO in white (kinso.ai's header in dark mode). It is theirs, so it is never in this source:
    // the locker serves it from the git-ignored rebuild of their page (/kinso/a/, locker/server.mjs). Where that is
    // missing, the word is set in a plain sans instead (standIn). Its mass is measured as goat.mjs says. It stays on
    // through the lock, the sharks swimming round it (wordmark.mjs wordmarkAt, for-kinso/lock-sharks.mjs).
    lettering: Object.freeze({ src: '/kinso/a/e838d36149f98461.png', size: [4873, 863], mass: [0.00572, -0.0249], stays: true,
      standIn: () => standIn('KINSO', [4873, 863]) }),
    lock: Object.freeze({ name: 'Kinso' }),
    dock: DOCK.kinso,
    assembly: Object.freeze(['bare', 'claude', 'codex', 'files', 'browser', 'messages', 'done']),
    for: 'kinso',
    phone: false,
    menu: Object.freeze({ last: 'Code', help: 'Kinso Computer' }),
    // What Code in the menu bar gives to copy: paste it into your own agent and it installs this computer, from
    // Kinso's own repository (kinso.computer/install: locker/public/install-kinso.sh).
    install: 'curl -fsSL https://kinso.computer/install | sh',
  }),
});

export const variant = VARIANTS[variantId(globalThis.location ?? {})];
