// Workbench in imperfect's own window on a Mac: a file of the Mac's opens in
// the app the Mac opens it with ("Open with Preview"), as a double-click in
// Finder would, or is shown in Finder (desktop/electron/mac.mjs macFiles,
// through preload.cjs). Elsewhere (a phone, a browser, another computer's
// files) there is none of this: macFiles() is null.
//
//   const mac = macFiles(win, here)   here(): whether the folder is this computer's
//   mac?.buttons(doc, path, { role, done, tell }) -> [Open with …, Show in Finder]
//   await mac?.named(path) -> 'Open with Preview' ('Open' when no app is known)
//   await mac?.open(path) / mac?.reveal(path) -> '' when done, else why not

export function macFiles(win, here) {
  const desk = win?.imperfectDesk;
  if (!desk?.mac || typeof desk.macOpen !== 'function') return null;
  const named = async path => {
    const app = await desk.macOpener(path).catch(() => '');
    return app ? `Open with ${app}` : 'Open';
  };
  const open = path => (here() ? desk.macOpen(path) : Promise.resolve("It isn't on this Mac"));
  const reveal = path => (here() ? desk.macReveal(path) : Promise.resolve("It isn't on this Mac"));
  return {
    here,
    named,
    open,
    reveal,
    // A menu's or a page's buttons for it, the first renamed once its app is known.
    buttons(doc, path, { role = '', done = () => {}, tell = () => {} } = {}) {
      if (!here()) return [];
      const button = (label, run, what) => {
        const one = doc.createElement('button');
        one.type = 'button';
        if (role) one.setAttribute('role', role);
        one.textContent = label;
        one.onclick = async () => {
          done();
          const why = await run(path).catch(error => error.message);
          if (why) tell(`Couldn't ${what}: ${why}`);
        };
        return one;
      };
      const opening = button('Open', open, 'open it'), showing = button('Show in Finder', reveal, 'show it in Finder');
      void named(path).then(label => { opening.textContent = label; });
      return [opening, showing];
    },
  };
}
