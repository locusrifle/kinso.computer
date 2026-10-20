// The wordmark: Noah's lettering of "imperfect" (on kinso.computer, Kinso's own: variant.mjs), alone in the middle of the
// screen. The website (galaxy.mjs) and the lock (desktop/lock) draw it with this one module, on the same contact
// clock as the bubble, so both agree to the frame. Its timeline, in seconds after contact:
//   there     from the contact it is already there, whole, on the wallpaper: the bubble is a portal onto that
//             scene, so the word is seen through it while it bubbles, and is simply there when it opens.
//   shine     one soft band of light sweeps it left to right: its centre on the first letter at SHINE.start, on the
//             last at SHINE.end, then it fades. A band over the letters only, never a flare.
//   hold      it stays, whole and alone, HOLD seconds from the moment it is whole (WORD.out),
//   fade      then fades over WORDMARK.fade. Only once it has gone (WORD.gone) do the lock's field and the website's
//             box come in at the same middle, over FIELD_IN.
import { BURST } from './bootup.mjs';
import { variant } from './variant.mjs?v=kinso-install-1';

// The lettering, one setting: any white-on-transparent mask (its alpha is the letters, cropped to them) and its pixel
// size. Noah's choice: the Anomaly-style "spiky" brush (~/workbench/bootup/lettering/imperfect-anomaly-2-spiky-clean.png,
// cropped, its black made transparent). kinso.computer's is Kinso's own wordmark, with a stand-in drawn by the page
// should it be missing (variant.mjs).
export const LETTERING = Object.freeze({ src: variant.lettering.src, size: variant.lettering.size, standIn: variant.lettering.standIn ?? null, stays: Boolean(variant.lettering.stays) });
// Seconds it stays whole and alone before it fades.
export const HOLD = 2;
// The shine, in seconds after contact: when the band's centre is on the first letter, and on the last. Noah's marks,
// tapped to the recording. The word gathers by the first.
export const SHINE = Object.freeze({ start: 6.01, end: 6.493 });
export const WORDMARK = Object.freeze({
  condense: SHINE.start - BURST, // s from BURST until it is whole and sharp: as the light reaches it (0.643 s)
  blur: 0.012,     // the starting blur, as a share of its width
  grow: 0.05,      // the starting extra size
  soft: 0.18,      // the grains' soft edge (a share of the noise's range)
  grain: 1.6,      // css px a grain
  band: 0.2,       // the shine's width, as a share of the wordmark's
  slant: 0.36,     // its lean (tan): a "/"
  after: 0.2,      // s the shine fades once past the last letter
  light: 1,        // its strength at the centre: the full ink, over letters at 64-90% of it
  fade: 0.6,       // s the word takes to go, once held
});
// What follows the word, on both: the lock's field and the website's box come in over this long once it has gone.
export const FIELD_IN = 0.5;
const whole = SHINE.start;
export const WORD = Object.freeze({ whole, out: whole + HOLD, gone: whole + HOLD + WORDMARK.fade });
const clamp = x => Math.max(0, Math.min(1, x));
const smooth = x => { x = clamp(x); return x * x * (3 - 2 * x); };

// Where it stands, the same on both: centred on a vw x vh screen. [left, top, width, height], css px.
export function placeWordmark(vw, vh) {
  const [lw, lh] = LETTERING.size, w = vw < vh ? vw * 0.84 : Math.min(vw * 0.44, vh * 0.8 * lw / lh, 980), h = w * lh / lw;
  return [(vw - w) / 2, (vh - h) / 2, w, h];
}

// The wordmark at tau seconds after contact: whole and unlit from the contact (seen through the bubble), lit once by
// the shine, held, then faded. still (reduced motion, no moving sky): the same, never lit. Before the contact, after
// it has gone, or with no contact: off. stays (kinso.computer's, variant.mjs): it never fades, and the lock comes in
// around it at WORD.gone all the same ("it says Kinso, and then the sharks start to swim in, at the same time the lock
// box appears").
export function wordmarkAt(tau, { still = false, stays = LETTERING.stays } = {}) {
  if (!(tau >= 0) || (tau >= WORD.gone && !stays)) return { on: false, formed: tau >= 0 ? 1 : 0, opacity: 0, blur: 0, scale: 1, shine: null };
  const W = WORDMARK, held = stays ? 1 : 1 - smooth((tau - WORD.out) / W.fade);
  if (still) return { on: true, formed: 1, opacity: held, blur: 0, scale: 1, shine: null };
  // the band's centre: 0 on the first letter at SHINE.start, 1 on the last at SHINE.end; it comes in from a band's
  // width to the left of the word, unseen (it lights the letters only)
  const at = (tau - SHINE.start) / (SHINE.end - SHINE.start);
  const shine = at > -W.band && tau < SHINE.end + W.after
    ? { at, strength: W.light * smooth((at + W.band) / (W.band / 2)) * (1 - smooth((tau - SHINE.end) / W.after)) } : null;
  return { on: true, formed: 1, opacity: held, blur: 0, scale: 1, shine };
}

// The ink as rgb 0..1, and a share of it (toward black, under the letters' own dark ground).
const rgb = hex => { const v = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim())?.[1] || 'ffffff'; return [0, 2, 4].map(i => parseInt(v.slice(i, i + 2), 16) / 255); };
const css = (c, k = 1, a = 1) => `rgba(${c.map(v => Math.round(255 * Math.min(1, v * k))).join(',')},${a})`;

