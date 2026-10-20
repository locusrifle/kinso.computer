// QuickTime's one composited surface for the mesh. A canvas texture avoids
// independently antialiased DOM clips leaving dark seams across the movie.
export function moviePicture(element, video) {
  const canvas = document.createElement('canvas'), width = element.offsetWidth, height = element.offsetHeight;
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d'), screen = element.getBoundingClientRect(), scale = screen.width / width;
  const box = el => { const r = el.getBoundingClientRect(); return { x: (r.x - screen.x) / scale, y: (r.y - screen.y) / scale, w: r.width / scale, h: r.height / scale }; };
  const rounded = (r, radius, color) => { ctx.beginPath(); ctx.roundRect(r.x, r.y, r.w, r.h, radius); ctx.fillStyle = color; ctx.fill(); };
  const text = (el, value, centre = false) => {
    const r = box(el), style = getComputedStyle(el); ctx.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    ctx.fillStyle = style.color; ctx.textAlign = centre ? 'center' : 'left'; ctx.textBaseline = 'middle'; ctx.fillText(value, r.x + (centre ? r.w / 2 : 0), r.y + r.h / 2);
  };
  ctx.beginPath(); ctx.roundRect(0, 0, width, height, parseFloat(getComputedStyle(element).borderRadius)); ctx.clip();
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, width, height);
  try { ctx.drawImage(video, 0, 0, width, height); } catch {}
  const on = element.dataset.hud !== 'false';
  if (!on) return canvas;
  const title = element.querySelector('.shell-titlebar'), t = box(title), gradient = ctx.createLinearGradient(0, 0, 0, t.h);
  gradient.addColorStop(0, '#252525cc'); gradient.addColorStop(1, '#16161680'); rounded(t, 0, gradient); text(title, title.textContent, true);
  for (const light of element.querySelectorAll('.shell-light')) { const r = box(light); rounded(r, r.w / 2, getComputedStyle(light).backgroundColor); }
  const hud = element.querySelector('.quicktime-hud');
  rounded(box(hud), parseFloat(getComputedStyle(hud).borderRadius), getComputedStyle(hud).backgroundColor);
  for (const svg of hud.querySelectorAll('svg')) {
    const r = box(svg), vb = svg.viewBox.baseVal; ctx.save(); ctx.translate(r.x, r.y); ctx.scale(r.w / vb.width, r.h / vb.height);
    for (const glyph of svg.querySelectorAll('path,rect,circle')) {
      const style = getComputedStyle(glyph); ctx.fillStyle = style.fill; ctx.strokeStyle = style.stroke; ctx.lineWidth = parseFloat(style.strokeWidth); ctx.lineCap = style.strokeLinecap;
      let path;
      if (glyph.localName === 'path') path = new Path2D(glyph.getAttribute('d'));
      else { path = new Path2D(); if (glyph.localName === 'circle') path.arc(glyph.cx.baseVal.value, glyph.cy.baseVal.value, glyph.r.baseVal.value, 0, Math.PI * 2);
        else path.roundRect(glyph.x.baseVal.value, glyph.y.baseVal.value, glyph.width.baseVal.value, glyph.height.baseVal.value, glyph.rx.baseVal.value); }
      if (style.fill !== 'none') ctx.fill(path); if (style.stroke !== 'none') ctx.stroke(path);
    }
    ctx.restore();
  }
  for (const output of hud.querySelectorAll('output')) text(output, output.value);
  for (const input of hud.querySelectorAll('input')) {
    const r = box(input), p = Math.max(0, Math.min(1, +input.value / +input.max)); rounded(r, r.h / 2, '#ffffff40');
    const seek = input.closest('.quicktime-timeline'), w = seek ? 3 : 9, h = seek ? 11 : 9;
    rounded({ x: r.x + p * (r.w - w), y: r.y + (r.h - h) / 2, w, h }, seek ? 1 : w / 2, '#d5d5db');
  }
  return canvas;
}
