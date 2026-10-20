// What the store's character-grid pages share (the buy page's black hole and
// the block wordmarks): where ttfx's WebAssembly is, how big a piece of block
// art is, and a canvas the size of the screen. Nothing in here knows about a
// page or a clock.

export const WASM_URL = new URL('./wte/ttfx.wasm', import.meta.url);

export function measureArt(art) {
  const lines = art.split('\n');
  let columns = 1;
  for (const line of lines) columns = Math.max(columns, [...line].length);
  return { columns, rows: Math.max(1, lines.length) };
}

export function sizeCanvas(canvas, cssWidth, cssHeight) {
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  canvas.width = Math.max(1, Math.floor(cssWidth * dpr));
  canvas.height = Math.max(1, Math.floor(cssHeight * dpr));
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('2d canvas is unavailable');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}
