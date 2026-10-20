// The launch page fades in the actual demo only after its conversation has
// connected and the product has painted. No files, model state or tokens cross
// this boundary. Private computers and unknown embedders never announce it.
// imperfect.computer, and kinso.computer: the same launch page made for Kinso (website/variant.mjs).
const PARENTS = new Set(['https://imperfect.computer', 'https://www.imperfect.computer', 'https://kinso.computer', 'https://www.kinso.computer']);
// The open demo, and the launch page's workbenches: each its own imperfect at https://<id>.noah.imperfect.computer,
// or Kinso's own computer (computer.kinso.computer, the one kinso.computer's lock opens), framed by the site's lock.
const DEMOS = /^https:\/\/(?:(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)?noah\.imperfect\.computer|computer\.kinso\.computer)$/;

// The parent is the browser's own record of who embeds this frame (location.ancestorOrigins), else the referrer.
// Safari sends this frame no referrer (the launch page's Referrer-Policy: same-origin wins over the frame's own
// referrerpolicy there), so by the referrer alone Safari's demo was never announced (19 Oct). Firefox has no
// ancestorOrigins, and a browser may mask it as "null": the referrer then.
export function demoParentOrigin(origin, referrer, ancestors) {
  if (!DEMOS.test(String(origin))) return null;
  let parent = ancestors?.[0];
  if (!parent || parent === 'null') try { parent = new URL(referrer).origin; } catch { return null; }
  return PARENTS.has(parent) ? parent : null;
}

export async function notifyDemoReady(ready, { win = globalThis.window, doc = globalThis.document } = {}) {
  if (!win || !doc || win.parent === win || !ready || typeof ready.then !== 'function') return false;
  const origin = demoParentOrigin(win.location.origin, doc.referrer, win.location.ancestorOrigins);
  if (!origin) return false;
  try {
    await ready;
    // Snapshot handling renders synchronously and may schedule layout work.
    // Let that work paint before announcing an interactive product, not HTML.
    await new Promise(done => win.requestAnimationFrame(() => win.requestAnimationFrame(done)));
    if (!doc.getElementById('entry-input') || !doc.getElementById('entry-output')) return false;
    win.parent.postMessage({ type: 'imperfect:demo-ready' }, origin);
    return true;
  } catch { return false; }
}
