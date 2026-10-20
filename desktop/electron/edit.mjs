// Native editing in every WebContents: canvas, child frames, website guests,
// popup windows and WebContentsViews. Never translate Ctrl (the composer's
// Ctrl+C can interrupt a turn), Option on a Mac, or the optional Alt alias.
export function editCommand({ type, code, meta, control, alt, shift }, { mod = 'meta', platform = process.platform } = {}) {
  if (platform === 'darwin' || mod !== 'meta' || !meta || control || alt || !['keyDown', 'keyUp'].includes(type)) return '';
  if (shift) return code === 'KeyZ' ? 'redo' : '';
  return { KeyC: 'copy', KeyV: 'paste', KeyX: 'cut', KeyA: 'selectAll', KeyZ: 'undo' }[code] ?? '';
}

export function installEditing(app, options) {
  app.on('web-contents-created', (_, contents) => {
    contents.on('before-input-event', (event, input) => {
      const command = editCommand(input, options);
      if (!command) return;
      // No DOM key handler or Electron menu should also answer this chord.
      // Consume the release too; repeat retains normal native editing behaviour.
      event.preventDefault();
      if (input.type === 'keyDown') contents[command]();
    });
  });
}
