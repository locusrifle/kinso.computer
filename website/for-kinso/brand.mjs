// Kinso's own mark is theirs and is never in this source. The locker serves Noah's rebuild of kinso.ai's page from a
// git-ignored folder (locker/public/store/kinso/, served at /kinso/ on every address: locker/server.mjs); the site draws
// the app's icons from that copy's logo. Where the copy is missing (a plain local server), the word stands in.
export const KINSO_MARK = '/kinso/a/aa106999c9d67289.png'; // kinso.ai's header logo, 919 x 1024 (the light one)

const SIZE = 256;
function canvas(size = SIZE) { const c = document.createElement('canvas'); c.width = c.height = size; return c; }
// The tile: a dark macOS icon squircle (the Dock's 64-point icons are 256 px with a 26 px margin), or a disc.
function ground(ctx, shape, size) {
  const g = ctx.createLinearGradient(0, 0, 0, size);
  g.addColorStop(0, '#23252b'); g.addColorStop(1, '#0c0d10');
  ctx.fillStyle = g; ctx.beginPath();
  if (shape === 'disc') ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  else ctx.roundRect(size * .1, size * .1, size * .8, size * .8, size * .18);
  ctx.fill();
  ctx.strokeStyle = '#ffffff24'; ctx.lineWidth = size / 128; ctx.stroke();
}
function paint(shape, mark) {
  const c = canvas(), ctx = c.getContext('2d');
  if (shape !== 'bare') ground(ctx, shape, SIZE);
  if (mark) {
    const h = SIZE * (shape === 'bare' ? .92 : .46), w = h * mark.naturalWidth / mark.naturalHeight;
    ctx.drawImage(mark, (SIZE - w) / 2, (SIZE - h) / 2, w, h);
  } else {
    ctx.fillStyle = '#f2f2f7'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = `600 ${shape === 'bare' ? 200 : 54}px -apple-system, BlinkMacSystemFont, system-ui, sans-serif`;
    ctx.fillText(shape === 'bare' ? 'K' : 'Kinso', SIZE / 2, SIZE / 2 + 2);
  }
  return c.toDataURL('image/png');
}
const draw = mark => ({ dock: paint('squircle', mark), avatar: paint('disc', mark), favicon: paint('bare', mark) });

// The icons at once (the word), and once the logo has loaded, the logo's: { now, ready }.
export function kinsoIcons(src = KINSO_MARK) {
  const now = draw(null);
  const ready = new Promise(resolve => {
    const img = new Image(); img.decoding = 'async';
    img.onload = () => resolve(img.naturalWidth ? draw(img) : null);
    img.onerror = () => resolve(null);
    img.src = src;
  });
  return { now, ready };
}
