import { MACOS, animate, clamp, ease, smooth } from './timings.mjs?v=sequoia-4';
const mix = (a, b, p) => a + (b - a) * p;

// A horizontal mesh: first the lower edge narrows toward the tile, then the
// upper edge follows through the neck. t=0 and t=1 are the exact two rectangles.
// This is a measured approximation, not recovered Apple implementation code.
export function geniePoint(from, tile, u, v, t) {
  const p = clamp(t);
  if (p === 0) return { x: from.x + u * from.width, y: from.y + v * from.height };
  if (p === 1) return { x: tile.x + u * tile.width, y: tile.y + v * tile.height };
  const neck = ease(p / MACOS.neckFraction), travel = ease((p - MACOS.neckFraction) / (1 - MACOS.neckFraction));
  const top = mix(from.y, tile.y, travel);
  // Narrow the lower edge in place first. Then pour the sheet down the funnel:
  // preserve its height until its lower edge reaches the Dock, and feed in the rest.
  const bottom = from.y + from.height <= tile.y + tile.height
    ? Math.min(from.y + from.height + top - from.y, tile.y + tile.height)
    : mix(from.y + from.height, tile.y + tile.height, travel);
  const y = mix(top, bottom, v);
  const depth = smooth((y - from.y) / Math.max(1, bottom - from.y));
  const bend = mix(neck * depth, 1, travel);
  return { x: mix(from.x + u * from.width, tile.x + u * tile.width, bend), y };
}

// A projective strip meets both neighbouring strips along the whole edge.
// An affine strip leaves visible teeth where the two widths differ.
export function stripMatrix(a, b, c, d, width, height) {
  const ratio = (b.x - a.x) / (d.x - c.x);
  return [(b.x - a.x) / width, 0, 0, 0,
    (ratio * c.x - a.x) / height, (ratio * c.y - a.y) / height, 0, (ratio - 1) / height,
    0, 0, 1, 0, a.x, a.y, 0, 1];
}

// Browsers cannot read another origin's iframe pixels. Its existing miniature
// supplies that one surface; no duplicate authenticated iframe is ever loaded.
function picture(element, preview) {
  const copy = element.cloneNode(true), originals = [...element.querySelectorAll('video,canvas,iframe')];
  const copies = [...copy.querySelectorAll('video,canvas,iframe')];
  for (const [index, media] of copies.entries()) {
    const source = originals[index];
    if (media.localName === 'iframe') {
      const surrogate = preview?.cloneNode(true) || document.createElement('div');
      surrogate.classList.add('genie-private-surface'); media.replaceWith(surrogate);
    } else {
      const canvas = document.createElement('canvas'); canvas.className = media.className;
      const width = source.videoWidth || source.width || 1920, height = source.videoHeight || source.height || 1080;
      canvas.width = Math.min(width, element.offsetWidth || width); canvas.height = Math.round(canvas.width * height / width);
      try { canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height); } catch {}
      media.replaceWith(canvas);
    }
  }
  for (const el of [copy, ...copy.querySelectorAll('*')]) { el.removeAttribute('id'); el.removeAttribute('autofocus'); }
  copy.dataset.windowState = 'open'; copy.removeAttribute('aria-hidden');
  Object.assign(copy.style, { left: '0px', top: '0px', margin: '0', transform: 'none', translate: 'none', scale: 'none', visibility: 'visible', opacity: '1', boxShadow: 'none' });
  return copy;
}
function duplicate(source, row, rows, height) {
  const copy = source.cloneNode(true), canvases = copy.querySelectorAll('canvas');
  source.querySelectorAll('canvas').forEach((canvas, i) => {
    const target = canvases[i];
    if (canvas.classList.contains('quicktime-video')) {
      // Store just this strip's video pixels, rather than sixty-four full films.
      const y = canvas.height * row / rows, h = canvas.height / rows + 1;
      target.height = Math.ceil(h);
      target.getContext('2d').drawImage(canvas, 0, y, canvas.width, h, 0, 0, target.width, target.height);
      Object.assign(target.style, { position: 'absolute', top: `${height * row / rows}px`, height: `${height / rows + 1}px`, objectFit: 'fill' });
    } else target.getContext('2d').drawImage(canvas, 0, 0);
  });
  return copy;
}
export function runGenie({ element, stage, from, tile, restore = false, reduced = false, preview, capture }) {
  const originalVisibility = element.style.visibility;
  if (reduced) {
    const a = animate(MACOS.reduceMs, t => { element.style.opacity = String(restore ? t : 1 - t); });
    return { finished: a.finished.finally(() => { element.style.opacity = ''; }), cancel: a.cancel };
  }
  const mesh = document.createElement('div'); mesh.className = 'genie-mesh'; mesh.setAttribute('aria-hidden', 'true'); mesh.inert = true;
  const texture = capture?.(), source = texture ? null : picture(element, preview), slices = [];
  if (source) Object.assign(source.style, { width: `${from.width}px`, height: `${from.height}px` });
  for (let i = 0; i < MACOS.genieSlices; i++) {
    const strip = document.createElement('div'); strip.className = 'genie-strip';
    const y = from.height * i / MACOS.genieSlices, h = from.height / MACOS.genieSlices + .7;
    Object.assign(strip.style, { width: `${from.width}px`, height: `${h}px` });
    if (texture) {
      const canvas = document.createElement('canvas'); canvas.width = texture.width; canvas.height = Math.ceil(texture.height / MACOS.genieSlices + 1);
      canvas.getContext('2d').drawImage(texture, 0, y / from.height * texture.height, texture.width, h / from.height * texture.height, 0, 0, canvas.width, canvas.height);
      strip.append(canvas);
    } else { const copy = duplicate(source, i, MACOS.genieSlices, from.height); copy.style.top = `${-y}px`; strip.append(copy); }
    mesh.append(strip); slices.push(strip);
  }
  stage.append(mesh); element.style.visibility = 'hidden';
  const animation = animate(MACOS.genieMs, t => {
    const p = restore ? 1 - t : t; mesh.dataset.progress = String(p);
    for (const [i, strip] of slices.entries()) {
      const height = from.height / slices.length + .7, v0 = i / slices.length, v1 = Math.min(1, v0 + height / from.height);
      const a = geniePoint(from, tile, 0, v0, p), b = geniePoint(from, tile, 1, v0, p), c = geniePoint(from, tile, 0, v1, p), d = geniePoint(from, tile, 1, v1, p);
      strip.style.transform = `matrix3d(${stripMatrix(a, b, c, d, from.width, height).join(',')})`;
    }
  });
  const cleanup = () => { mesh.remove(); element.style.visibility = originalVisibility; };
  return { finished: animation.finished.then(ok => { cleanup(); return ok; }), cancel() { animation.cancel(); cleanup(); } };
}
