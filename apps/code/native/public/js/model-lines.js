// A line is a model's name without its version ("GPT-6.1 Sol" is of the line
// "GPT Sol", "Opus 4.8" of "Opus"), within one harness and provider. Of each
// line only the newest is offered: the highest version. Nothing here knows any
// model by name; it reads the names the harnesses give.
const VERSION = /\d+(?:\.\d+)*/;

export function modelLine(text) {
	const name = String(text ?? '').replace(/\s*\([^)]*\)\s*$/, '').trim();
	const found = VERSION.exec(name);
	if (!found) return { line: name.toLowerCase(), version: null };
	const line = `${name.slice(0, found.index)}#${name.slice(found.index + found[0].length)}`;
	return { line: line.toLowerCase().replace(/\s+/g, ' '), version: found[0].split('.').map(Number) };
}

const compare = (a, b) => {
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		const d = (a[i] ?? 0) - (b[i] ?? 0);
		if (d) return d;
	}
	return 0;
};

// The models, in their order, less those an equal-line model outdoes. A model
// with no version is a line of its own; `keep` (the model a session is on)
// stays whatever its age.
export function newestOfEachLine(models, text, keep = () => false) {
	const lineOf = m => { const { line, version } = modelLine(text(m)); return { key: `${m.engine ?? ''}\u0000${m.provider ?? ''}\u0000${line}`, version }; };
	const newest = new Map();
	for (const m of models) {
		const { key, version } = lineOf(m);
		if (version && (!newest.has(key) || compare(version, newest.get(key)) > 0)) newest.set(key, version);
	}
	return models.filter(m => {
		const { key, version } = lineOf(m);
		return !version || compare(version, newest.get(key)) === 0 || keep(m);
	});
}
