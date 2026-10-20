// Images on the clipboard belong in the composer, the same as a file you picked.
// A paste event may carry them as files or as items; when it carries neither,
// the page reads the clipboard itself (the desktop window allows that).

// Text paste stays native, even if the OS also advertises an older image.
export function clipboardHasText(bag) {
  return [...(bag?.types ?? [])].includes('text/plain') || Boolean(bag?.getData?.('text/plain'));
}

export function filesFromClipboardData(bag) {
  if (!bag) return [];
  const listed = [...(bag.files ?? [])].filter(Boolean);
  if (listed.length) return listed;
  const files = [];
  for (const item of bag.items ?? []) {
    if (item.kind !== 'file') continue;
    const file = item.getAsFile?.();
    if (file) files.push(file);
  }
  return files;
}

export async function filesFromClipboardItems(items, FileCtor = File) {
  if (!Array.isArray(items) && typeof items?.[Symbol.iterator] !== 'function') return [];
  const files = [];
  for (const item of items) {
    const type = item?.types?.find?.(name => String(name).startsWith('image/'));
    if (!type || typeof item.getType !== 'function') continue;
    try {
      const blob = await item.getType(type);
      if (blob) files.push(new FileCtor([blob], 'clipboard.png', { type: blob.type || type }));
    } catch { /* that item was not an image after all */ }
  }
  return files;
}
