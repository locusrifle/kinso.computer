// The person's new-tab page is chrome over about:blank, never a page injected
// into an agent's browser.
// None by default: imperfect is a starting point each person makes their
// own, so it ships with nobody's sites pinned.
export const PINS = [];

export function pinButtons(visit, small = false) {
  return PINS.map(pin => {
    const button = document.createElement('button');
    button.type = 'button'; button.className = small ? 'browser-pin' : 'browser-start-pin';
    button.title = pin.name; button.setAttribute('aria-label', pin.name);
    const icon = document.createElement('span');
    icon.className = 'browser-pin-icon'; icon.textContent = pin.initial; icon.setAttribute('aria-hidden', 'true');
    button.append(icon);
    if (!small) {
      const name = document.createElement('span'); name.textContent = pin.name; button.append(name);
    }
    button.onclick = () => visit(pin.url);
    return button;
  });
}

export function mountStartPage(visit) {
  const el = document.createElement('div'); el.className = 'browser-start';
  const heading = document.createElement('h2'); heading.textContent = 'Where to?';
  const pins = document.createElement('div'); pins.className = 'browser-start-pins';
  pins.append(...pinButtons(visit)); el.append(heading, pins);
  return el;
}