// The shine's peak: halfway from the ink to white, at full strength (#ffffff on the website).
export const shineSilver = (ink = '#ffffff', alpha = 1) => css(rgb(ink).map(v => 0.5 * (1 + v)), 1, alpha);
// The letters' brushed metal at its middle, 0.78 of the ink (#c7c7c7 on the website): the silver the light passes
// over. The boot bubble's rim is this one colour, opaque (Noah, 15 Oct: "make the outline of the bubble silver").
export const metalSilver = (ink = '#ffffff') => css(rgb(ink), 0.78);

// A canvas that draws it. size(cssWidth, dpr) lays it out; draw(state) paints wordmarkAt's state.
export function createWordmark(canvas, { ink = '#ffffff' } = {}) {
  const img = new Image();
  img.decoding = 'async';
  let source = img;
  const ready = new Promise(ok => { img.onload = () => ok(true); img.onerror = () => { source = LETTERING.standIn?.() ?? null; ok(Boolean(source)); }; });
  img.src = LETTERING.src;
  const colour = rgb(ink), aspect = LETTERING.size[1] / LETTERING.size[0];
  let W = 0, H = 0, css_w = 0, tinted = null, grains = null, cells = null, noise = null, gw = 0, gh = 0, painted = null, loaded = false;
  const ctx = canvas.getContext('2d');
  ready.then(ok => { loaded = ok; if (ok && css_w) build(); });

  function build() {
    tinted = document.createElement('canvas'); tinted.width = W; tinted.height = H;
    const t = tinted.getContext('2d');
    t.drawImage(source, 0, 0, W, H);
    t.globalCompositeOperation = 'source-in';
    const g = t.createLinearGradient(0, 0, 0, H); // brushed metal: a little lighter above
    g.addColorStop(0, css(colour, 0.9)); g.addColorStop(0.5, metalSilver(ink)); g.addColorStop(1, css(colour, 0.64));
    t.fillStyle = g; t.fillRect(0, 0, W, H);
    // the grains: noise per cell, settling from the middle outwards
    const cell = WORDMARK.grain * (W / css_w);
    gw = Math.max(1, Math.ceil(W / cell)); gh = Math.max(1, Math.ceil(H / cell));
    grains = document.createElement('canvas'); grains.width = gw; grains.height = gh;
    cells = grains.getContext('2d').createImageData(gw, gh);
    noise = new Float32Array(gw * gh);
    let seed = 0x2f6e2b1;
    const rand = () => { seed = (seed + 0x6d2b79f5) >>> 0; let x = seed; x = Math.imul(x ^ (x >>> 15), x | 1); x ^= x + Math.imul(x ^ (x >>> 7), x | 61); return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
    for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
      const r = Math.hypot((x / gw - 0.5) * 2, (y / gh - 0.5) * 2) / Math.SQRT2;
      noise[y * gw + x] = 0.7 * rand() + 0.3 * r;
    }
    painted = null;
  }
  return {
    canvas, ready,
    get width() { return css_w; }, get height() { return css_w * aspect; },
    size(cssWidth, dpr = 1) {
      const w = Math.max(1, Math.round(cssWidth * dpr)), h = Math.max(1, Math.round(cssWidth * aspect * dpr));
      css_w = cssWidth;
      canvas.style.width = `${cssWidth}px`; canvas.style.height = `${cssWidth * aspect}px`;
      if (w === W && h === H && tinted) return;
      W = canvas.width = w; H = canvas.height = h;
      if (loaded) build();
    },
    draw(s) {
      const st = canvas.style;
      st.opacity = s.opacity.toFixed(3);
      st.visibility = s.opacity > 0 ? 'visible' : 'hidden';
      st.filter = s.blur > 0.0005 ? `blur(${(s.blur * css_w).toFixed(2)}px)` : 'none';
      st.transform = s.scale !== 1 ? `scale(${s.scale.toFixed(4)})` : 'none';
      if (!tinted || s.opacity <= 0) return;
      const key = s.formed < 1 || s.shine ? null : 'whole';
      if (key && painted === key) return; // nothing changes: keep the last paint
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = 'copy';
      ctx.drawImage(tinted, 0, 0);
      if (s.formed < 1) {
        const soft = WORDMARK.soft, g = -soft + s.formed * (1 + 2 * soft), d = cells.data;
        for (let i = 0; i < noise.length; i++) d[4 * i + 3] = 255 * clamp((g - noise[i]) / soft);
        grains.getContext('2d').putImageData(cells, 0, 0);
        ctx.globalCompositeOperation = 'destination-in';
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(grains, 0, 0, W, H);
      }
      if (s.shine && s.shine.strength > 0) {
        const bw = WORDMARK.band * W, x = s.shine.at * W, a = s.shine.strength;
        ctx.globalCompositeOperation = 'source-atop';
        ctx.setTransform(1, 0, -WORDMARK.slant, 1, x, H / 2);
        const g = ctx.createLinearGradient(-bw / 2, 0, bw / 2, 0);
        // a soft band with a brighter, narrower core: light passing over brushed metal
        for (const [o, k] of [[0, 0], [0.18, 0.16], [0.34, 0.5], [0.45, 0.82], [0.5, 1], [0.55, 0.82], [0.66, 0.5], [0.82, 0.16], [1, 0]]) g.addColorStop(o, shineSilver(ink, a * k));
        ctx.fillStyle = g; ctx.fillRect(-bw / 2, -H / 2, bw, H);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
      }
      ctx.globalCompositeOperation = 'source-over';
      painted = key;
    },
  };
}
