import assert from 'node:assert/strict';

// Hit-test the visitor's surface, including any nested product/concept frames, without moving their pointer.
export async function visibleCursor(page, stage) {
  const samples = [];
  for (const frame of page.frames()) {
    const rows = await frame.evaluate(() => {
      const points = [[.05, .05], [.5, .5], [.8, .42], [.5, .9]];
      return points.map(([u, v]) => {
        const x = Math.min(innerWidth - 1, Math.floor(innerWidth * u)), y = Math.min(innerHeight - 1, Math.floor(innerHeight * v));
        const element = document.elementFromPoint(x, y);
        return { x, y, element: element?.className || element?.tagName, cursor: element && getComputedStyle(element).cursor };
      });
    });
    for (const row of rows) assert.notEqual(row.cursor, 'none', `${stage}: ${frame.url()} ${JSON.stringify(row)}`);
    samples.push({ frame: new URL(frame.url()).pathname, points: rows });
  }
  return { stage, samples };
}
