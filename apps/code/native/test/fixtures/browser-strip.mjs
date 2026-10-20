import { readFile } from 'node:fs/promises';
import { harnessFixture } from './harness-page.mjs';
import { themeCss } from '../../../../../system/theme.mjs';

export const TAB_NAMES = ['Field notes', 'A small useful computer', 'Chalk study', 'Reading list', 'Workbench', 'Sketchbook', 'Local preview', 'Documentation', 'Garden', 'Music', 'Research', 'Last page'];
export const messages = [{ role: 'user', content: 'Keep these pages beside our conversation.' }, { role: 'assistant', content: [{ type: 'text', text: 'The browser is here. Each page has its own tab.' }] }];

// Production harness/CSS, fixture backend, and real iframe documents. Native
// guests here are deliberately fake; check-browser-tabs.mjs checks Electron.
export async function browserStripFixture({ width = 1200, native = true, theme = 'black', browser = null } = {}) {
  const palette = JSON.parse(await readFile(new URL(`./themes/${theme}.json`, import.meta.url), 'utf8'));
  // The strip under test is the scrolling layout's (a desk starts in focus, which hides it).
  const fixture = await harnessFixture({ desk: native, layout: 'scrolling', messages, viewport: { width, height: 900 }, hasTouch: width === 390, themeCSS: themeCss(palette), browser });
  const { page } = fixture;
  page.setDefaultTimeout(6000);
  await page.route('https://strip.example.test/**', route => {
    const index = Number(new URL(route.request().url()).pathname.slice(1)) || 1;
    return route.fulfill({ contentType: 'text/html', body: `<!doctype html><title>${TAB_NAMES[index - 1] || 'Page'}</title><style>body{margin:32px;font:18px system-ui;background:${palette.background};color:${palette.foreground}}h1{font-weight:400}button{font:inherit;padding:12px}</style><h1>${TAB_NAMES[index - 1] || 'Page'}</h1><p>A fixture page inside the actual browser panel.</p><button onclick="this.textContent='Still playing'">Read this page</button><script>window.born=Math.random()</script>` });
  });
  fixture.open = async (index, behind = false) => {
    const url = `https://strip.example.test/${index}`;
    if (native) {
      await page.evaluate(({ url, behind }) => browseFromWindow({ url, behind }), { url, behind });
      await page.locator('.wm-browser webview').nth(index - 1).evaluate((view, title) => view.dispatchEvent(Object.assign(new Event('page-title-updated'), { title })), TAB_NAMES[index - 1] || `Page ${index}`);
    } else {
      await page.locator('#entry-output').evaluate((output, url) => {
        const a = document.createElement('a'); a.dataset.page = url; a.href = '#'; output.append(a); a.click(); a.remove();
      }, url);
      await page.frameLocator(`.wm-browser .browser-page:nth-child(${index}) iframe`).getByRole('button').waitFor();
    }
    await page.locator('.wm-browser .browser-tab').nth(index - 1).waitFor({ state: 'attached' });
  };
  fixture.reveal = async () => {
    // Native agent openings are quiet; reveal through the same pane keys a
    // human uses. Raw scrollIntoView alone can leave the fixed rail over it.
    await page.keyboard.press('Alt+ArrowRight');
    await page.keyboard.press('Alt+ArrowRight');
    await page.locator('.wm-browser').scrollIntoViewIfNeeded();
    await page.locator('.wm-browser .gui-window-bar').hover({ position: { x: 300, y: 50 } });
  };
  fixture.tabs = () => page.locator('.wm-browser .browser-tab');
  return fixture;
}

export async function stripGeometry(page, selector = '.wm-browser') {
  return page.locator(selector).evaluate(panel => {
    const box = node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, bottom: r.bottom }; };
    const row = panel.querySelector('.browser-tabs');
    return { bar: box(panel.querySelector('.gui-window-bar')), strip: box(panel.querySelector('.browser-tab-strip')), controls: box(panel.querySelector('.browser-controls')), row: box(row), overflow: row.scrollWidth > row.clientWidth, items: [...row.children].map(box), address: panel.querySelector('.gui-window-address') ? box(panel.querySelector('.gui-window-address')) : null };
  });
}
