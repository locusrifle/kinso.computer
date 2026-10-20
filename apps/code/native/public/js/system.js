// This computer's controls (system/controls.mjs): at a glance at the top
// centre of the screen, beside the clock, its Wi-Fi and battery; pressed,
// its controls are presented by the window's shared panel when attached.
// Always this window's own computer, the one whose screen this is: the request is never routed to
// another computer, and the computer refuses it from anywhere but its own
// screen, so on the phone, a hosted computer or a computer without these
// tools nothing here is drawn at all.

const SVG = 'http://www.w3.org/2000/svg';
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
export const signalBars = signal => (signal >= 75 ? 4 : signal >= 50 ? 3 : signal >= 25 ? 2 : signal > 0 ? 1 : 0);
// Wi-Fi and the battery as a Mac's menu bar draws them (Noah: in the new
// style), drawn in the ink: what is not there yet is the ink, faint.
function drawn(width, height, parts, className) {
	const svg = document.createElementNS(SVG, 'svg');
	svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
	svg.setAttribute('width', String(width));
	svg.setAttribute('height', String(height));
	svg.setAttribute('aria-hidden', 'true');
	svg.classList.add('system-icon', className);
	for (const [tag, attributes, faint] of parts) {
		const node = document.createElementNS(SVG, tag);
		for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
		if (faint) node.setAttribute('opacity', '0.3');
		svg.append(node);
	}
	return svg;
}
// A fan of three arcs over a dot, lit from the dot out as the signal is.
const ARC = { fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7, 'stroke-linecap': 'round' };
const wifiIcon = (bars, className = 'system-wifi-icon') => drawn(16, 12, [
	['circle', { cx: 8, cy: 10.4, r: 1.35, fill: 'currentColor' }, bars < 1],
	['path', { ...ARC, d: 'M5.4 7.8a3.7 3.7 0 0 1 5.2 0' }, bars < 2],
	['path', { ...ARC, d: 'M3.25 5.65a6.7 6.7 0 0 1 9.5 0' }, bars < 3],
	['path', { ...ARC, d: 'M1.1 3.5a9.75 9.75 0 0 1 13.8 0' }, bars < 4],
], className);
// A rounded cell, its outline and cap faint, filled as it is charged, and a
// bolt across it on the mains.
function batteryIcon(percent, plugged) {
	const fill = Math.max(1.5, 17 * Math.min(100, Math.max(0, percent)) / 100);
	return drawn(24, 12, [
		['rect', { x: 0.75, y: 0.75, width: 20.5, height: 10.5, rx: 3, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.2, opacity: 0.4 }],
		['path', { d: 'M22.4 4.2c.8.2 1.3.9 1.3 1.8s-.5 1.6-1.3 1.8z', fill: 'currentColor', opacity: 0.4 }],
		['rect', { x: 2.5, y: 2.5, width: fill.toFixed(1), height: 7, rx: 1.6, fill: 'currentColor' }],
		...(plugged ? [['path', { d: 'M12.4 1.2 7.6 6.6h3l-1 4.2 4.8-5.4h-3z', fill: 'currentColor', stroke: 'var(--surface, #000)', 'stroke-width': 0.9, 'paint-order': 'stroke' }]] : []),
	], 'system-battery-icon');
}
// The panel's controls share the Wi-Fi glyph's rounded stroke, not words
// standing in for icons. These are drawn locally in the theme's ink.
function controlIcon(kind, muted = false) {
	const paths = {
		speaker: ['M4 9h4l5-4v14l-5-4H4z', ...(muted ? ['M3 3l18 18'] : ['M16 8a6 6 0 0 1 0 8', 'M19 5a10 10 0 0 1 0 14'])],
		mic: ['M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0z', 'M6 11v1a6 6 0 0 0 12 0v-1M12 18v4M9 22h6', ...(muted ? ['M3 3l18 18'] : [])],
		sun: ['M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.4 1.4M17.6 17.6 19 19M5 19l1.4-1.4M17.6 6.4 19 5'],
		headphones: ['M4 13v-2a8 8 0 0 1 16 0v2', 'M3 12h3v8H3zM18 12h3v8h-3z'],
		keyboard: ['M3 6h18v12H3zM6 10h1M10 10h1M14 10h1M18 10h.1M7 14h10'],
		device: ['M3 4h18v13H3zM12 17v4M8 21h8'],
	};
	return drawn(24, 24, [
		...(paths[kind] || paths.device).map(d => ['path', { ...ARC, d, 'stroke-linejoin': 'round' }]),
		...(kind === 'sun' ? [['circle', { ...ARC, cx: 12, cy: 12, r: 4 }]] : []),
	], `system-${kind}-icon`);
}
export const minutesText = minutes => (!Number.isFinite(minutes) || minutes <= 0 ? '' : minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`);
export function batteryText(battery) {
	if (!battery) return '';
	const words = [`${battery.percent}%`];
	if (battery.charging) words.push('charging', minutesText(battery.timeToFull) && `${minutesText(battery.timeToFull)} to full`);
	else if (battery.plugged) words.push('plugged in');
	else words.push(minutesText(battery.timeToEmpty) && `${minutesText(battery.timeToEmpty)} left`);
	return words.filter(Boolean).join(' · ');
}
export const applies = state => Boolean(state && ['wifi', 'bluetooth', 'sound', 'brightness', 'battery', 'power'].some(key => state[key]));

// A panel of the screen's status group hangs from the band's lower edge,
// centred under the group, no gap, down to the input bar at most; a window
// too narrow for it gets one the whole width.
export function hang(panel, { anchor, band, width = 380 }) {
	const group = anchor.getBoundingClientRect();
	const heading = band.querySelector('.session-rail-heading')?.getBoundingClientRect();
	const top = Math.round(heading?.bottom || group.bottom + 44);
	const bottom = document.querySelector('#entry-terminal > .entry-status')?.getBoundingClientRect().top || innerHeight;
	const full = innerWidth < width + 100;
	const w = full ? innerWidth : width;
	const left = full ? 0 : Math.max(0, Math.min(innerWidth - w, Math.round((group.left + group.right) / 2 - w / 2)));
	panel.classList.toggle('full', full);
	Object.assign(panel.style, { top: `${top}px`, left: `${left}px`, width: `${w}px`, maxHeight: `${Math.max(160, Math.round(bottom - top))}px` });
}

export function mountSystem({ anchor, band, fetcher = (...args) => fetch(...args) }) {
	// The whole group is the way in, the time as much as the glance.
	const status = button(null, 'system-status', null, 'This computer');
	status.hidden = true;
	status.setAttribute('aria-expanded', 'false');
	status.setAttribute('aria-haspopup', 'dialog');
	const panel = el('div', null, 'screen-panel system-panel');
	panel.setAttribute('role', 'dialog');
	panel.setAttribute('aria-label', 'This computer');
	panel.tabIndex = -1;
	panel.hidden = true;
	document.body.append(panel);

	// refused: this page is not on the computer's own screen (the phone, a
	// hosted computer, another computer's window) or it has none of the tools;
	// that does not change while the page is open, so it stops asking.
	let state = null, open = false, timer = null, generation = 0, refused = false;
	let asking = '', confirming = '', busy = '', error = '', pressing = false, powerOnly = false;
	let networkOptions = '', forgetNetwork = '', scanning = false, revision = 0;
	let deviceOptions = '', presenter = null;

	// The window manager mounts after these controls. It owns the shared
	// right panel's placement/lifetime; a standalone caller still hangs below
	// the status group. close() is idempotent so the host's onClose can call it.
	function setPresenter(host) {
		if (presenter === host) return;
		if (open) close();
		presenter = host;
		panel.classList.toggle('system-panel-hosted', Boolean(host));
		panel.classList.remove('full');
		for (const key of ['top', 'left', 'width', 'maxHeight']) panel.style[key] = '';
		if (!host) document.body.append(panel);
	}

	async function ask(full = open) {
		const mine = ++generation;
		try {
			const res = await fetcher(full ? '/system?panel=1' : '/system', { cache: 'no-store' });
			if (mine !== generation) return;
			if (res.status === 403 || res.status === 404) refused = true;
			// The screen locked (423) keeps what was last seen; the lock going asks again.
			if (res.status === 423) return;
			state = res.ok ? await res.json() : null;
			if (res.ok && !applies(state)) refused = true;
		} catch { if (mine === generation) state = null; }
		paintStatus();
		if (open) paintPanel();
	}
	async function act(body, label) {
		revision++;
		const focused = panel.contains(document.activeElement) ? document.activeElement.dataset.systemFocus : null;
		busy = label; error = ''; paintPanel(true);
		try {
			const res = await fetcher('/system', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
			const answer = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(answer.error || 'it did not work');
			if (!answer.done) state = answer;
		} catch (failure) { error = `${label}: ${failure.message}`; }
		busy = '';
		paintStatus();
		paintPanel(true);
		if (focused) focusWifi(focused);
	}
	const schedule = () => {
		clearTimeout(timer);
		if (document.hidden || refused) return;
		timer = setTimeout(async () => { await ask(); schedule(); }, open ? 4000 : 30_000);
	};

	function paintStatus() {
		const shown = applies(state);
		status.hidden = !shown;
		if (!shown) { if (open) close(); return; }
		const parts = [];
		const { wifi, battery } = state;
		if (wifi) {
			const on = wifi.enabled && wifi.hardware;
			// the icon alone (Noah): the network's name is in its title
			parts.push(wifiIcon(on && wifi.connected ? signalBars(wifi.signal ?? 100) : 0));
		}
		if (battery) {
			const holder = el('span', null, 'system-battery');
			holder.classList.toggle('low', Boolean(battery.low));
			holder.append(batteryIcon(battery.percent, battery.plugged), el('span', `${battery.percent}%`));
			parts.push(holder);
		}
		// Only sound or Bluetooth here: still a way in.
		if (!parts.length) parts.push(el('span', 'system', 'system-word'));
		const look = JSON.stringify([wifi && [wifi.enabled, wifi.connected, wifi.network, signalBars(wifi.signal ?? 100)], battery && [battery.percent, battery.plugged, battery.low]]);
		if (status.dataset.look !== look) { status.dataset.look = look; status.replaceChildren(...parts); }
		status.title = [wifi && (wifi.connected ? `Wi-Fi: ${wifi.network}` : 'Wi-Fi: not connected'), battery && `Battery: ${batteryText(battery)}`].filter(Boolean).join('\n');
	}

	/* ------------------------------------------------------------ panel */
	const section = (name, ...controls) => {
		const node = el('section', null, `system-section system-${name.replace(/\W/g, '')}`);
		const head = el('header', null, 'system-head');
		const titles = { 'wi-fi': 'Wi-Fi', bluetooth: 'Bluetooth', sound: 'Sound', screen: 'Display', battery: 'Battery', power: 'Power' };
		head.append(el('h2', titles[name] || name), ...controls.filter(Boolean));
		node.append(head);
		return node;
	};
	const toggle = (on, label, flip, text) => {
		const node = button(text || null, text ? 'system-toggle' : 'system-switch', flip, label);
		if (text) node.setAttribute('aria-pressed', String(Boolean(on)));
		else {
			node.setAttribute('role', 'switch');
			node.setAttribute('aria-checked', String(Boolean(on)));
			node.append(el('span', null, 'system-switch-track'));
		}
		node.dataset.systemFocus = label.replace(/Turn | on$| off$/g, '').replace(/^(Unmute|Mute) /, 'mute:');
		return node;
	};
	const row = (...children) => { const node = el('div', null, 'system-row'); node.append(...children.filter(Boolean)); return node; };
	const slider = (value, label, send, min = 0) => {
		const input = el('input', null, 'system-slider');
		Object.assign(input, { type: 'range', min: String(min), max: '100', step: '1', value: String(Math.round(value)) });
		input.setAttribute('aria-label', label);
		input.dataset.systemFocus = label;
		const fill = () => input.style.setProperty('--slider-fill', `${(Number(input.value) - min) / (100 - min) * 100}%`);
		fill(); input.oninput = fill;
		input.onchange = () => send(Number(input.value));
		return [input];
	};
	const chooser = (rows, label, pick) => {
		const select = el('select', null, 'system-select');
		select.setAttribute('aria-label', label);
		for (const item of rows) {
			const option = el('option', item.name);
			option.value = String(item.id);
			option.selected = item.default;
			select.append(option);
		}
		select.onchange = () => pick(Number(select.value));
		return select;
	};

	async function scanWifi() {
		if (scanning || !open || !state?.wifi?.enabled || !state.wifi.hardware) return;
		const started = revision;
		const focused = panel.contains(document.activeElement) ? document.activeElement.dataset.systemFocus : null;
		scanning = true; paintPanel();
		try {
			const res = await fetcher('/system', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ do: 'wifi-scan' }) });
			const next = await res.json();
			if (!res.ok) throw new Error(next.error || 'Could not scan for networks');
			if (started === revision && !next.done) state = next;
		} catch (failure) { error = `Scanning: ${failure.message}`; }
		scanning = false;
		paintStatus(); paintPanel();
		if (focused && document.activeElement === document.body) focusWifi(focused);
	}
	function scanStatus() {
		const progress = el('span', scanning ? 'Scanning…' : '', 'system-scanning');
		progress.setAttribute('role', 'status');
		if (scanning) progress.prepend(el('span', null, 'system-spinner'));
		return progress;
	}

	function wifiSection(wifi) {
		const on = wifi.enabled && wifi.hardware;
		const radio = toggle(on, on ? 'Turn Wi-Fi off' : 'Turn Wi-Fi on', () => {
			asking = ''; networkOptions = ''; forgetNetwork = '';
			act({ do: 'wifi-radio', on: !on }, on ? 'Wi-Fi off' : 'Wi-Fi on');
		});
		radio.disabled = !wifi.hardware || Boolean(busy);
		const refresh = button(null, 'system-refresh', scanWifi, 'Refresh networks');
		refresh.append(drawn(16, 16, [
			['path', { d: 'M12.5 5.5a5 5 0 1 0 .3 4.1M12.5 1.8v3.8H8.7', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }],
		], 'system-refresh-icon'));
		refresh.dataset.systemFocus = 'refresh';
		refresh.disabled = !on || scanning || Boolean(busy);
		const node = section('wi-fi', scanStatus(), refresh, radio);
		if (!on) {
			node.append(el('p', wifi.hardware ? 'Wi-Fi is off' : 'Wi-Fi is off at the hardware switch', 'system-wifi-message'));
			return node;
		}
		const networks = [...(wifi.networks ?? [])].sort((a, b) => b.signal - a.signal || a.ssid.localeCompare(b.ssid));
		const list = el('div', null, 'system-list');
		list.setAttribute('aria-label', 'Wi-Fi networks');
		list.setAttribute('aria-busy', String(scanning));
		for (const [title, group] of [
			['', networks.filter(n => n.active)],
			['Known networks', networks.filter(n => !n.active && n.known)],
			['Other networks', networks.filter(n => !n.active && !n.known)],
		]) {
			if (!group.length) continue;
			const groupNode = el('div', null, 'system-network-group');
			groupNode.setAttribute('role', 'group');
			groupNode.setAttribute('aria-label', title || 'Connected network');
			if (title) groupNode.append(el('h3', title, 'system-network-heading'));
			for (const network of group) groupNode.append(networkRow(network));
			list.append(groupNode);
		}
		if (!networks.length) list.append(el('p', scanning ? 'Looking for nearby networks…' : 'No networks found', 'system-wifi-message'));
		node.append(list);
		return node;
	}

	function networkRow(network) {
		const { ssid, active, known, secured } = network;
		const holder = el('div', null, 'system-network');
		const line = el('div', null, `system-item${active ? ' active' : ''}`);
		const name = button(null, 'system-name', () => {
			if (active) return;
			networkOptions = ''; forgetNetwork = '';
			if (network.enterprise) { error = `${ssid}: needs a work or school login, not supported here`; paintPanel(true); return; }
			if (secured && !known) { asking = asking === ssid ? '' : ssid; paintPanel(true); panel.querySelector('.system-password')?.focus(); return; }
			asking = '';
			act({ do: 'wifi-connect', ssid }, `joining ${ssid}`);
		}, `${active ? `${ssid}, connected` : `Join ${ssid}`}, ${secured ? 'secured' : 'open'} network`);
		name.dataset.systemFocus = `network:${ssid}`;
		if (secured && !known && !active && !network.enterprise) {
			name.setAttribute('aria-expanded', String(asking === ssid));
			name.setAttribute('aria-controls', `system-password-${encodeURIComponent(ssid)}`);
		}
		name.disabled = Boolean(busy);
		const signal = el('span', null, 'system-signal');
		signal.append(wifiIcon(signalBars(network.signal)));
		const label = el('span', null, 'system-label');
		label.append(el('span', ssid, 'system-ssid'));
		if (active) label.append(el('span', 'Connected', 'system-note'));
		name.append(signal, label);
		if (secured) name.append(drawn(10, 12, [
			['path', { d: 'M2.5 5V3.5a2.5 2.5 0 0 1 5 0V5', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.3 }],
			['rect', { x: 1, y: 5, width: 8, height: 6, rx: 1.5, fill: 'currentColor' }],
		], 'system-lock'));
		line.append(name);
		if (active || known) {
			const options = button('⋯', 'system-network-options', () => {
				asking = ''; forgetNetwork = ''; networkOptions = networkOptions === ssid ? '' : ssid;
				paintPanel(true);
			}, `Options for ${ssid}`);
			options.dataset.systemFocus = `options:${ssid}`;
			options.setAttribute('aria-expanded', String(networkOptions === ssid));
			options.setAttribute('aria-controls', `system-options-${encodeURIComponent(ssid)}`);
			options.disabled = Boolean(busy);
			line.append(options);
		}
		holder.append(line);
		if (networkOptions === ssid) {
			const actions = el('div', null, 'system-network-actions');
			actions.id = `system-options-${encodeURIComponent(ssid)}`;
			actions.setAttribute('role', 'group');
			actions.setAttribute('aria-label', `Options for ${ssid}`);
			if (forgetNetwork === ssid) {
				actions.append(el('p', `Forget “${ssid}”? You’ll need to join it again.`, 'system-forget-note'),
					button('Cancel', 'system-action', () => { forgetNetwork = ''; paintPanel(true); focusWifi(`options:${ssid}`); }),
					button('Forget', 'system-action system-danger', () => {
						networkOptions = ''; forgetNetwork = '';
						act({ do: 'wifi-forget', ssid }, `forgetting ${ssid}`).then(() => focusWifi(`network:${ssid}`));
					}, `Forget ${ssid}`));
			} else {
				if (active) actions.append(button('Disconnect', 'system-action', () => {
					networkOptions = '';
					act({ do: 'wifi-disconnect' }, 'disconnecting').then(() => focusWifi(`network:${ssid}`));
				}));
				if (known) actions.append(button('Forget This Network…', 'system-action', () => {
					forgetNetwork = ssid; paintPanel(true); panel.querySelector('.system-network-actions button')?.focus();
				}));
			}
			[...actions.querySelectorAll('button')].forEach((node, index) => { node.dataset.systemFocus = `action:${ssid}:${forgetNetwork === ssid ? 'confirm' : 'options'}:${index}`; });
			holder.append(actions);
		}
		if (asking === ssid) holder.append(passwordRow(ssid));
		return holder;
	}
	function focusWifi(key) {
		[...panel.querySelectorAll('[data-system-focus]')].find(node => node.dataset.systemFocus === key)?.focus({ preventScroll: true });
	}
	// The password goes from this field to the computer and nowhere else: not
	// the input bar, not a draft, not a log. The field is emptied as it is sent.
	function passwordRow(ssid) {
		const form = el('form', null, 'system-row system-join');
		form.id = `system-password-${encodeURIComponent(ssid)}`;
		const field = el('input', null, 'system-password');
		Object.assign(field, { type: 'password', autocomplete: 'off', spellcheck: false, placeholder: 'Password' });
		field.setAttribute('autocapitalize', 'off');
		field.setAttribute('aria-label', `Password for ${ssid}`);
		const join = el('button', 'Join', 'system-action system-primary');
		join.type = 'submit';
		form.append(field, join);
		// Pasted here, it is taken out of the clipboard's history (clipboard.mjs).
		field.addEventListener('paste', event => {
			const text = event.clipboardData?.getData('text/plain');
			if (text) fetcher('/clipboard', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ do: 'forget', text }) }).catch(() => {});
		});
		form.onsubmit = event => {
			event.preventDefault();
			const password = field.value;
			field.value = '';
			if (!password) return;
			asking = '';
			act({ do: 'wifi-connect', ssid, password }, `joining ${ssid}`).then(() => focusWifi(`network:${ssid}`));
		};
		return form;
	}

	function bluetoothSection(bt) {
		const refresh = button(null, 'system-refresh', () => act({ do: 'bluetooth-scan' }, 'looking for devices'), 'Refresh Bluetooth devices');
		refresh.append(drawn(16, 16, [
			['path', { d: 'M12.5 5.5a5 5 0 1 0 .3 4.1M12.5 1.8v3.8H8.7', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }],
		], 'system-refresh-icon'));
		refresh.disabled = bt.discovering || busy === 'looking for devices';
		const node = section('bluetooth', bt.powered && refresh, toggle(bt.powered, bt.powered ? 'Turn Bluetooth off' : 'Turn Bluetooth on', () => { deviceOptions = ''; act({ do: 'bluetooth-power', on: !bt.powered }, bt.powered ? 'bluetooth off' : 'bluetooth on'); }));
		if (!bt.powered) return node;
		if (bt.discovering || busy === 'looking for devices') node.append(el('p', 'Scanning…', 'system-device-message'));
		const list = el('div', null, 'system-list');
		for (const device of bt.devices ?? []) {
			const holder = el('div', null, 'system-device');
			const line = el('div', null, `system-item${device.connected ? ' active' : ''}`);
			const name = el('span', null, 'system-name');
			const kind = /headphone|headset|airpods/i.test(device.name) ? 'headphones' : /keyboard/i.test(device.name) ? 'keyboard' : /speaker/i.test(device.name) ? 'speaker' : 'device';
			const glyph = el('span', null, 'system-signal'); glyph.append(controlIcon(kind));
			const label = el('span', null, 'system-label');
			label.append(el('span', device.name, 'system-ssid'), el('span', device.connected ? 'Connected' : device.paired ? 'Paired' : 'Nearby', 'system-note'));
			name.append(glyph, label);
			const options = button('⋯', 'system-network-options', () => { deviceOptions = deviceOptions === device.address ? '' : device.address; paintPanel(true); }, `Options for ${device.name}`);
			options.dataset.systemFocus = `device:${device.address}`;
			options.setAttribute('aria-expanded', String(deviceOptions === device.address));
			options.setAttribute('aria-controls', `system-device-${device.address}`);
			line.append(name, options); holder.append(line);
			if (deviceOptions === device.address) {
				const actions = el('div', null, 'system-device-actions');
				actions.id = `system-device-${device.address}`;
				actions.setAttribute('role', 'group'); actions.setAttribute('aria-label', `Options for ${device.name}`);
				const doing = (verb, text, label) => {
					const action = button(text, `system-action${verb === 'remove' ? ' system-danger' : ''}`, () => {
						deviceOptions = ''; act({ do: `bluetooth-${verb}`, address: device.address }, `${label} ${device.name}`).then(() => focusWifi(`device:${device.address}`));
					});
					action.dataset.systemFocus = `device:${device.address}:${verb}`; return action;
				};
				if (!device.paired) actions.append(doing('pair', 'Pair', 'pairing'));
				else if (device.connected) actions.append(doing('disconnect', 'Disconnect', 'disconnecting'));
				else actions.append(doing('connect', 'Connect', 'connecting'));
				if (device.paired) actions.append(doing('remove', 'Remove', 'removing'));
				holder.append(actions);
			}
			list.append(holder);
		}
		if (!(bt.devices ?? []).length) list.append(el('p', 'No devices found', 'system-device-message'));
		node.append(list);
		return node;
	}

	function soundSection(sound) {
		const node = section('sound');
		for (const [target, channel, kind, label] of [['output', sound.output, 'speaker', 'output'], ['input', sound.input, 'mic', 'microphone']]) {
			if (!channel) continue;
			const mute = toggle(channel.muted, `${channel.muted ? 'Unmute' : 'Mute'} ${label}`, () => act({ do: 'sound-mute', target, on: !channel.muted }, target === 'output' ? 'sound' : 'mic'), 'mute');
			mute.className = 'system-glyph-button'; mute.replaceChildren(controlIcon(kind, channel.muted));
			if (target === 'output') node.append(row(mute, ...slider(channel.volume * 100, 'Output volume', value => act({ do: 'sound-volume', target, value: value / 100 }, 'volume'))));
			const devices = target === 'output' ? sound.outputs : sound.inputs;
			if (target === 'input') node.append(row(mute, devices?.length ? chooser(devices, 'Input device', id => act({ do: 'sound-default', target, id }, 'mic')) : el('span', 'Microphone', 'system-label')));
			else if (devices?.length > 1) {
				const deviceRow = row(chooser(devices, 'Output device', id => act({ do: 'sound-default', target, id }, 'output')));
				deviceRow.classList.add('system-device-chooser'); node.append(deviceRow);
			}
		}
		return node;
	}

	function powerSection() {
		const node = section('power');
		const words = { suspend: 'Sleep', reboot: 'Restart', poweroff: 'Shut Down' };
		if (confirming) {
			const question = el('div', null, 'system-power-confirm');
			question.append(el('p', `${words[confirming]} now?`, 'system-confirm-question'),
				button('Cancel', 'system-action', () => { confirming = ''; paintPanel(true); }),
				button(words[confirming], 'system-action system-danger', () => { const what = confirming; confirming = ''; act({ do: what }, words[what].toLowerCase()); }));
			node.append(question); return node;
		}
		const choices = el('div', null, 'system-power-choices');
		choices.append(button('Lock Screen', 'system-action', () => act({ do: 'lock' }, 'lock')),
			button('Sleep', 'system-action', () => { confirming = 'suspend'; paintPanel(true); }),
			button('Restart…', 'system-action', () => { confirming = 'reboot'; paintPanel(true); }),
			button('Shut Down…', 'system-action', () => { confirming = 'poweroff'; paintPanel(true); }));
		node.append(choices); return node;
	}

	function paintPanel(force = false) {
		if (!open || !state) return;
		// Not under a hand: a slider being dragged, a password being typed.
		const active = document.activeElement;
		if (!force && (pressing || (panel.contains(active) && active.matches('input, select')))) {
			// Scanning can finish while a password is being typed. Update just
			// the scan chrome, never replace the field or retain its contents.
			panel.querySelector('.system-scanning')?.replaceWith(scanStatus());
			panel.querySelector('.system-wifi .system-list')?.setAttribute('aria-busy', String(scanning));
			const refresh = panel.querySelector('.system-refresh');
			if (refresh) refresh.disabled = scanning || Boolean(busy) || !state.wifi?.enabled || !state.wifi.hardware;
			return;
		}
		const hadFocus = panel.contains(active);
		const focused = hadFocus ? active.dataset.systemFocus : null;
		const parts = [];
		if (!powerOnly && state.wifi) parts.push(wifiSection(state.wifi));
		if (!powerOnly && state.bluetooth) parts.push(bluetoothSection(state.bluetooth));
		if (!powerOnly && state.sound) parts.push(soundSection(state.sound));
		if (!powerOnly && state.brightness) {
			const node = section('screen');
			const sun = el('span', null, 'system-control-glyph'); sun.append(controlIcon('sun'));
			node.append(row(sun, ...slider(state.brightness.percent, 'Screen brightness', percent => act({ do: 'brightness', percent }, 'brightness'), 1)));
			parts.push(node);
		}
		if (!powerOnly && state.battery) {
			const node = section('battery');
			const glyph = el('span', null, 'system-control-glyph'); glyph.append(batteryIcon(state.battery.percent, state.battery.plugged));
			const text = batteryText(state.battery).replace('charging', 'Charging').replace('plugged in', 'Plugged in');
			node.append(row(glyph, el('span', text, `system-battery-detail system-note${state.battery.low ? ' low' : ''}`)));
			parts.push(node);
		}
		if (state.power) parts.push(powerSection());
		const line = el('p', busy ? `${busy}…` : error, `system-line${error && !busy ? ' error' : ''}`);
		line.hidden = !busy && !error;
		line.setAttribute('aria-live', 'polite');
		parts.push(line);
		panel.replaceChildren(...parts);
		if (focused) focusWifi(focused);
		// Repainting an unkeyed action (for example a power confirmation)
		// must not drop Escape into the conversation or the document body.
		if (hadFocus && document.activeElement === document.body) panel.focus({ preventScroll: true });
		place();
	}
	function place() {
		if (open && !presenter) hang(panel, { anchor, band });
	}
	function show(keyboard = false) {
		if (refused || !applies(state)) return;
		powerOnly = false;
		open = true; error = ''; confirming = ''; asking = ''; networkOptions = ''; forgetNetwork = ''; deviceOptions = '';
		panel.hidden = false;
		status.setAttribute('aria-expanded', 'true');
		paintPanel(true);
		presenter?.show();
		if (keyboard) (panel.querySelector('.system-switch:not(:disabled)') || panel.querySelector('button:not(:disabled)'))?.focus({ preventScroll: true });
		ask(true).then(scanWifi);
		schedule();
	}
	function close() {
		if (!open) return;
		open = false; pressing = false; asking = ''; confirming = ''; networkOptions = ''; forgetNetwork = ''; deviceOptions = '';
		panel.hidden = true;
		panel.replaceChildren();
		status.setAttribute('aria-expanded', 'false');
		presenter?.close();
		schedule();
	}
	panel.addEventListener('pointerdown', () => { pressing = true; });
	addEventListener('pointerup', () => { pressing = false; }, true);
	addEventListener('pointercancel', () => { pressing = false; }, true);
	anchor.addEventListener('click', event => {
		if (status.hidden) return;
		const showing = open && (!presenter?.isShowing || presenter.isShowing());
		showing ? close() : show(event.detail === 0);
	});
	addEventListener('pointerdown', event => { if (open && !presenter && !panel.contains(event.target) && !anchor.contains(event.target)) close(); }, true);
	// Escape steps back: out of a password or a question, then the panel shut.
	addEventListener('keydown', event => {
		if (!open || event.key !== 'Escape') return;
		// A docked panel is not a modal: conversation keys stay there.
		if (presenter && !panel.contains(event.target) && !anchor.contains(event.target)) return;
		event.stopPropagation(); event.preventDefault();
		if (deviceOptions && !asking && !confirming && !networkOptions) { const key = `device:${deviceOptions}`; deviceOptions = ''; paintPanel(true); focusWifi(key); return; }
		if (asking || confirming || networkOptions) {
			const key = asking ? `network:${asking}` : `options:${networkOptions}`;
			if (forgetNetwork) forgetNetwork = '';
			else { asking = ''; confirming = ''; networkOptions = ''; }
			paintPanel(true); focusWifi(key); return;
		}
		close();
		if (!status.hidden) status.focus({ preventScroll: true });
	}, true);
	addEventListener('resize', place);
	document.addEventListener('visibilitychange', () => { if (document.hidden || refused) clearTimeout(timer); else ask().then(schedule); });

	ask(false).then(schedule);
	// imperfect OS's screen lock (preload.cjs onLock): the moment it goes, Wi-Fi and battery are asked for again.
	let wasLocked = false;
	globalThis.imperfectDesk?.onLock?.(lock => {
		if (wasLocked && !lock && !refused) ask().then(schedule);
		wasLocked = Boolean(lock);
	});
	return { status, panel, setPresenter, refresh: () => ask(), isOpen: () => open, close,
		showPower: () => {
			if (refused || !applies(state)) return;
			powerOnly = true; open = true; error = ''; confirming = ''; asking = ''; networkOptions = ''; forgetNetwork = ''; deviceOptions = '';
			panel.hidden = false; status.setAttribute('aria-expanded', 'true');
			paintPanel(true); presenter?.show(); panel.focus({ preventScroll: true });
			ask(true).then(() => paintPanel(true)); schedule();
		},
	};
}
