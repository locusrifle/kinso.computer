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

// A quiet stand-in when Kinso's untracked artwork is absent: two opposing, interlocked outlines, not a word.
function standInLogo() {
  const canvas = document.createElement('canvas'); canvas.width = 230; canvas.height = 256;
  const ctx = canvas.getContext('2d'), gradient = ctx.createLinearGradient(0, 0, 230, 256);
  gradient.addColorStop(0, '#f45a20'); gradient.addColorStop(.5, '#ffd1be'); gradient.addColorStop(1, '#398e91');
  ctx.strokeStyle = gradient; ctx.lineWidth = 12; ctx.lineJoin = 'round';
  for (const flip of [false, true]) {
    ctx.save(); if (flip) { ctx.translate(230, 256); ctx.rotate(Math.PI); }
    ctx.beginPath(); ctx.moveTo(24, 8); ctx.lineTo(118, 8); ctx.quadraticCurveTo(148, 8, 148, 38);
    ctx.lineTo(148, 165); ctx.quadraticCurveTo(148, 194, 119, 194); ctx.lineTo(24, 194);
    ctx.quadraticCurveTo(2, 194, 10, 177); ctx.lineTo(48, 101); ctx.lineTo(10, 27);
    ctx.quadraticCurveTo(2, 8, 24, 8); ctx.closePath(); ctx.stroke(); ctx.restore();
  }
  return canvas;
}

// The Mac's own night wallpaper: imperfect.computer's desktop, and what shows wherever another is missing.
const NIGHT = new URL('mac/wallpaper.webp', import.meta.url).href;

export const VARIANTS = Object.freeze({
  imperfect: Object.freeze({
    id: 'imperfect',
    // The app in the Dock and the menu bar, and the Mac window's title.
    app: 'imperfect', name: 'imperfect',
    wallpaper: NIGHT,
    wallpapers: Object.freeze([NIGHT]),
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
    // Tahlia's photograph (Apple's, git-ignored), over the night for a copy without it (launch.mjs).
    wallpaper: new URL('mac/wallpaper-kinso.webp', import.meta.url).href,
    wallpapers: Object.freeze([new URL('mac/wallpaper-kinso.webp', import.meta.url).href, NIGHT]),
    title: 'Kinso Computer',
    // Their colour logo lives only in the git-ignored rebuild (/kinso/a/). Its alpha x luminance mass is measured
    // on the original colours (intro/goat.mjs). The near-square mark needs its own scale, not a word's width.
    lettering: Object.freeze({ src: '/kinso/a/aa106999c9d67289.png', size: [919, 1024], mass: [-0.00547, 0.01372], colour: true,
      scale: Object.freeze({ height: .22, phoneWidth: .36 }), stays: true, standIn: standInLogo,
      drawOn: Object.freeze({ src: '/kinso/logo-draw.svg?v=kinso-logo-lock-1', timing: '/kinso/logo-draw.json?v=kinso-logo-lock-1' }) }),
    lock: Object.freeze({ name: 'Kinso' }),
    dock: DOCK.kinso,
    assembly: Object.freeze(['bare', 'claude', 'codex', 'files', 'browser', 'messages', 'done']),
    for: 'kinso',
    phone: false,
    menu: Object.freeze({ last: null, help: 'Kinso Computer' }),
    // What Get yours unlocks: paste it into your own agent and it installs this computer, from
    // Kinso's own repository (kinso.computer/install: locker/public/install-kinso.sh).
    install: 'curl -fsSL https://kinso.computer/install | sh',
    // ...once its source is paid for: one payment (Noah: "one off payment for the source"). A paywall, not a lock: the
    // repository stays public. The locker sells it (locker/shop.mjs, /source); kinso.computer/source shows it after.
    source: Object.freeze({ price: 39, label: 'US$39', page: '/source', checkout: '/source/checkout', status: '/source/status' }),
  }),
});

export const variant = VARIANTS[variantId(globalThis.location ?? {})];
