// The shared boot's optical placement and the goat after the word: cut in, faded out.
//   The optical centre: each mark stands with its ink's mass, not its box, on the middle of the screen. The wordmark's
//   long "t" cross-stroke stretches its box right, so its letters sat 2.7 % of their ink's width left of centre.
//   The goat: once the word has gone, imperfect's J06 goat mark comes in at the same middle, holds, and goes; then the
//   film. intro/goat-j06.webp is tools/assets/goat-head/goat-head.png (the J06 master), trimmed to its ink, 640 px
//   tall: magick goat-head.png -trim +repage -filter Lanczos -resize x640 -quality 75 -define webp:alpha-quality=80
import { WORD } from '../wordmark.mjs?v=kinso-lift-2';
import { variant } from '../variant.mjs?v=kinso-lift-2';

// Where each mark's ink mass sits from its image's centre, as a share of the image (x right, y down), measured on
// these very files as the page draws them: the wordmark is assets/wordmark/imperfect-spiky.png's alpha tinted with
// wordmark.mjs's brushed gradient (lighter above), its mass 2.72 % of its ink's width left of its ink's centre (the
// png's plain alpha says 3.03 %; the gradient lifts the tall "f" and "t" on the right); its 0.13 % above is left as it
// is. The goat is goat-j06.webp's alpha x luminance. The Kinso site's lettering is measured the same way (variant.mjs).
export const MASS = Object.freeze({ wordmark: variant.lettering.mass, goat: [0.00191, -0.04859] });

export const GOAT = Object.freeze({
  src: new URL('goat-j06.webp', import.meta.url).href,
  size: [631, 640],
  in: 0.9, hold: 1.5, out: 0.9, // s: retained spans; clean cuts do not move the film's start
  still: 0.3,                   // s each side of the hold with reduced motion (or no moving sky)
  height: 0.9,                  // its height, x the wordmark's
  peak: 0.9,                    // its opacity, whole: the wordmark's brushed white is 64-90 % of the ink
  grow: 0.03,                   // it settles from a touch larger as it comes in (not with reduced motion)
  blur: 0.006,                  // and sharpens from this blur, a share of its width
});

const clamp = x => Math.max(0, Math.min(1, x));
const smooth = x => { x = clamp(x); return x * x * (3 - 2 * x); };

// Its moments, in seconds after the touch: it starts as the word has gone.
export function goatTimes({ still = false } = {}) {
  const from = WORD.gone, fade = still ? [GOAT.still, GOAT.still] : [GOAT.in, GOAT.out];
  return { from, whole: from + fade[0], out: from + fade[0] + GOAT.hold, gone: from + fade[0] + GOAT.hold + fade[1] };
}

// The goat at tau seconds after the touch: off before the word has gone and once it has gone itself.
export function goatAt(tau, { still = false } = {}) {
  const T = goatTimes({ still });
  if (!(tau >= T.from) || tau >= T.gone) return { on: false, opacity: 0, scale: 1, blur: 0 };
  // A clean cut in (no fade from the word, Noah, 14 Oct), whole for the span the fade in took and the hold, then a
  // calm fade out; the film starts when it did, and cuts cleanly from there.
  const out = tau >= T.out ? smooth((tau - T.out) / (T.gone - T.out)) : 0;
  return { on: true, opacity: GOAT.peak * (1 - out), scale: 1, blur: 0 };
}

// The wordmark's place (wordmark.mjs placeWordmark: [left, top, width, height]) moved so its ink's mass is on the
// screen's centre line. Colour marks centre vertically too; imperfect keeps its original baseline.
export const opticalWordmark = ([x, y, w, h]) => [x - MASS.wordmark[0] * w, y - (variant.lettering.colour ? MASS.wordmark[1] * h : 0), w, h];

// The goat's place: its ink's mass on the very middle of the screen, GOAT.height x the wordmark's height.
export function placeGoat(vw, vh, [, , , wordHeight]) {
  const h = GOAT.height * wordHeight, w = h * GOAT.size[0] / GOAT.size[1];
  return [vw / 2 - w / 2 - MASS.goat[0] * w, vh / 2 - h / 2 - MASS.goat[1] * h, w, h];
}
