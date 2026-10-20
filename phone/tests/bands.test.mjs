import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');

// The app draws edge to edge under clear bars and hands their insets to the page.
test('the app draws under clear bars and hands the page their insets on its plain ground', async () => {
  const theme = await read('../app/src/main/res/values/themes.xml');
  for (const [item, value] of [['statusBarColor', '@android:color/transparent'], ['navigationBarColor', '@android:color/transparent'],
    ['windowLightStatusBar', 'false'], ['windowLightNavigationBar', 'false'], ['windowLayoutInDisplayCutoutMode', 'shortEdges']]) {
    assert.match(theme, new RegExp(`name="android:${item}">${value}<`), item);
  }
  const main = await read('../app/src/main/java/computer/imperfect/code/MainActivity.kt');
  assert.match(main, /WindowCompat\.setDecorFitsSystemWindows\(window, false\)/);
  assert.match(main, /setProperty\('--safe-top','\$\{top\}px'\)/);
  assert.match(main, /setProperty\('--safe-bottom','\$\{bottom\}px'\)/);
  const css = (await read('../../apps/code/native/public/css/imperfect.css')).replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(css, /--safe-top: var\(--phone-top/);
  assert.match(css, /--safe-bottom: var\(--phone-bottom/);
  assert.doesNotMatch(css, /\.stardust/);
});
