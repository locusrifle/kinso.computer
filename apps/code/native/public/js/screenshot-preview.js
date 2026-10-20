// A screenshot just taken (imperfect OS's Print or Super+Shift+S; the
// computer says so, system/clipboard.mjs): a small picture of it under the
// screen's status group, already saved and on the clipboard, with what to do
// next: into the input bar, open in Files, or delete. It goes by itself after
// a few seconds unless the pointer or the keys are on it; Escape or a press
// elsewhere sends it away. It never takes the keys.

import { hang } from './system.js';

const LINGER = 8000;
const el = (tag, text, className) => {
	const node = document.createElement(tag);
	if (text != null) node.textContent = text;
	if (className) node.className = className;
	return node;
};
const button = (text, className, onclick) => {
	const node = el('button', text, className);
	node.type = 'button';
	node.onclick = onclick;
	return node;
};

// attach(file): into the input bar. files(path): opens it in Files.
export function mountScreenshotPreview({ anchor, band, attach, files, beforeOpen = () => {}, fetcher = (...args) => fetch(...args), linger = LINGER }) {
	const panel = el('div', null, 'screen-panel shot-panel');
	panel.setAttribute('role', 'region');
	panel.setAttribute('aria-label', 'Screenshot');
	panel.hidden = true;
	document.body.append(panel);
	let name = '', timer = null, held = false;

	const later = () => { clearTimeout(timer); if (!held) timer = setTimeout(close, linger); };
	const url = () => `/screenshots/${encodeURIComponent(name)}`;
	const say = (text, wrong = true) => {
		const line = panel.querySelector('.system-line');
		line.textContent = text;
		line.classList.toggle('error', wrong);
		line.hidden = !text;
	};

	function show(taken) {
		beforeOpen();
		name = taken;
		const picture = el('img', null, 'shot-image');
		Object.assign(picture, { src: url(), alt: `Screenshot ${name}`, decoding: 'async', draggable: false });
		const actions = el('div', null, 'system-row shot-actions');
		const attachButton = button('attach here', 'system-action', () => void into());
		actions.append(
			el('span', 'saved · copied', 'system-label system-note'),
			attachButton,
			button('files', 'system-action', () => { files(`Pictures/screenshots/${name}`); close(); }),
			button('delete', 'system-action', () => void remove()));
		const line = el('p', '', 'system-line');
		line.hidden = true;
		line.setAttribute('aria-live', 'polite');
		panel.replaceChildren(picture, actions, line);
		panel.hidden = false;
		held = panel.matches(':hover');
		hang(panel, { anchor, band, width: 320 });
		later();
	}
	function close() {
		clearTimeout(timer);
		if (panel.hidden) return;
		if (panel.contains(document.activeElement)) document.activeElement.blur();
		panel.hidden = true;
		panel.replaceChildren();
		name = ''; held = false;
	}
	async function into() {
		try {
			const res = await fetcher(url(), { cache: 'no-store' });
			if (!res.ok) throw new Error('it is gone');
			const blob = await res.blob();
			const file = new File([blob], name, { type: 'image/png' });
			close();
			await attach(file);
		} catch (failure) { say(`not attached: ${failure.message}`); }
	}
	async function remove() {
		try {
			const res = await fetcher('/screenshots', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ delete: name }) });
			const answer = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(answer.error || 'it did not work');
			close();
		} catch (failure) { say(`not deleted: ${failure.message}`); }
	}

	const hold = on => { held = on; later(); };
	panel.addEventListener('pointerenter', () => hold(true));
	panel.addEventListener('pointerleave', () => hold(panel.contains(document.activeElement)));
	panel.addEventListener('focusin', () => hold(true));
	panel.addEventListener('focusout', event => { if (!panel.contains(event.relatedTarget)) hold(panel.matches(':hover')); });
	addEventListener('keydown', event => {
		if (panel.hidden || event.key !== 'Escape') return;
		event.stopImmediatePropagation(); event.preventDefault();
		close();
	}, true);
	addEventListener('pointerdown', event => { if (!panel.hidden && !panel.contains(event.target)) close(); }, true);
	addEventListener('resize', () => { if (!panel.hidden) hang(panel, { anchor, band, width: 320 }); });

	return { panel, show, close, isOpen: () => !panel.hidden };
}
