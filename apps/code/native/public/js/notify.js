// Notifications on this device (system/notify.mjs, public/sw.js).
//
// Nothing is ever drawn above the input bar (Noah, 15 Oct: "i never want text
// to spawn there on any system"). A browser that can take Web Push (Chrome and
// Firefox, on a computer or an Android phone, and an iPhone once imperfect is
// on its Home Screen) is asked once, by the browser's own question, when the
// person first sends a prompt; once on, the worker shows what this computer
// pushes, with imperfect closed or open. imperfect's desktop app grants them
// itself. A device that cannot take push only gets the phone app's motor.

const ASKED = 'imperfect.notify.dismissed';
const asked = () => { try { return localStorage.getItem(ASKED) === '1'; } catch { return false; } };
const remember = () => { try { localStorage.setItem(ASKED, '1'); } catch { /* this visit only */ } };

// 'push': Web Push; 'page': notifications while open (imperfect's desktop app,
// which has no push service); 'home': an iPhone or iPad's Safari, which pushes
// only to a Home Screen app; '' none (the phone app's WebView).
export function pushKind(scope = globalThis) {
  const nav = scope.navigator ?? {};
  const notifications = typeof scope.Notification === 'function';
  if (scope.imperfectDesk) return notifications ? 'page' : '';
  if (notifications && 'serviceWorker' in nav && 'PushManager' in scope && scope.isSecureContext) return 'push';
  const apple = /iPhone|iPad|iPod/.test(nav.userAgent ?? '') || (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1);
  if (apple && !nav.standalone) return 'home';
  return notifications ? 'page' : '';
}

const label = (agent = navigator.userAgent) => (/Android/.test(agent) ? 'Android' : /iPhone|iPad/.test(agent) ? 'iPhone' : /Mac/.test(agent) ? 'Mac' : /Windows/.test(agent) ? 'Windows' : /Linux/.test(agent) ? 'Linux' : '');
const appKey = key => Uint8Array.from(atob(key.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

// open(session, owner): show a session. tick(): the phone app's motor.
export function createNotifications({ open = () => {}, tick = () => {}, kind = pushKind(), fetcher = (...args) => fetch(...args) }) {
  let registration = null, subscribed = false;

  async function subscribe() {
    const { key } = await (await fetcher('/push/key')).json();
    const subscription = await registration.pushManager.getSubscription() ?? await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: appKey(key) });
    const response = await fetcher('/push/subscribe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ subscription: subscription.toJSON(), label: label() }) });
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || `the computer said ${response.status}`);
    subscribed = true;
  }

  // The browser's own question, once: when the person first sends a prompt
  // (a permission prompt needs their gesture, and a visitor who only looks is
  // never asked). No line of ours is ever shown.
  let askable = false;
  function ask() {
    if (!askable || asked()) return;
    askable = false; remember();
    Notification.requestPermission().then(answer => answer === 'granted' ? subscribe() : null)
      .catch(error => console.warn('notifications could not be turned on:', error.message));
  }

  async function start() {
    // imperfect's desktop app grants them itself (desktop/electron/main.mjs); nothing is asked.
    if (kind === 'page' && globalThis.imperfectDesk && Notification.permission === 'default') { Notification.requestPermission().catch(() => {}); return; }
    if (kind !== 'push') return;
    try {
      registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      navigator.serviceWorker.addEventListener('message', event => {
        if (event.data?.type === 'imperfect-open-session') open(String(event.data.session ?? ''));
      });
      const permission = Notification.permission;
      if (permission === 'granted') await subscribe(); // kept in step with this computer's list
      else if (permission === 'default') askable = true;
    } catch (error) {
      console.warn('notifications unavailable:', error.message);
    }
  }

  // What this computer's windows are told (system/notify.mjs). Pushed already
  // to a subscribed device: its worker shows it.
  function received(message, owner) {
    if (subscribed) return;
    if ((kind === 'page' || kind === 'push') && Notification.permission === 'granted') {
      try {
        const shown = new Notification(message.title, { body: message.body, tag: message.tag || undefined, icon: '/icon-192.png' });
        shown.onclick = () => { try { window.focus(); } catch { /* the desktop app brings itself forward */ } shown.close(); open(message.session ?? '', owner); };
        return;
      } catch { /* Android's Chrome shows them only through its worker */ }
    }
    tick();
  }

  return { start, received, ask };
}
