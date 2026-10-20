// Notifications with imperfect closed (system/notify.mjs). This worker only
// shows what this computer pushed and opens imperfect when one is tapped; it
// never sees a page's requests, so nothing is cached and nothing changes how
// imperfect loads.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

self.addEventListener('push', event => {
  let message = {};
  try { message = event.data?.json() ?? {}; } catch { /* shown as imperfect's own */ }
  event.waitUntil(self.registration.showNotification(String(message.title || 'imperfect'), {
    body: String(message.body || ''),
    tag: message.tag || undefined,
    renotify: Boolean(message.tag),
    icon: '/icon-192.png',
    badge: '/badge-96.png',
    data: { url: message.url || '/', session: message.session || '' },
  }));
});

// A window of imperfect already open goes to the session; otherwise one opens
// there. Only this computer's own addresses are ever opened.
async function opened({ url = '/', session = '' } = {}) {
  const here = self.location.origin;
  let target = new URL(String(url), here);
  if (target.origin !== here) target = new URL('/', here);
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const open = windows.find(client => new URL(client.url).origin === here && !new URL(client.url).pathname.startsWith('/door'));
  if (open) {
    open.postMessage({ type: 'imperfect-open-session', session: String(session) });
    try { await open.focus(); } catch { /* not this tap's to focus */ }
    return open;
  }
  return self.clients.openWindow(target.href);
}
self.opened = opened;

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(opened(event.notification.data ?? {}));
});

// The push service changed this device's address: tell this computer the new one.
self.addEventListener('pushsubscriptionchange', event => {
  const key = event.oldSubscription?.options?.applicationServerKey;
  if (!key) return;
  event.waitUntil(self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })
    .then(subscription => fetch('/push/subscribe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ subscription: subscription.toJSON() }) }))
    .catch(() => {}));
});
