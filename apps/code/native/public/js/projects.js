// Projects (system/projects.mjs), as a window sees them: in Workbench, at
// ~/projects, each a tile with a preview of its page as it last looked,
// which clicked starts it and opens its page as a Files view; and the
// projects this window's tabs show, told to the computers that run them
// while they do, so one no tab shows stops a while after.
//
//   startProject(name, base)          { url } of its page, once it answers
//   const held = holdProjects();      held.paint(tabs) as the tabs change
//   await projectsAt(base, path)      Map name -> project, or null for any other folder
//   projectPreview(project, base, open)   the preview a project's tile wears; Ctrl or
//                                         Shift+click passes to the tile, to select it

// This window, as the computers it holds projects on know it.
const WINDOW = globalThis.crypto?.randomUUID?.() ?? String(Math.random()).slice(2);
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), keepalive: true });

export async function startProject(name, base = '') {
  const res = await post(`${base}/projects/${encodeURIComponent(name)}/start`, {});
  const answer = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(answer.error || `${name} did not start (${res.status})`);
  return answer;
}

// every: how often a hold is said again, well inside the computer's STALE.
export function holdProjects({ every = 15_000 } = {}) {
  let told = new Map(), timer = 0; // base -> its names, sorted
  const tell = (base, names) => post(`${base}/projects/hold`, { window: WINDOW, names }).catch(() => {});
  function paint(tabs) {
    const now = new Map();
    for (const tab of tabs) if (tab.project) now.set(tab.base, [...new Set([...(now.get(tab.base) ?? []), tab.project.name])].sort());
    for (const base of new Set([...told.keys(), ...now.keys()])) {
      const names = now.get(base) ?? [];
      if (String(told.get(base) ?? '') !== String(names)) tell(base, names);
    }
    told = now;
    clearInterval(timer);
    if (told.size) timer = setInterval(() => { for (const [base, names] of told) tell(base, names); }, every);
  }
  return { paint };
}

// The projects in a folder, if it is the computer's projects folder.
export async function projectsAt(base, path, { signal } = {}) {
  if (!/\/projects\/?$/.test(path)) return null;
  try {
    const res = await fetch(`${base}/projects.json`, { cache: 'no-store', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000) });
    const { root, projects } = await res.json();
    return root === path.replace(/(.)\/+$/, '$1') ? new Map(projects.map(project => [project.name, project])) : null;
  } catch { return null; }
}

// A marker, never a separate control; also used by runnable HTML files.
export function launchMarker(doc = document) {
  const badge = doc.createElement('span');
  badge.className = 'workbench-launch';
  badge.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2l10 6-10 6z"/></svg><span>Launch</span>';
  return badge;
}

export function projectPreview(project, base, open) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'workbench-preview';
  button.title = `Open ${project.name}`;
  button.setAttribute('aria-label', `Open ${project.name}`);
  if (project.picture) {
    const img = document.createElement('img');
    img.alt = '';
    img.src = `${base}/projects/${encodeURIComponent(project.name)}/picture?at=${encodeURIComponent(project.picture)}`;
    button.append(img);
  } else button.append(Object.assign(document.createElement('span'), { className: 'workbench-preview-none', textContent: 'not run yet' }));
  button.append(launchMarker());
  // With Ctrl or Shift the click is the tile's, to select it (workbench-view.js).
  const selecting = event => event.ctrlKey || event.metaKey || event.shiftKey;
  button.addEventListener('click', event => { if (selecting(event)) return; event.stopPropagation(); open(project.name, base); });
  button.addEventListener('dblclick', event => event.stopPropagation());
  return button;
}
