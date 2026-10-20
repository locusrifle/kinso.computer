// A Mac's window has a colour of its own, seen before its page paints and at a
// resize's new edge: the theme's ground. At launch it is the chosen theme's
// (system/theme.mjs), or under Automatic the system's; after that the page says
// whenever its ground turns (preload.cjs), with a new theme or the system going
// light or dark. Set once at launch, it flashed the old ground after a change.
import { ipcMain, nativeTheme } from 'electron';
import { AUTO, AUTO_THEMES, readTheme, themeChoice } from '../../system/theme.mjs';

const HEX = /^#(?:[0-9a-f]{3}){1,2}$/i;

export async function ground(home) {
  const system = AUTO_THEMES[nativeTheme.shouldUseDarkColors ? 'dark' : 'light'];
  const chosen = await themeChoice(home).catch(() => AUTO);
  const theme = (chosen !== AUTO && await readTheme(chosen, home).catch(() => null)) || await readTheme(system, home).catch(() => null);
  return HEX.test(theme?.background) ? theme.background : nativeTheme.shouldUseDarkColors ? '#121214' : '#ffffff';
}

export function followGround(win) {
  const heard = (event, colour) => { if (event.sender === win.webContents && HEX.test(colour)) win.setBackgroundColor(colour); };
  ipcMain.on('ground', heard);
  win.once('closed', () => ipcMain.off('ground', heard));
}
