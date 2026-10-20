// Workbench's tabs, as a browser has them (workbench-view.js): each tab is one
// view, a folder or a file open in it, on one computer. They are kept on the
// device (localStorage), at most CAP of them; past that, opening one closes
// the oldest other.
//
//   loadTabs(text)                  { tabs: [{ owner, path, file }], active }
//   saveTabs(tabs, active)          the text to keep
//   withTab(tabs, active, tab)      { tabs, active, dropped }: the new tab just after
//                                   the one in front, and in front itself
//   withoutTab(tabs, active, at)    { tabs, active, closed }: the next one in front
//                                   (or the one before, for the last); never the only one
//   tabName({ path, file })         what its tab says

export const CAP = 12;
export const COMPUTER_ROOT = 'imperfect:computers';
export const viewCount = (tabs, active) => tabs.length === 1 ? '+' : `${active + 1}/${tabs.length}`;
export const fileComputers = machines => machines.filter(machine => machine.self || (machine.id && (machine.capabilities?.includes('files') || (!machine.reachable && !machine.capabilities?.length))));

const safeApp = app => {
  if (typeof app?.project === 'string' && /^[A-Za-z0-9][\w.-]{0,63}$/.test(app.project)) return { project: app.project };
  const service = app?.service;
  if (typeof service?.cwd === 'string' && service.cwd.startsWith('/') && typeof service.name === 'string' && typeof service.rest === 'string' && service.rest.startsWith('/') && !service.rest.startsWith('//')) return { service: { cwd: service.cwd, name: service.name, rest: service.rest } };
  return null;
};
const isPath = value => typeof value === 'string' && value.startsWith('/');

export function loadTabs(text, cap = CAP) {
  let kept;
  try { kept = JSON.parse(text); } catch { kept = null; }
  const tabs = (Array.isArray(kept?.tabs) ? kept.tabs : [])
    .filter(tab => tab && typeof tab === 'object' && (tab.path === '' || tab.path === COMPUTER_ROOT || isPath(tab.path)))
    .map(tab => ({ owner: typeof tab.owner === 'string' ? tab.owner : '', path: tab.path, file: isPath(tab.file) ? tab.file : null, ...(safeApp(tab.app) ? { app: safeApp(tab.app) } : {}) }))
    .slice(0, cap);
  const active = Number.isInteger(kept?.active) ? Math.max(0, Math.min(tabs.length - 1, kept.active)) : 0;
  return { tabs, active: Math.max(0, active) };
}

export const saveTabs = (tabs, active) => JSON.stringify({ tabs: tabs.map(({ owner, path, file, app }) => ({ owner, path, file: app ? null : file ?? null, ...(safeApp(app) ? { app: safeApp(app) } : {}) })), active });

export function withTab(tabs, active, tab, cap = CAP) {
  const next = [...tabs.slice(0, active + 1), tab, ...tabs.slice(active + 1)];
  let at = Math.min(active + 1, next.length - 1);
  const dropped = [];
  while (next.length > Math.max(1, cap)) {
    const oldest = next.findIndex((_, i) => i !== at);
    dropped.push(...next.splice(oldest, 1));
    if (oldest < at) at -= 1;
  }
  return { tabs: next, active: at, dropped };
}

export function withoutTab(tabs, active, at) {
  if (tabs.length < 2 || !(at >= 0 && at < tabs.length)) return { tabs, active, closed: null };
  const next = tabs.filter((_, i) => i !== at);
  return { tabs: next, active: at < active ? active - 1 : at === active ? Math.min(at, next.length - 1) : active, closed: tabs[at] };
}

export function tabName({ path, file }) {
  const where = file || path;
  if (where === COMPUTER_ROOT) return 'Computers';
  if (!where) return 'Home';
  return where.split('/').filter(Boolean).at(-1) ?? '/';
}
