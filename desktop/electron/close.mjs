// Native close belongs to the person, not to embedded pages or the backend.
export const nativeCloseKey = input => input.type === 'keyDown'
  && input.code === 'KeyW' && input.control && input.shift && !input.alt && !input.meta;

// The window closes when asked: destroy bypasses beforeunload, so a hung or
// vetoing page cannot hold it open. The agents keep running either way.
export function installNativeClose(win) {
  win.on('close', event => {
    event.preventDefault();
    if (!win.isDestroyed()) win.destroy();
  });
}
