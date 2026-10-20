// Keep Chromium's real window.open relationship. Navigating the opener and
// denying its popup destroys the pending sign-in and leaves Firebase's auth
// callback with nobody to answer. Cookies stay in the opener's session.
export function websiteAddress(url, ours) {
  try { return (url === 'about:blank' || /^https?:$/.test(new URL(url).protocol)) && !ours(url); }
  catch { return false; }
}

export function installWebsitePopups(page, { ours, windowOptions = {}, createWindow, onWindow } = {}) {
  page.setWindowOpenHandler(({ url }) => {
    if (!websiteAddress(url, ours)) return { action: 'deny' };
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        ...windowOptions,
        autoHideMenuBar: true,
        webPreferences: {
          session: page.session, preload: '', nodeIntegration: false,
          nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false,
          contextIsolation: true, sandbox: true, webviewTag: false,
          backgroundThrottling: false,
        },
      },
      ...(createWindow ? { createWindow } : {}),
    };
  });
  if (onWindow) page.on('did-create-window', onWindow);
}
