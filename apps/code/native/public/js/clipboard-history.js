// The clipboard's history (system/clipboard.mjs), for this computer's own
// screen: Super+Shift+V (Alt+V in a browser) opens what was copied, newest first,
// text and pictures, hung under the screen's status group as the system panel
// is. Picking one puts it back on the clipboard, and into the input bar when
// the keys were there. Each can be deleted, or all at once. On a computer that
// keeps no history, or a screen that is not its own (the phone, another
// computer's window), the computer says no, nothing is drawn and the key does
// nothing.

import { hang } from './system.js';

const el = (tag, text, className) => {
	const node = document.createElement(tag);
	if (text != null) node.textContent = text;
	if (className) node.className = className;
	return node;
};
const button = (text, className, onclick, label) => {
	const node = el('button', text, className);
	node.type = 'button';
	if (label) node.setAttribute('aria-label', label);
	node.onclick = onclick;
	return node;
};

// The clipboard takes pictures as PNG only.
async function asPng(blob) {
	if (blob.type === 'image/png') return blob;
	const bitmap = await createImageBitmap(blob);
	const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
	canvas.getContext('2d').drawImage(bitmap, 0, 0);
	return canvas.convertToBlob({ type: 'image/png' });
}

// composer: { input, paste(text), attach(file) }, the input bar.
export function mountClipboardHistory({ anchor, band, composer, beforeOpen = () => {}, fetcher = (...args) => fetch(...args), clipboard = () => navigator.clipboard }) {
	const panel = el('div', null, 'screen-panel clip-panel');
	panel.setAttribute('role', 'dialog');
	panel.setAttribute('aria-label', 'Clipboard');
	panel.hidden = true;
	document.body.append(panel);

	let available = false, open = false, loading = false, items = [], error = '', confirming = false, busy = false;
	// Where the keys were, to go back to; whether that was the input bar.
	let returnTo = null, intoComposer = false;

	async function load() {
		try {
			const res = await fetcher('/clipboard', { cache: 'no-store' });
			available = res.ok;
			const answer = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(answer.error || 'the history did not open');
			items = answer.items ?? [];
			error = '';
		} catch (failure) { if (available) error = failure.message; }
	}
	async function post(body) {
		const res = await fetcher('/clipboard', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
		const answer = await res.json().catch(() => ({}));
		if (!res.ok) throw new Error(answer.error || 'it did not work');
		return answer;
	}

	const picks = () => [...panel.querySelectorAll('.clip-pick')];
	function paint(focusAt = -1) {
		if (!open) return;
		const head = el('header', null, 'system-head clip-head');
		if (confirming) {
			head.append(el('h2', 'clear everything copied?'),
				button('clear', 'system-action system-danger', () => wipe()),
				button('cancel', 'system-action', () => { confirming = false; paint(); panel.querySelector('.clip-head button')?.focus(); }));
		} else {
			head.append(el('h2', 'clipboard'));
			if (items.length) head.append(button('clear', 'system-action', () => { confirming = true; paint(); panel.querySelector('.clip-head .system-danger')?.focus(); }, 'Clear the clipboard history'));
		}
		const section = el('section', null, 'system-section clip-section');
		section.append(head);
		const list = el('div', null, 'clip-list');
		for (const item of items) {
			const row = el('div', null, 'clip-item');
			const pick = button(null, 'clip-pick', () => choose(item));
			pick.dataset.id = item.id;
			if (item.kind === 'image') {
				const picture = el('img', null, 'clip-image');
				Object.assign(picture, { src: `/clipboard/${encodeURIComponent(item.id)}`, alt: '', loading: 'lazy', decoding: 'async', draggable: false });
				pick.append(picture, el('span', `${item.format} ${item.width}×${item.height} · ${item.size}`, 'system-note'));
				pick.setAttribute('aria-label', `Picture, ${item.width} by ${item.height}`);
			} else pick.append(el('span', item.text, 'clip-text'));
			row.append(pick, button('×', 'clip-delete', () => remove(item), 'Delete from the history'));
			list.append(row);
		}
		const line = el('p', error || (items.length || loading ? '' : 'nothing copied yet'), `system-line${error ? ' error' : ''}`);
		line.hidden = !line.textContent;
		line.setAttribute('aria-live', 'polite');
		panel.replaceChildren(section, list, line);
		hang(panel, { anchor, band, width: 420 });
		if (focusAt >= 0) (picks()[Math.min(focusAt, picks().length - 1)] ?? panel.querySelector('.clip-head button') ?? panel).focus({ preventScroll: false });
	}

	async function choose(item) {
		if (busy) return;
		busy = true;
		try {
			const res = await fetcher(`/clipboard/${encodeURIComponent(item.id)}`, { cache: 'no-store' });
			if (!res.ok) throw new Error('it is gone');
			const blob = await res.blob();
			if (item.kind === 'image' || blob.type.startsWith('image/')) {
				const png = await asPng(blob);
				await clipboard().write([new ClipboardItem({ 'image/png': png })]);
				close();
				if (intoComposer) composer.attach(new File([png], `clipboard-${item.id}.png`, { type: 'image/png' }));
			} else {
				const text = await blob.text();
				await clipboard().writeText(text);
				close();
				if (intoComposer) composer.paste(text);
			}
		} catch (failure) {
			error = `not copied: ${failure.message}`;
			paint(Math.max(0, items.indexOf(item)));
		} finally { busy = false; }
	}
	async function remove(item) {
		const at = items.indexOf(item);
		try { items = (await post({ do: 'delete', id: item.id })).items ?? []; error = ''; }
		catch (failure) { error = `not deleted: ${failure.message}`; }
		paint(Math.max(0, at));
	}
	// Everything forgotten, and what is on the clipboard now with it.
	async function wipe() {
		confirming = false;
		try {
			items = (await post({ do: 'wipe' })).items ?? [];
			error = '';
			await clipboard().writeText('').catch(() => {});
		} catch (failure) { error = `not cleared: ${failure.message}`; }
		paint(0);
	}

	async function show() {
		if (!available) return;
		beforeOpen();
		const active = document.activeElement;
		returnTo = active && active !== document.body ? active : null;
		intoComposer = active === composer.input;
		open = true; confirming = false; error = ''; loading = true; items = [];
		panel.hidden = false;
		paint();
		await load();
		loading = false;
		if (!open) return;
		if (!available) { close(); return; }
		paint(0);
	}
	function close() {
		if (!open) return;
		open = false; confirming = false;
		panel.hidden = true;
		panel.replaceChildren();
		if (returnTo?.isConnected) returnTo.focus({ preventScroll: true });
		returnTo = null;
	}

	panel.addEventListener('keydown', event => {
		const all = picks();
		const at = all.indexOf(document.activeElement);
		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault();
			const next = at < 0 ? 0 : Math.max(0, Math.min(all.length - 1, at + (event.key === 'ArrowDown' ? 1 : -1)));
			all[next]?.focus();
		} else if ((event.key === 'Delete' || event.key === 'Backspace') && at >= 0) {
			event.preventDefault();
			void remove(items[at]);
		}
	});
	// Escape steps back: out of the question, then the panel shut.
	addEventListener('keydown', event => {
		if (!open || event.key !== 'Escape') return;
		event.stopImmediatePropagation(); event.preventDefault();
		if (confirming) { confirming = false; paint(0); return; }
		close();
	}, true);
	addEventListener('pointerdown', event => { if (open && !panel.contains(event.target)) close(); }, true);
	addEventListener('resize', () => { if (open) hang(panel, { anchor, band, width: 420 }); });

	void load();
	return {
		panel,
		available: () => available,
		isOpen: () => open,
		toggle: () => (open ? close() : void show()),
		close,
	};
}
