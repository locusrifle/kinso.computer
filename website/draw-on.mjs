// Runtime artwork only: the source repository carries neither a client's paths nor its animation calibration.
import { ease } from './macos/timings.mjs?v=sequoia-4';

export async function loadDrawOn({ src, timing }) {
  try {
    const responses = await Promise.all([src, timing].map(url => fetch(url, { signal: AbortSignal.timeout(4000) })));
    if (responses.some(response => !response.ok)) return null;
    const [artwork, spec] = await Promise.all([responses[0].text(), responses[1].json()]);
    // Parse as data, never insert the client's document or execute anything it carries.
    const original = new DOMParser().parseFromString(artwork, 'image/svg+xml');
    const strokes = [...original.querySelectorAll('path')], gradient = original.querySelector('linearGradient');
    if (!strokes.length || !gradient) return null;
    const geometry = strokes.map(path => path.getAttribute('d'));
    const strokeWidth = Number(strokes[0].getAttribute('stroke-width'));
    const paths = geometry.map(d => {
      const el = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      el.setAttribute('d', d);
      return { path: new Path2D(d), length: el.getTotalLength() };
    });
    // getBBox on detached SVG elements is not portable. Measure in an invisible, same-origin SVG instead.
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '0'); svg.setAttribute('height', '0'); svg.setAttribute('aria-hidden', 'true');
    for (const d of geometry) {
      const el = document.createElementNS(svg.namespaceURI, 'path'); el.setAttribute('d', d); svg.append(el);
    }
    document.body.append(svg);
    const box = svg.getBBox(); svg.remove();
    const pad = strokeWidth / 2;
    const bounds = [box.x - pad, box.y - pad, box.width + 2 * pad, box.height + 2 * pad];
    const duration = spec.periodMs * spec.draw.frames[1][0];
    if (!(duration > 0) || !(strokeWidth > 0) || !paths.length || !bounds.every(Number.isFinite) || !bounds[2] || !bounds[3]) return null;
    return {
      duration,
      paint(ctx, width, height, elapsed, still = false) {
        const progress = still ? 1 : ease(elapsed * 1000 / duration, spec.draw.easing);
        ctx.save();
        const scale = Math.min(width / bounds[2], height / bounds[3]);
        ctx.setTransform(scale, 0, 0, scale, (width - bounds[2] * scale) / 2 - bounds[0] * scale,
          (height - bounds[3] * scale) / 2 - bounds[1] * scale);
        const paint = ctx.createLinearGradient(...['x1', 'y1', 'x2', 'y2'].map(key => Number(gradient.getAttribute(key))));
        for (const stop of gradient.querySelectorAll('stop')) paint.addColorStop(Number(stop.getAttribute('offset') || 0), stop.getAttribute('stop-color'));
        ctx.strokeStyle = paint; ctx.lineWidth = strokeWidth;
        ctx.lineCap = strokes[0].getAttribute('stroke-linecap'); ctx.lineJoin = strokes[0].getAttribute('stroke-linejoin');
        for (const { path, length } of paths) {
          ctx.setLineDash(progress === 1 ? [] : [length, length]);
          ctx.lineDashOffset = length * (1 - progress); ctx.stroke(path);
        }
        ctx.restore();
        return progress;
      },
    };
  } catch { return null; } // An absent rebuild must never prevent entering the computer.
}
