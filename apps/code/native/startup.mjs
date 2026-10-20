import { homedir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';

// The overview a new conversation opens on, as Pi's terminal opens on its
// startup block: which harness, in which folder, and what it was put together
// from (instruction files, skills, prompts, extensions or MCP servers, tools),
// one line each. Both harnesses answer in this one shape.

export function tildePath(p) {
  const home = homedir();
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

export function cwdRelative(p, cwd) {
  const abs = isAbsolute(p) ? resolve(p) : resolve(cwd, p);
  const rel = relative(resolve(cwd), abs);
  if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return rel;
  if (!rel) return '.';
  return tildePath(abs);
}

export const sorted = items => [...items].sort((a, b) => a.localeCompare(b));

// One line: `items` joined on it, `detail` (one entry each) when it is opened.
export function section(name, items, detail = items) {
  return items.length ? { name, compact: items.join(', '), expanded: detail.join('\n') } : null;
}

export function startup(harness, version, cwd, sections) {
  return { version: version ? `${harness} ${version}` : harness, cwd: tildePath(cwd), sections: sections.filter(Boolean) };
}
