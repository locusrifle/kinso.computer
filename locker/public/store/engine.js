// The block-art engine, loaded once for the whole page. Its own init only
// notices it is loaded once loading has finished, so two callers at the same
// moment (the power screen and the wordmark) make two copies, and objects made
// by one read the other's memory: "recursive use of an object detected".
import init from '/assets/js/wte/ttfx.js';
import { WASM_URL } from '/assets/js/sequence.js';

let loading = null;
export const loadEngine = () => (loading ??= init({ module_or_path: WASM_URL }).then(() => true, () => false));

// The art in Imperfect's colours. An effect draws in its own palette (the
// black hole's is purple, cyan and white); each cell's lightness picks a
// colour along `stops`, from the darkest to the brightest, so the same
// motion comes out in ours. With `across`, the brightest colour is instead
// the one along `across` at the cell's column: pink into purple.
export function recolour(stops, across = null) {
  if (across) {
    const [ground, ...rest] = stops.map(hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)));
    const band = across.map(hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)));
    const lerp = (a, b, k) => a.map((v, i) => Math.round(v + (b[i] - v) * k));
    return (packed, col = 0, row = 0, width = 1) => {
      const channels = [16, 8, 0].map(shift => (packed >> shift) & 255);
      const light = Math.min(1, ((Math.max(...channels) + Math.min(...channels)) / 510) * 2); // the word itself at full colour
      const at = Math.min(1, Math.max(0, col / Math.max(1, width - 1))) * (band.length - 1);
      const i = Math.min(band.length - 2, Math.floor(at));
      const [r, g, b] = lerp(ground, lerp(band[i], band[i + 1], at - i), light);
      return (r << 16) | (g << 8) | b;
    };
  }
  const rgb = stops.map(hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)));
  const seen = new Map();
  return packed => {
    let out = seen.get(packed);
    if (out === undefined) {
      const channels = [16, 8, 0].map(shift => (packed >> shift) & 255);
      const at = ((Math.max(...channels) + Math.min(...channels)) / 510) * (rgb.length - 1);
      const i = Math.min(rgb.length - 2, Math.floor(at));
      const mixed = rgb[i].map((value, k) => Math.round(value + (rgb[i + 1][k] - value) * (at - i)));
      out = (mixed[0] << 16) | (mixed[1] << 8) | mixed[2];
      seen.set(packed, out);
    }
    return out;
  };
}

// The black hole's two looks: the ground behind the art and the colours along
// which the art is drawn.
export const PALETTES = {
  // Bloom Dark's ground, the art in the song's pinks into purple, as in the light.
  dark: { ground: '#2c2525', stops: ['#2c2525'], across: ['#ff4fa3', '#e040fb', '#b04dff', '#c77dff'] },
  // Bloom Light: the song's cream, the art in its pinks into purple.
  light: { ground: '#f2edf2', stops: ['#f2edf2'], across: ['#ff4fa3', '#e040fb', '#b04dff', '#8a008a'] },
};
