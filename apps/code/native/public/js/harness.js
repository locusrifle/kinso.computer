// The conversation, drawn into imperfect's terminal.
//
// site.js owns the sheets (the keys, the themes) and the phone keyboard.
// This file owns what is inside the screen, and it talks to a Pi SDK session
// over persistent owner-scoped websockets relayed by this origin,
// commands back. Nothing here reimplements Pi; it renders what Pi reports.
//
// Everything is built as nodes, never innerHTML: tool output is whatever the
// agent read off the disk, and it lands in this document.

import { createSessionCache, joinSnapshot } from './session-cache.js';
import { createOwnerTransport, ownerSessionKey } from './owner-transport.js';
import { createFreshness } from './freshness.js';
import { mountLoadingBar, mountConnectionLine } from './loading.js';
import { mountAuth } from './auth.js';
import { mountSettings } from './settings.js';
import { createNotifications } from './notify.js';
import { renderGuiTranscript, turnTime, turnTimeNode, compactionNode, formatWorking } from './gui-transcript.js';
import { animateInView } from './visible-animation.js';
import { mountWorkbench, defaultFilesBase } from './workbench-view.js';
import { postUpload, useUpload, uploadPercent, MAX_UPLOAD_BYTES } from './uploads.js';
import { mountVoice, isVoiceFile } from './voice.js';
import { mountUsage } from './usage.js';
import { usageOwner } from './usage-owner.js';
import { permissionFor, harnessMark, sessionMark, harnessName, harnessLabel, modelText, modelLabel } from './agent-faces.js';
import { newestOfEachLine } from './model-lines.js';
import { clipboardHasText, filesFromClipboardData, filesFromClipboardItems } from './clipboard-files.js';
import { containChoosing } from './choose-text.js';
import { registerKeyBinding, MOD } from './pi-card.js';
import { transcriptScroll } from './transcript-scroll.js';
import { liveMessage } from './live-message.js';
import { mountPages, windowNode, setFileBase } from './pages.js';
import { mountWindows, phone } from './windows.js';
import { LAYOUT_CHOICE } from './layout-choice.js';
import { mountSystem } from './system.js';
import { mountClipboardHistory } from './clipboard-history.js';
import { mountScreenshotPreview } from './screenshot-preview.js';
import { turn, still, OPEN, OPENING } from './turn.js';
import { framedByLaunch, phoneByLaunch } from './arrival.js';
import { mountLaunchOpen } from './launch-open.js';
import { mountAssembly, ASSEMBLY_STEPS } from './assembly.js';
import { mountMessages } from './messages.js';
import { brand, brandMark, applyBrand } from './brand.js';
import { mountSharks } from './kinso-sharks.js';

const el = (tag, text, className) => {
	const node = document.createElement(tag);
	if (text != null) node.textContent = text;
	if (className) node.className = className;
	return node;
};

// A picture in the conversation is an address on its machine (/media/<hash>,
// see server.mjs); only a picture still being composed carries its bytes.
function imageSrc(block) {
	if (typeof block?.url === 'string') return block.url;
	const mime = String(block?.mimeType ?? '');
	if (!/^image\/[a-z0-9.+-]+$/i.test(mime) || typeof block.data !== 'string' || !block.data) return null;
	return `data:${mime};base64,${block.data}`;
}

function imageNode(block, alt, at = src => src) {
	const src = imageSrc(block);
	if (!src) return null;
	const img = document.createElement('img');
	img.className = 'entry-image';
	img.alt = alt;
	img.src = at(src);
	return img;
}

// How long ago, in as few characters as a rail column has room for.
function whenLabel(ms) {
	const at = Number(ms);
	if (!Number.isFinite(at) || at <= 0) return '';
	const secs = Math.max(0, (Date.now() - at) / 1000);
	if (secs < 90) return 'now';
	if (secs < 3600) return `${Math.round(secs / 60)}m`;
	if (secs < 86400) return `${Math.round(secs / 3600)}h`;
	if (secs < 7 * 86400) return `${Math.round(secs / 86400)}d`;
	return new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

// Queue images are already API image blocks: retain their bytes and MIME type.
export function restoreQueueItem(draft, item) {
	const attachments = [...draft.attachments, ...(item.images ?? []).map(image => ({ name: 'recovered image', image }))];
	const text = item.text;
	const prefix = text + (text && draft.text ? '\n\n' : '');
	return { ...draft, text: prefix + draft.text, attachments, start: (draft.start ?? 0) + prefix.length, end: (draft.end ?? 0) + prefix.length };
}

// The page's own elements (index.html) are found by id.
export function mountGueyPi({ hooks = {} } = {}) {
	const byId = id => document.getElementById(id);
	// Whose window: imperfect's, or a company's version of it (brand.js).
	applyBrand();
	const output = byId('entry-output'), input = byId('entry-input'), dialog = byId('entry-dialog');
	const modelStatus = byId('entry-model-status'), modelName = byId('entry-pi-label'), thinking = byId('entry-thinking');
	const modelCaption = document.createElement('span');
	modelCaption.className = 'entry-model-name';
	// The harness, in words: the mark beside the model is the brand's now, so
	// which harness (and so whose subscription) is said here.
	const harnessCaption = document.createElement('span');
	harnessCaption.className = 'entry-harness-name';
	modelName.replaceChildren(brandMark(), modelCaption, document.createTextNode(' '), harnessCaption);
	let socket = null, state = null;
	let usageView = null;
	// Messages (messages.js) and its window, once made.
	let messages = null, messagesWin = null;
	let firstSnapshot;
	const snapshotReady = new Promise(resolve => { firstSnapshot = resolve; });
	// Speaking a prompt is sending it: the recording goes to the computer
	// owning the session, which hears it and sends the words (dictate,
	// below). An attached recording's words come to the composer.
	const voice = mountVoice({ input, fail: error => fail(error), captureTarget: captureDictationTarget, uploadTarget: captureUploadTarget, send: (recording, target, signal) => dictate(recording, target, signal) });
	let caretMirror = null;
	// The serving connection is usable even before inventory arrives. Its internal
	// key never names a remote destination; remote keys are verified stable IDs.
	const LOCAL = '@serving';
	let selectedOwner = LOCAL, switching = false, selectionGeneration = 0;
	const transports = new Map();
	let foregroundRequests = 0, attachmentProcessing = 0;
	const ownerKey = owner => owner === LOCAL ? (hereOwner() || LOCAL) : owner;
	// The computer the conversation's session runs on, as its addresses go: ''
	// for this one, else through /peer/. What it shows plays from there.
	const ownerBase = (owner = selectedOwner) => (owner === LOCAL || ownerKey(owner) === hereOwner() ? '' : `/peer/${encodeURIComponent(ownerKey(owner))}`);
	// What agents showed, playing in the conversation. A window is made once
	// and kept, so a game or a video plays on while the turn around it is
	// redrawn: one already on screen is drawn as a stand-in (data-window-key)
	// that renderTranscript swaps back for it without moving it.
	const windows = new Map();
	function windowFor(spec, key) {
		const kept = windows.get(key);
		if (kept?.isConnected) { const stand = el('div'); stand.dataset.windowKey = key; return stand; }
		if (kept) return kept;
		const made = windowNode(spec, { base: ownerBase() });
		made.dataset.windowKey = key;
		windows.set(key, made);
		while (windows.size > 40) windows.delete(windows.keys().next().value);
		return made;
	}
	const keptWindow = node => (node.dataset?.windowKey && !node.classList.contains('gui-window') ? windows.get(node.dataset.windowKey) ?? node : node);
	function ownerCommand(owner, type, fields = {}, options = {}) {
		if (owner === selectedOwner && disconnectedOwners.has(owner) && !switching && !['hello', 'snapshot', 'tab-focus'].includes(type)) return Promise.reject(new Error('Execution selection unavailable; choose a session first'));
		const transport = transports.get(owner);
		if (!transport) return Promise.reject(new Error('Execution owner unavailable'));
		// An older page of the conversation is reading, not a request: it never holds up a switch.
		const foreground = !['hello', 'here', 'prompt', 'queue-take', 'messages-before'].includes(type);
		if (foreground) foregroundRequests++;
		return transport.command(type, fields, options).finally(() => { if (foreground) foregroundRequests--; });
	}
	const SURFACE_VIEW_KEY = 'imperfect.surface-code-view';
	let restoredView = null;
	let restoreFocusAsked = false;
	try {
		restoredView = JSON.parse(sessionStorage.getItem(SURFACE_VIEW_KEY) || 'null');
		sessionStorage.removeItem(SURFACE_VIEW_KEY);
	} catch { restoredView = null; }
	let overlay = null;          // a picker we are showing in #entry-dialog
	// A tab that exists on screen before it exists on the machine: a fresh
	// session, asked what is wanted; its chosen computer makes it when used.
	const launchFramed = framedByLaunch(), launchPhone = phoneByLaunch();
	let assemblyStep = launchFramed ? 'bare' : null;
	let choosing = launchFramed ? { owner: LOCAL, auto: false, agent: null, model: null, error: '', launch: true } : null;
	if (launchFramed) {
		restoredView = null;
		document.documentElement.classList.add(launchPhone ? 'launch-phone' : 'launch-framed');
		document.documentElement.dataset.assemblyStep = 'bare';
	}
	// Sessions this screen has already seen, by machine; see followNewSession.
	const knownSessions = new Set(), heardOwners = new Set();
	const queueBox = byId('entry-queue'), flash = byId('entry-flash');
	let flashTimer = 0;
	const showFlash = text => {
		const value = String(text ?? '').trim();
		flash.hidden = !value;
		flash.textContent = value;
		clearTimeout(flashTimer);
		if (value) flashTimer = setTimeout(() => showFlash(''), 2500);
	};

	/* ------------------------------------------------------------- transport */
	function command(type, fields = {}) {
		if (switching) return Promise.reject(new Error('Owner selection in progress; try again when ready'));
		if (disconnectedOwners.has(selectedOwner)) return Promise.reject(new Error('Choose a session on the reconnected owner first'));
		return ownerCommand(selectedOwner, type, fields);
	}
	// Capture before any await: a later picker/response must never use the
	// computer or session that happens to be on screen when it finishes.
	function sessionCommand() {
		const owner = selectedOwner, available = !switching && !disconnectedOwners.has(owner);
		const identity = { expectedSessionId: state?.sessionId, expectedTabId: focusedTabId() };
		return (type, fields = {}) => available ? ownerCommand(owner, type, { ...fields, ...identity }) : Promise.reject(new Error('Execution selection unavailable; choose a session first'));
	}

	const kind = () => (phone() ? 'phone' : 'desktop');
	const helloFields = () => ({
		kind: launchPhone ? 'viewer' : kind(), machine: hereOwner(),
		width: innerWidth, height: innerHeight, dpr: devicePixelRatio || 1,
		visible: !launchPhone && document.visibilityState === 'visible',
	});
	function hello() { ownerCommand(LOCAL, 'hello', helloFields()).catch(() => {}); }
	const disconnectedOwners = new Set();
	const AudioCtx = window.AudioContext || window.webkitAudioContext;
	let doneAudio = null;
	function unlockDoneSound() {
		if (!AudioCtx) return;
		try {
			if (!doneAudio) doneAudio = new AudioCtx();
			if (doneAudio.state === 'suspended') void doneAudio.resume().catch(() => {});
		} catch {}
	}
	function playTone(kind) {
		const counter = kind === 'blocked' ? '__gueyBlockedSounds' : '__gueyDoneSounds';
		window[counter] = (window[counter] || 0) + 1; // browser tests read this
		try {
			unlockDoneSound();
			if (!doneAudio || doneAudio.state === 'suspended') return;
			const osc = doneAudio.createOscillator();
			const gain = doneAudio.createGain();
			const now = doneAudio.currentTime;
			osc.type = kind === 'blocked' ? 'triangle' : 'sine';
			osc.frequency.value = kind === 'blocked' ? 440 : 880;
			gain.gain.setValueAtTime(0.05, now);
			gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);
			osc.connect(gain);
			gain.connect(doneAudio.destination);
			osc.start(now);
			osc.stop(now + 0.2);
		} catch {}
	}
	function playDoneSound() { playTone('done'); }
	function playBlockedSound() { playTone('blocked'); }
	function focusedTabId() {
		return (state?.tabs ?? []).find(tab => tab.focused)?.id ?? null;
	}
	const guiSnapshot = () => ({ sessionId: state?.sessionId ?? null, owner: ownerKey(selectedOwner), tabs: state?.tabs ?? [], messages: state?.messages ?? [] });
	function pingDone() {
		const looking = document.visibilityState === 'visible';
		// Phone and desktop both hear the finish while looking. A new AudioContext
		// at settle time is suspended, so we keep one unlocked on input. OS banners
		// only when the page is hidden — looking already has the tone.
		playDoneSound();
		if (looking) return;
		if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
			try { new Notification(brand.name, { body: 'done', silent: false }); } catch {}
		}
	}
	function pingBlocked() { playBlockedSound(); }
	let previousTabStates = null, refreshing = null, returning = null;
	const localSessions = createSessionCache();
	const localDesktop = () => kind() === 'desktop' && ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(location.hostname);
	const eagerLocal = () => localDesktop() && selectedOwner === LOCAL && !disconnectedOwners.has(LOCAL);
	function cacheLocal(data, id = data?.tabs?.find(tab => tab.focused)?.id) {
		const cached = localSessions.accept(id, data);
		if (cached) {
			localSessions.prune(cached.tabs ?? []);
			if (localDesktop()) prepareTranscript(cached);
		}
		return cached;
	}
	// Views seen before, of any computer, kept as they were last seen: going
	// back to one shows it at once, marked stale, while the current one comes.
	const seenViews = createSessionCache(16);
	// Whether the view on screen is current (freshness.js), the one bar that
	// says something is loading, and the line that says which computer when
	// it is taking a while.
	const loadingBar = mountLoadingBar(document.body);
	const connectionLine = mountConnectionLine(byId('entry-input-zone'), { onRetry: () => freshness.retry() });
	let staleHold = null;
	const freshness = createFreshness({ onChange: paintFreshness });
	function paintFreshness(info = freshness.state) {
		const stale = info.phase !== 'fresh';
		output.classList.toggle('entry-stale', stale);
		output.dataset.fresh = info.phase;
		if (stale && !staleHold) staleHold = loadingBar.begin();
		if (!stale && staleHold) { staleHold(); staleHold = null; }
		connectionLine.paint({ ...info, name: stale ? machineName(info.owner) : '' });
	}
	const machineName = owner => (owner === LOCAL || owner === hereOwner() ? machineRows.find(m => m.self)?.name : machineRows.find(m => m.id === owner)?.name) || (owner === LOCAL ? 'this computer' : owner);
	// While the view of `owner` is stale: its socket is asked whether it is
	// alive, and replaced if it is not. An answer to a question sent after the
	// doubt began means all the socket carried before it has been drawn. A
	// hidden window waits to be looked at, as its socket does (below).
	async function refreshView(owner) {
		if (document.hidden && !state?.busy) return;
		if (owner !== LOCAL) await refreshMachines();
		const transport = ensureTransport(owner);
		const alive = await transport.check({ fields: owner === LOCAL ? helloFields() : { kind: phone() ? 'phone' : 'viewer', machine: hereOwner(), visible: !launchPhone } });
		// One that did not answer is replaced straight away.
		if (!alive && !transport.socket) transport.connect();
		if (!alive || owner !== selectedOwner || switching) return;
		// Back, but not yet on the session that was on screen: its view is
		// asked for again, which goes back to that session (receiveOwner).
		if (disconnectedOwners.has(owner)) {
			if (!returning) receiveOwner(owner, { type: 'snapshot', data: await ownerCommand(owner, 'snapshot', {}, { timeoutMs: 5000 }) });
			return;
		}
		freshness.fresh(alive.at, owner, viewKey());
	}
	const viewKey = () => ownerSessionKey(ownerKey(selectedOwner), focusedTabId());
	// The last resort, for a view that would not come back however often it was
	// tried while its computer answers plainly over HTTP: the page's sockets
	// are what is stuck, and loading it again is what killing the app did.
	// Never with anything in hand a reload would lose, never while hidden, and
	// at most once in a few minutes.
	const SELF_RELOAD_KEY = 'imperfect.self-reload';
	async function reloadIfStuck(owner) {
		if (document.hidden || !reloadSafe()) return false;
		try { if (Date.now() - Number(sessionStorage.getItem(SELF_RELOAD_KEY) || 0) < 3 * 60_000) return false; } catch { return false; }
		const answers = await fetch(`${ownerBase(owner)}/health`, { cache: 'no-store', signal: AbortSignal.timeout(3000) }).then(res => res.ok, () => false);
		if (!answers || document.hidden || !reloadSafe()) return false;
		try { sessionStorage.setItem(SELF_RELOAD_KEY, String(Date.now())); } catch {}
		prepareReload();
		location.reload();
		return true;
	}
	function doubtOwner(owner, { restart = false } = {}) {
		freshness.stale({ owner, attempt: () => refreshView(owner), reload: () => reloadIfStuck(owner), restart });
	}
	function connect() { doubtOwner(LOCAL); ensureTransport(LOCAL).connect(); }
	function ensureTransport(owner) {
		if (transports.has(owner)) return transports.get(owner);
		let drops = 0;
		const transport = createOwnerTransport({ owner, selfId: LOCAL, base: location.href,
			onStatus: (_, status) => {
				if (owner === selectedOwner) socket = transport.socket;
				if (status === 'open') {
					drops = 0;
					if (owner === LOCAL) hello();
					else ownerCommand(owner, 'hello', { kind: phone() ? 'phone' : 'viewer', machine: hereOwner(), visible: !launchPhone }).catch(() => {});
					// Used a moment ago and only now connected, as a phone is when it wakes.
					if (Date.now() - usedAt < 10_000) tellHere(owner);
				} else {
					disconnectedOwners.add(owner);
					if (owner === LOCAL) localSessions.clear();
					// What is on screen is no longer kept current: it says so,
					// and is brought back (refreshView), with backoff, however long that takes.
					if (owner === selectedOwner && !switching) doubtOwner(owner);
					// Another computer's: the first try comes straight back; only
					// repeated failure waits. A hidden page (a phone with its screen off)
					// does not try at all until it is looked at, unless an agent is
					// working and its finish is owed.
					else if (!document.hidden || state?.busy) setTimeout(() => {
						if (owner === LOCAL || machineRows.some(m => m.id === owner && m.reachable)) transport.connect();
					}, drops++ ? 1500 : 200);
				}
				paintSessionRail();
			},
			onMessage: (_, message) => receiveOwner(owner, message),
		});
		transports.set(owner, transport);
		return transport;
	}
	function receiveOwner(owner, message) {
		// This companion is a passive chooser, never the person's browser target,
		// notification/screenshot surface or a second set of agent-opened panes.
		if (launchPhone && !['snapshot', 'tab-snapshot', 'look'].includes(message.type)) return;
		if (owner === LOCAL && localDesktop() && ['snapshot', 'tab-snapshot'].includes(message.type)) {
			const cached = cacheLocal(message.data, message.tabId);
			if (cached) message = { ...message, data: cached };
		}
		if (['snapshot', 'tab-snapshot'].includes(message.type)) migrateDraftIdentities(owner, message.data);
		if (message.type === 'tab-snapshot') return;
		if (message.type === 'look' && owner !== LOCAL) return;
		// The agent may present its browser, never choose the person's pane.
		// Explicit navigation/swiping reveals it on desktop and phone alike.
		if (message.type === 'browse') {
			pages.watch(message.machine ? ownerBase(String(message.machine)) : ownerBase(owner), { quiet: true });
			return;
		}
		// What an agent opened, from any session on any computer, opens in the
		// one Workbench or as a tab in the one browser, taking nobody's eyes.
		if (message.type === 'power-menu') {
			if (owner === LOCAL && (window.imperfectDesk?.isFocused?.() ?? document.hasFocus())) systemControls.showPower();
			return;
		}
		// Taking a screenshot saves and copies it; only paste or an explicit
		// attachment action may put it in a conversation.
		if (message.type === 'screenshot') {
			if (owner === LOCAL) shotPreview.show(String(message.name));
			return;
		}
		if (message.type === 'notify') { notifications.received(message, owner); return; }
		// An agent drafted a reply in Messages, from a session on any computer.
		if (message.type === 'inbox-draft') { messages?.drafted(message); return; }
		if (message.type === 'inbox-changed') { messages?.changed(); return; }
		if (message.type === 'shown') {
			if (message.kind === 'folder' || (message.kind === 'page' && message.target.startsWith('/'))) openFiles(message.target, { quiet: true, base: ownerBase(owner) });
			else pages.shown(message.target, ownerBase(owner));
			return;
		}
		if (owner !== selectedOwner && message.type !== 'look') {
			if (message.type === 'snapshot') {
				// a sign-in begun there from the new-session question goes on showing here
				ownerAuth.get(owner)?.render(message.data?.auth);
				paintSessionRail(); followNewSession();
				if (choosing?.owner === owner && !creating) render();
			}
			return;
		}

		// A settle is a tab event, not a view event: even the tab already on screen
		// needs the same finish signal as one being watched elsewhere. A turn
		// Claude began itself (a background task reporting back) is quiet.
		if (message.type === 'turn' && message.asked !== false) pingDone();
		if (message.type === 'look') {
			dispatchEvent(new CustomEvent('imperfect-look', { detail: message.data }));
		}
		if (message.type === 'snapshot') {
			if (switching) return;
			let data = message.data;
			// Back after a drop, and the owner offers its own focus, not this
			// window's. The window was on a session: if that session is still
			// there it goes straight back to it, and only asks when it is gone.
			if (!choosing?.launch && disconnectedOwners.has(owner) && state && state.sessionId !== data?.sessionId) {
				const wanted = focusedTabId();
				if (wanted && !returning && (data?.tabs ?? []).some(tab => tab.id === wanted)) {
					returning = ownerCommand(owner, 'tab-focus', { tabId: wanted, snapshot: true })
						.then(focused => { disconnectedOwners.delete(owner); if (focused?.snapshot) receiveOwner(owner, { type: 'snapshot', data: focused.snapshot }); })
						.catch(() => { showFlash('Owner reconnected with another selection; choose a session to resume'); paintSessionRail(); })
						.finally(() => { returning = null; });
					return;
				}
				if (returning) return;
				// The session that was on screen has gone from it while away: what
				// is open there now is shown, rather than a view that cannot come back.
				if (wanted) showFlash('That session was closed while away');
			}
			disconnectedOwners.delete(owner);
			// An update carries only what was added since the session was last
			// sent (server.mjs). If that is not what this window holds -- a
			// dropped update, a session change -- the whole is asked for once.
			// A whole one keeps the older pages already fetched before it.
			if (Array.isArray(data?.messagesTail) || Array.isArray(data?.messages)) {
				const joined = joinSnapshot(state, data);
				if (!joined) {
					if (!refreshing) refreshing = ownerCommand(owner, 'snapshot').then(whole => receiveOwner(owner, { type: 'snapshot', data: whole })).catch(() => {}).finally(() => { refreshing = null; });
					return;
				}
				data = joined;
			}
			const nextTabs = data?.tabs ?? [];
			if ((!restoredView?.owner || restoredView.owner === ownerKey(selectedOwner)) && restoredView?.tabId && !restoreFocusAsked && nextTabs.some(tab => tab.id === restoredView.tabId)
				&& !nextTabs.some(tab => tab.id === restoredView.tabId && tab.focused)) {
				restoreFocusAsked = true;
				command('tab-focus', { tabId: restoredView.tabId, snapshot: true })
					.then(focused => { if (focused?.snapshot) receiveOwner(owner, { type: 'snapshot', data: focused.snapshot }); })
					.catch(() => { restoredView = null; });
			}
			if (previousTabStates) {
				for (const tab of nextTabs) {
					if (tab.status === 'blocked' && previousTabStates.get(tab.id) !== 'blocked') pingBlocked();
				}
			}
			previousTabStates = new Map(nextTabs.map(tab => [tab.id, tab.status]));
			const oldKey = editorKey(state), nextKey = editorKey({ ...data, executionOwner: ownerKey(owner) });
			// A model change that opened another tab takes the typed words with it (pickModel).
			const carry = carriedDraft?.from === oldKey && carriedDraft.generation === selectionGeneration ? carriedDraft : null;
			let carried = null;
			if (carry && oldKey !== nextKey) {
				carried = captureQueueDraft(); queueDrafts.delete(oldKey);
				try { localStorage.removeItem(draftKey(oldKey)); } catch {}
			}
			if (carried || carry?.answered) carriedDraft = null;
			if (oldKey && oldKey !== nextKey) { if (!carried) queueDrafts.set(oldKey, heldDraft(oldKey)); suspendDialog(); }
			state = { ...data, executionOwner: ownerKey(owner) };
			firstSnapshot();
			// A fresh session open keeps its own composer whatever the computer
			// moves the view behind it to.
			if (!oldKey && !choosing) {
				const saved = storedDraft(nextKey);
				if (saved.text) displayQueueDraft(saved);
				else if (owner === LOCAL) saveDraft();
			}
			if (oldKey && oldKey !== nextKey && !choosing) displayQueueDraft(carried ?? queueDrafts.get(nextKey) ?? storedDraft(nextKey));
			render();
			seenViews.keep(viewKey(), state);
			// Arrived on a socket opened since the view was doubted: current.
			freshness.fresh(transports.get(owner)?.openedAt ?? 0, owner, viewKey());
			// Closing the last tab leaves nothing to read, so the console asks
			// which harness to start rather than showing an empty screen. Same
			// page the rail's + opens; it is just not optional here.
			followNewSession();
			if (!nextTabs.length && !choosing && !creating) void beginNewAgent({ auto: true });
		}
	}
	// `retry`, for a switch that is only a look (a tab, a session from the
	// list): a computer that could not be reached is tried again, with
	// backoff, until it answers or something else is asked for (freshness.js).
	const unreachable = error => Boolean(error?.acceptanceUnknown || error?.unreachable || /not connected/i.test(error?.message ?? ''));
	let sessionTurn = null;
	async function selectOwner(owner, action, requestedTab = null, { retry = null } = {}) {
		const key = owner === hereOwner() ? LOCAL : owner;
		if (switching) throw new Error('Owner selection already in progress');
		if (key !== LOCAL && !machineRows.some(m => m.id === key && m.reachable)) throw new Error('Execution owner is offline; session remains there');
		const transport = ensureTransport(key);
		switching = true;
		suspendDialog();
		const generation = ++selectionGeneration;
		let actionStarted = false, committed = false;
		// Until it comes, what is on screen is not what was asked for.
		freshness.stale({ owner: key, want: requestedTab, attempt: retry && (() => (switching ? null : retry())) });
		try {
			transport.connect();
			const deadline = Date.now() + 6000;
			while (!transport.snapshot || transport.socket?.readyState !== WebSocket.OPEN) {
				if (Date.now() > deadline) throw Object.assign(new Error('Execution owner unavailable; previous view retained'), { unreachable: true });
				await new Promise(resolve => setTimeout(resolve, 40));
			}
			actionStarted = Boolean(action);
			const result = action ? await action((type, fields) => ownerCommand(key, type, fields), {
				owner: ownerKey(key), connected: transport.socket?.readyState === WebSocket.OPEN,
			}) : null;
			const fresh = result?.snapshot ?? await ownerCommand(key, 'snapshot');
			if (!fresh?.tabs || transport.socket?.readyState !== WebSocket.OPEN) throw Object.assign(new Error('Owner snapshot unavailable; previous view retained'), { unreachable: true });
			const snapshot = key === LOCAL && localDesktop() ? (cacheLocal(fresh) ?? fresh) : fresh;
			if (requestedTab && wantedTab && wantedTab !== requestedTab) { committed = true; return; }
			if (generation !== selectionGeneration) return;
			migrateDraftIdentities(key, snapshot);
			const oldKey = editorKey(state);
			if (oldKey) queueDrafts.set(oldKey, heldDraft(oldKey));
			const held = state?.executionOwner === ownerKey(key) ? state : null;
			const moved = key !== selectedOwner;
			const changed = moved || state?.sessionId !== snapshot.sessionId || state?.tabId !== snapshot.tabId;
			// A fresh session made on the computer keeps what was typed in it.
			const made = keepComposer && Boolean(choosing);
			const display = () => {
				selectedOwner = key; socket = transport.socket; disconnectedOwners.delete(key);
				state = { ...(joinSnapshot(held, snapshot) ?? snapshot), executionOwner: ownerKey(key) };
				firstSnapshot();
				previousTabStates = null; overlay = null; choosing = null;
				if (made) {
					freshText = ''; saveDraft();
					try { localStorage.removeItem(FRESH_DRAFT); } catch { /* storage denied */ }
					if (firstPrompt && !firstPrompt.key) firstPrompt.key = editorKey(state);
				} else displayQueueDraft(queueDrafts.get(editorKey(state)) ?? storedDraft(editorKey(state)));
				committed = true;
				render();
			};
			// The fresh session becoming a real one is not a turn to another.
			if (changed && !made) {
				sessionTurn?.skipTransition();
				const turned = sessionTurn = turn('session-turn', display, 'session-panel', output.closest('.entry-screen'));
				if (turned) {
					turned.finished.catch(() => {}).finally(() => { if (sessionTurn === turned) sessionTurn = null; });
					await turned.updateCallbackDone;
				}
			} else display();
			if (moved) followFiles();
			seenViews.keep(viewKey(), state);
			// What is on screen now is this, current: a doubt about any other is moot.
			if (!freshness.fresh(Date.now(), key, viewKey()) && freshness.state.owner !== key) freshness.forget(freshness.state.owner);
		} catch (error) {
			// Focus may have succeeded before a lost acknowledgement/read. Do not
			// let an unguarded command use the old displayed session in that case.
			if (actionStarted && key === selectedOwner) disconnectedOwners.add(key);
			// Refused, not unreachable: it is said (fail), and asking again would not help.
			if (!(retry && unreachable(error))) freshness.forget(key);
			throw error;
		} finally {
			switching = false;
			if (committed) render();
			if (!committed && !disconnectedOwners.has(selectedOwner)) {
				const previous = transports.get(selectedOwner)?.snapshot;
				if (previous && (!state || previous.sessionId === state.sessionId)) receiveOwner(selectedOwner, { type: 'snapshot', data: previous });
			}
		}
	}

	// The model picker lives inside imperfect, which may be closed when the sign-in dialog
	// closes: pressing "Choose a default model" opened a list nobody could see. Open imperfect first.
	const ownerAuth = new Map();
	function currentAuth(owner = selectedOwner) {
		if (!ownerAuth.has(owner)) ownerAuth.set(owner, mountAuth({ autoWelcome: !launchFramed, command: (type, fields) => ownerCommand(owner, type, fields),
			chooseModel: () => { if ((choosing?.owner ?? selectedOwner) === owner) chooseModel().catch(fail); } }));
		return ownerAuth.get(owner);
	}

	const fail = error => {
		const text = error.message ?? String(error);
		showFlash(text);
		modelStatus.textContent = text;
	};

	const terminal = byId('entry-terminal');
	// The agents: a column of the terminal, so it travels with the terminal.
	const sessionRail = el('aside', null, 'session-rail');
	sessionRail.id = 'session-rail';
	sessionRail.setAttribute('aria-label', 'agents');
	terminal.prepend(sessionRail);
	// Local desktop conversations are kept ready; phones and peers wait for
	// the selected conversation. Focus is still confirmed before commands can
	// run, and another tap supersedes an acknowledgement still in flight.
	let wantedTab = null, tabSwitchActive = false;
	// Elsewhere, a session seen before is shown as it was last seen, marked
	// stale until the current one arrives, rather than leaving the last one up
	// unmarked; on the same computer only, whose pictures and windows it can
	// reach.
	function showCachedTab(tabId, owner) {
		if (!tabSwitchActive || !switching || owner !== ownerKey(selectedOwner)) return false;
		const tab = state?.tabs?.find(tab => tab.id === tabId);
		const warm = tab && eagerLocal() && owner === ownerKey(LOCAL) && localSessions.get(tabId, tab.sessionId);
		const cached = warm || (tab && seenViews.get(ownerSessionKey(owner, tabId), tab.sessionId));
		if (!cached) return false;
		const oldKey = editorKey(state);
		if (oldKey) queueDrafts.set(oldKey, heldDraft(oldKey));
		// A question it was asking then is not asked again until it is current.
		state = { ...cached, ui: { ...cached.ui, dialogs: [] }, tabs: state.tabs.map(tab => ({ ...tab, focused: tab.id === tabId })), executionOwner: owner };
		choosing = null;
		displayQueueDraft(queueDrafts.get(editorKey(state)) ?? storedDraft(editorKey(state)));
		output.classList.remove('entry-switching');
		render();
		const screen = output.closest('.entry-screen');
		if (screen && !still()) {
			screen.getAnimations().forEach(animation => animation.cancel());
			screen.animate(OPEN, OPENING);
		}
		return true;
	}
	// `again`: tried again by itself (freshness.js), which leaves the reader's
	// place alone until it has something to show.
	function enterTab(tabId, owner = ownerKey(selectedOwner), { again = false } = {}) {
		// A first prompt is binding its destination. Do not let a cached
		// preview replace that destination while tab-new is awaiting its reply.
		if (creating) return Promise.resolve();
		wantedTab = ownerSessionKey(owner, tabId);
		paintSessionRail();
		if (switching) { showCachedTab(tabId, owner); return Promise.resolve(); }
		return switchTab(tabId, owner, again);
	}
	async function switchTab(tabId, owner, again = false) {
		tabSwitchActive = true;
		try {
			for (;;) {
				const key = ownerSessionKey(owner, tabId);
				if (!again) transcriptScroller.latest();
				const focusing = selectOwner(owner, send => send('tab-focus', { tabId, snapshot: true }), key, { retry: async () => { await refreshMachines(); await enterTab(tabId, owner, { again: true }); } });
				if (!showCachedTab(tabId, owner)) output.classList.add('entry-switching');
				// One that failed after another was asked for gives way to it.
				try { await focusing; } catch (error) { if (!wantedTab || wantedTab === key) throw error; }
				if (!wantedTab || wantedTab === key) return;
				[owner, tabId] = JSON.parse(wantedTab);
				again = false;
			}
		} finally {
			wantedTab = null; tabSwitchActive = false;
			output.classList.remove('entry-switching');
			paintSessionRail();
		}
	}
	// A new session is a fresh one at once: the question, and the input bar
	// under it, ready to type (Noah). Nothing starts on the computer until it
	// is used -- a prompt sent, a file attached, a recording made -- and then
	// the session is made on the computer, harness and model the input bar's
	// picker names (the last ones used unless others are picked), and what was
	// typed goes to it. Leaving it first leaves nothing half-made behind.
	function newTab() {
		return beginNewAgent();
	}
	let creating = false, materializing = null;
	// What was typed in a fresh session is kept while another is looked at.
	const FRESH_DRAFT = 'guey-draft:fresh';
	let freshText = '';
	try { freshText = localStorage.getItem(FRESH_DRAFT) ?? ''; } catch { freshText = ''; }
	// While a fresh session is open the composer is its own: the session in
	// view behind it keeps the draft it had.
	const heldDraft = key => (choosing ? queueDrafts.get(key) ?? storedDraft(key) : captureQueueDraft());
	// `auto` is the question asked because this machine has no session. If
	// another machine has one, that is where this screen goes instead.
	async function beginNewAgent({ auto = false } = {}) {
		if (choosing) focusChoice();
		if (creating || choosing) return;
		const held = editorKey(state);
		if (held) queueDrafts.set(held, captureQueueDraft());
		choosing = { owner: focusedTabId() ? selectedOwner : LOCAL, auto, agent: null, model: null, error: '' };
		displayQueueDraft({ text: freshText, attachments: [], start: freshText.length, end: freshText.length });
		render();
		focusChoice();
		const selection = choosing;
		void learnModels(selection).catch(error => { if (choosing === selection) { selection.error = error.message; render(); } });
		await refreshMachines();
		followNewSession();
		if (choosing) render();
	}
	// Discovery belongs to the draft, never to whichever conversation is behind it.
	async function learnModels(selection = choosing) {
		if (!selection) return;
		if (selection.catalog) return selection.catalog;
		selection.catalog = (async () => {
			const owner = selection.owner;
			if (owner !== LOCAL && !machineRows.some(m => m.id === owner && m.reachable)) throw new Error('Chosen computer is offline; no session created');
			const transport = ensureTransport(owner);
			transport.connect();
			const until = Date.now() + 6000;
			while (!transport.snapshot || transport.socket?.readyState !== WebSocket.OPEN) {
				if (Date.now() > until) throw new Error('Chosen computer is unavailable; no session created');
				await new Promise(resolve => setTimeout(resolve, 40));
			}
			const models = await ownerCommand(owner, 'models');
			if (!Array.isArray(models)) throw new Error('Chosen computer did not supply its models');
			if (choosing !== selection) return;
			selection.models = models;
			render();
		})();
		try { await selection.catalog; } finally { selection.catalog = null; }
	}
	// A harness not signed in here offers its sign-in, from the input bar's
	// picker: nothing begins until it is used.
	const SIGN_IN = { claude: 'claude-agent', codex: 'codex' };
	function signInTo(agent, owner = choosing?.owner ?? selectedOwner) {
		if (!SIGN_IN[agent]) return;
		const auth = currentAuth(owner);
		if (owner !== selectedOwner) auth.render(transports.get(owner)?.snapshot?.auth);
		auth.login(SIGN_IN[agent]).catch(fail);
	}
	// The harnesses a computer offers, in the order Noah names them, from its
	// snapshot: this window's own, or the one its connection to that computer
	// keeps. A computer just connected to is given a moment to send one.
	const HARNESS_ORDER = ['codex', 'claude', 'pi'];
	function liveHarnesses(id) {
		const key = id === hereOwner() ? LOCAL : id;
		const rows = (key === selectedOwner ? state : transports.get(key)?.snapshot)?.harnesses;
		if (!Array.isArray(rows)) return null;
		const rank = agent => (HARNESS_ORDER.includes(agent) ? HARNESS_ORDER.indexOf(agent) : HARNESS_ORDER.length);
		return [...rows].sort((a, b) => rank(a.agent) - rank(b.agent));
	}
	// Every screen is a window on the same computer, so a session started on
	// any of them is where all of them go -- unless this one has something
	// half-typed or a dialog open, which a jump would lose. A machine first
	// heard from is only taking attendance: the sessions it already had are not
	// new.
	function followNewSession() {
		if (choosing?.launch) return;
		let started = null;
		for (const [owner, transport] of transports) {
			const tabs = owner === selectedOwner ? state?.tabs : transport.snapshot?.tabs;
			if (!tabs) continue;
			const first = !heardOwners.has(owner);
			heardOwners.add(owner);
			for (const tab of tabs) {
				const key = ownerSessionKey(ownerKey(owner), tab.id);
				if (!knownSessions.has(key) && !first) started ??= { id: tab.id, owner: ownerKey(owner), here: owner === selectedOwner && tab.focused };
				knownSessions.add(key);
			}
		}
		if (!started && choosing?.auto) started = sortedTabs().find(tab => !tab.offline) ?? null;
		if (!started || started.here || creating || switching || overlay || input.value || attachments.length || voice.holding()) return;
		choosing = null;
		render();
		enterTab(started.id, started.owner).catch(fail);
	}
	function cancelChoosing() {
		if (!choosing || creating || (assemblyStep && assemblyStep !== 'done')) return false;
		// With no tabs behind it there is nothing to cancel back to, so the
		// fresh session stays until it is used.
		if (!(state?.tabs ?? []).length) return false;
		choosing = null;
		displayQueueDraft(queueDrafts.get(editorKey(state)) ?? storedDraft(editorKey(state)));
		render();
		input?.focus();
		return true;
	}
	// A fresh session has one place for the keys: its input bar.
	function focusChoice() {
		if (brand.id === 'kinso' && phone()) wm.home();
		if (hooks.canFocus?.() !== false) input.focus({ preventScroll: true });
	}
	// The fresh session made on the computer, once, however many things ask
	// for it at once (a prompt, files attached together). What is typed stays
	// in the composer, and is the new session's.
	let keepComposer = false;
	function materialize() {
		if (assemblyStep && assemblyStep !== 'done') return Promise.resolve(false);
		if (!choosing) return Promise.resolve(true);
		materializing ??= startTab().finally(() => { materializing = null; });
		return materializing;
	}
	async function startTab() {
		if (creating || !choosing) return false;
		const selection = choosing;
		creating = true;
		render();
		try {
			await refreshMachines();
			await learnModels(selection);
			if (choosing !== selection) throw new Error('New session selection changed; try again');
			const { agent, model } = freshChoice();
			if (model && !selection.models.some(m => m.provider === model.provider && m.id === model.id && (m.engine ?? 'pi') === agent)) throw new Error('Chosen model is unavailable on this computer; choose another model');
			const asked = { ...(agent ? { agent } : {}),
				...(model ? { model: { provider: model.provider, id: model.id } } : {}) };
			keepComposer = true;
			await selectOwner(selection.owner, (send, destination) => {
				if (!destination.connected) throw new Error('This computer is unavailable; no session created');
				return send('tab-new', asked);
			});
			return !choosing;
		} catch (error) { if (choosing) choosing.error = error.message; fail(error); return false; }
		finally { creating = false; keepComposer = false; render(); }
	}

	// Inventory authorizes persistent owner streams; switching never moves a runtime.
	let machineRows = [], machinesAsked = null, machinesKnown = false, usageAuthority = '';
	function refreshMachines() {
		machinesAsked ??= askMachines().finally(() => { machinesAsked = null; });
		return machinesAsked;
	}
	async function askMachines() {
		try {
			const data = await (await fetch('/machines.json', { cache: 'no-store' })).json();
			// Compared as hereOwner() gives it ('' when none is ours), so an unchanged inventory says nothing again.
			const previousMachine = hereOwner();
			machineRows = data.machines ?? [];
			// The socket can open before inventory. Declare our computer once
			// it is known, rather than leaving its close audit unnamed.
			if (previousMachine !== hereOwner() && transports.get(LOCAL)?.socket?.readyState === WebSocket.OPEN) hello();
			usageAuthority = data.authority || '';
			machinesKnown = true;
			for (const [from, to] of [...draftAliases]) {
				const [owner, session] = JSON.parse(from);
				const canonical = ownerSessionKey(ownerKey(owner), session);
				if (canonical !== from) { draftAliases.set(canonical, canonicalEditorKey(to)); draftAliases.delete(from); }
			}
			if (state && selectedOwner === LOCAL && state.executionOwner !== ownerKey(LOCAL)) {
				const oldKey = editorKey(state); queueDrafts.set(oldKey, heldDraft(oldKey));
				state.executionOwner = ownerKey(LOCAL);
				for (const [key, draft] of [...queueDrafts]) {
					const canonical = canonicalEditorKey(key);
					if (canonical !== key) { queueDrafts.set(canonical, draft); queueDrafts.delete(key); }
				}
				if (!choosing && !input.value && !attachments.length) displayQueueDraft(storedDraft(editorKey(state)));
				queueDrafts.set(editorKey(state), choosing ? queueDrafts.get(editorKey(state)) ?? queueDrafts.get(oldKey) ?? storedDraft(editorKey(state)) : captureQueueDraft()); saveDraft();
				queueDrafts.delete(oldKey);
			}
			if (restoredView?.owner && restoredView.owner !== hereOwner() && !restoreFocusAsked) {
				restoreFocusAsked = true;
				void selectOwner(restoredView.owner, send => send('tab-focus', { tabId: restoredView.tabId, snapshot: true })).catch(fail);
			}
			for (const machine of machineRows) if (!machine.self && machine.reachable && machine.id) ensureTransport(machine.id).connect();
		} catch {
			machineRows = machineRows.map(machine => ({ ...machine, reachable: false }));
			machinesKnown = true;
			for (const [from, to] of [...draftAliases]) {
				const [owner, session] = JSON.parse(from);
				const canonical = ownerSessionKey(ownerKey(owner), session);
				if (canonical !== from) { draftAliases.set(canonical, canonicalEditorKey(to)); draftAliases.delete(from); }
			}
		}
		paintSessionRail();
		paintFreshness();
		if (choosing) render();
	}
	void refreshMachines();
	setInterval(() => void refreshMachines(), 15_000);
	const hereOwner = () => machineRows.find(machine => machine.self)?.id ?? '';

	// Opening one already open goes to its tab (tabs.mjs), so it is safe to ask again.
	function openSession(row, { quiet = false } = {}) {
		if (!quiet) transcriptScroller.latest();
		const owner = row.owner || ownerKey(selectedOwner);
		return selectOwner(owner, send => row.owner
			? send('session-attach', { owner, sessionId: row.id ?? row.sessionId, agent: row.agent ?? 'pi' })
			: send('tab-open', { path: row.path ?? row.id, agent: row.agent ?? 'pi', cwd: row.cwd ?? '' }), null, { retry: async () => { await refreshMachines(); await openSession(row, { quiet: true }); } }).catch(quiet ? () => {} : fail);
	}

	// The agents are a strip of tabs across the top, on the desk as on the
	// phone, and unfolding it is the full list laid over the work for as long
	// as it takes to choose one -- a sheet, not a place to live, so it is
	// never remembered open. Collapsing takes the words away, never the way
	// back: the » that unfolds it stays. A finger swipes tabs away.
	let railCollapsed = true;
	// The usage line at the sidebar's foot, once the dock is built.
	let railFooter = null;
	// In a Mac's window, laid out in focus (windows.js), the agents are a
	// sidebar down the left instead: a place to live, kept open while one is
	// chosen, and folded or not as the person last left it.
	const RAIL_SIDEBAR = 'imperfect.sidebar';
	// The sidebar's sections (Sessions with History, Files, Sites; Settings
	// and, under a line, usage at its foot):
	// a desk's focus window, and a phone's list when it is opened.
	const railSidebar = () => terminal.classList.contains('focus-layout') || terminal.classList.contains('phone-layout');
	let railWasSidebar = false;
	function syncRailSidebar() {
		const side = railSidebar();
		if (side === railWasSidebar) return;
		railWasSidebar = side;
		let folded = false;
		try { folded = localStorage.getItem(RAIL_SIDEBAR) === 'folded'; } catch { /* storage denied */ }
		// A phone's list is a sheet, opened when asked; a desk's sidebar stays as it was left.
		setRailCollapsed(side && !phone() ? folded : true);
	}
	// A session chosen, the list as a sheet goes; as a sidebar it stays.
	const railChosen = () => { if (!railCollapsed && (!railSidebar() || phone())) setRailCollapsed(true); };
	// History is the sessions no tab holds, under the open ones in the
	// unfolded list; choosing one brings it back as a tab.
	let pastSessions = [], historyCollapsed = true, historyLoading = false, historyRequest = 0;
	function setRailCollapsed(next) {
		railCollapsed = Boolean(next);
		if (railCollapsed) { historyCollapsed = true; historyLoading = false; historyRequest++; }
		if (railSidebar() && !phone()) try { localStorage.setItem(RAIL_SIDEBAR, railCollapsed ? 'folded' : 'open'); } catch { /* storage denied */ }
		paintSessionRail();
	}
	function toggleHistory() {
		historyCollapsed = !historyCollapsed;
		if (historyCollapsed) { historyLoading = false; historyRequest++; paintSessionRail(); return; }
		const request = ++historyRequest, owner = selectedOwner;
		historyLoading = true;
		paintSessionRail();
		command('sessions').then(rows => {
			if (request === historyRequest && owner === selectedOwner) pastSessions = rows ?? [];
		}).catch(fail).finally(() => {
			if (request !== historyRequest) return;
			historyLoading = false;
			paintSessionRail();
		});
	}

	const STATUS_PRIORITY = { blocked: 0, working: 1, done: 2, unknown: 3, idle: 4 };
	function sortedTabs() {
		return [...transports].flatMap(([owner, transport]) => ((owner === selectedOwner ? state?.tabs : transport.snapshot?.tabs) ?? []).map(tab => ({ ...tab,
			owner: ownerKey(owner), focused: owner === selectedOwner && tab.focused,
			offline: transport.socket?.readyState !== WebSocket.OPEN || (owner !== LOCAL && !machineRows.some(m => m.id === owner && m.reachable)),
		}))).sort((a, b) =>
			(STATUS_PRIORITY[a.status] ?? STATUS_PRIORITY.unknown) - (STATUS_PRIORITY[b.status] ?? STATUS_PRIORITY.unknown));
	}
	// The sessions in the order the rail draws them: with more than one
	// computer, this one's first, then each other's.
	function railTabs() {
		const tabs = sortedTabs();
		const selfId = machineRows.find(machine => machine.self)?.id;
		const owners = [...new Set(tabs.map(tab => tab.owner))].sort((a, b) => Number(b === selfId) - Number(a === selfId));
		return owners.flatMap(owner => tabs.filter(tab => tab.owner === owner));
	}
	// MOD+1 to MOD+5: the first five sessions in the rail; a number with no
	// session, or one whose computer is offline, does nothing.
	function enterNthTab(n) {
		const tab = railTabs()[n - 1];
		if (!tab || tab.offline) return false;
		enterTab(tab.id, tab.owner).catch(fail);
		return true;
	}
	// Closing the session in view goes on to the one below it in the rail, or
	// above it when it was the last: next in line as the rail shows them,
	// whichever computer that one is on. Its own computer is told which, so
	// nothing else flashes up in between.
	function closeTarget(tabId, owner) {
		// Keep the transport key, not a mutable row or the eventual selection.
		const key = [...transports.keys()].find(key => ownerKey(key) === ownerKey(owner));
		const snap = key === selectedOwner ? state : transports.get(key)?.snapshot;
		const tab = snap?.tabs?.find(tab => tab.id === tabId);
		if (!tab || (tab.sessionId == null && !snap.instanceId)) throw new Error('Session changed; close cancelled');
		return { owner: key, tabId, expectedTabId: tabId, expectedSessionId: tab.sessionId ?? null,
			...(snap.instanceId ? { expectedInstanceId: snap.instanceId } : {}) };
	}
	async function closeSession(tabId, owner = selectedOwner, extra = {}) {
		const target = extra.expectedTabId === undefined ? closeTarget(tabId, owner) : { ...extra, owner, tabId };
		const snap = target.owner === selectedOwner ? state : transports.get(target.owner)?.snapshot;
		const tab = snap?.tabs?.find(tab => tab.id === tabId);
		if (!tab || (target.expectedSessionId == null
			? !target.expectedInstanceId || snap.instanceId !== target.expectedInstanceId
			: (tab.sessionId ?? null) !== target.expectedSessionId)
			|| (target.expectedInstanceId !== undefined && snap.instanceId !== target.expectedInstanceId)) throw new Error('Session changed; close cancelled');
		const canonicalOwner = ownerKey(target.owner), rail = sortedTabs();
		const at = rail.findIndex(tab => tab.id === tabId && tab.owner === canonicalOwner);
		const usable = tab => tab && !tab.offline;
		const next = rail[at]?.focused ? (rail.slice(at + 1).find(usable) ?? rail.slice(0, Math.max(0, at)).reverse().find(usable)) : null;
		const { owner: capturedOwner, ...identity } = target;
		const result = await ownerCommand(capturedOwner, 'tab-close', { gesture: 'tool', ...extra, ...identity, ...(next?.owner === canonicalOwner ? { then: next.id } : {}) });
		if (next && next.owner !== canonicalOwner) await enterTab(next.id, next.owner);
		return result;
	}
	// A row is what distinguishes it: which agent, on which model, asked to do
	// what. Its mark's colour is its status; + starts one, MOD+Esc closes.
	// On the phone a session is swiped away like a notification: sideways in
	// the unfolded list, upwards off the strip. Past a third of the way it
	// goes; short of that it springs back. Swiping explicitly ends this
	// session's current turn, even when working; its saved history stays.
	let railSwiping = false;
	{
		let drag = null, swallowClick = false;
		const settle = (row, offset, axis) => {
			row.style.transition = 'transform 0.18s ease-out, opacity 0.18s ease-out';
			row.style.transform = offset ? `translate${axis.toUpperCase()}(${offset}px)` : '';
			row.style.opacity = offset ? '0' : '';
		};
		sessionRail.addEventListener('pointerdown', event => {
			if (!phone() || drag) return;
			const row = event.target.closest('.session-rail-item:not(.session-rail-new)');
			if (!row?.dataset.tabId) return;
			let target;
			try { target = closeTarget(row.dataset.tabId, row.dataset.owner); } catch (error) { fail(error); return; }
			drag = { row, target, pointer: event.pointerId, x: event.clientX, y: event.clientY, axis: railCollapsed ? 'y' : 'x', offset: 0, live: false };
		});
		sessionRail.addEventListener('pointermove', event => {
			if (!drag || event.pointerId !== drag.pointer) return;
			const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
			if (!drag.live) {
				if (Math.max(Math.abs(dx), Math.abs(dy)) < 10) return;
				const along = drag.axis === 'x' ? Math.abs(dx) > Math.abs(dy) : dy < 0 && Math.abs(dy) > Math.abs(dx);
				if (!along) { drag = null; return; }
				drag.live = railSwiping = true;
				sessionRail.setPointerCapture(event.pointerId);
				drag.row.style.transition = 'none';
			}
			drag.offset = drag.axis === 'x' ? dx : Math.min(0, dy);
			const span = drag.axis === 'x' ? drag.row.offsetWidth : drag.row.offsetHeight * 1.5;
			drag.row.style.transform = `translate${drag.axis.toUpperCase()}(${drag.offset}px)`;
			drag.row.style.opacity = String(Math.max(0.15, 1 - Math.abs(drag.offset) / span));
		});
		const release = event => {
			if (!drag || event.pointerId !== drag.pointer) return;
			const { row, target, axis, offset, live } = drag;
			drag = null;
			if (!live) return;
			swallowClick = true;
			const span = axis === 'x' ? row.offsetWidth : row.offsetHeight * 1.5;
			const gone = event.type === 'pointerup' && Math.abs(offset) > span / 3;
			settle(row, gone ? Math.sign(offset) * span : 0, axis);
			const done = () => { railSwiping = false; railLook = ''; paintSessionRail(); };
			if (!gone) { setTimeout(done, 180); return; }
			closeSession(target.tabId, target.owner, { ...target, closeConfirmed: true, gesture: 'swipe' })
				.catch(error => { settle(row, 0, axis); fail(error); })
				.finally(() => setTimeout(done, 180));
		};
		sessionRail.addEventListener('pointerup', release);
		sessionRail.addEventListener('pointercancel', release);
		// The tap that ends a swipe is not a tap on the row.
		sessionRail.addEventListener('click', event => {
			if (swallowClick) { swallowClick = false; event.stopPropagation(); event.preventDefault(); }
		}, true);
		sessionRail.addEventListener('pointerdown', () => { swallowClick = false; }, true);
	}

	// The rail is drawn again only when something on it changed, so the button
	// under a press is still there when the press comes up.
	// Time, and this computer's Wi-Fi and battery (system.js): one quiet group
	// at the top centre of the screen, whatever columns lie under it or how
	// they are turned; on a phone it is the conversation's, leaving with its bar.
	const screenStatus = el('div', null, 'screen-status');
	const screenClock = el('time', null, 'screen-clock');
	screenClock.setAttribute('aria-label', 'Local time');
	const localTime = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
	const updateClock = () => {
		const now = new Date();
		const text = localTime.format(now);
		// Do not invalidate the view for an unchanged clock label.
		if (screenClock.textContent !== text) {
			screenClock.textContent = text;
			screenClock.dateTime = now.toISOString();
		}
	};
	let clockInterval;
	const startClock = () => {
		updateClock();
		clearInterval(clockInterval);
		// Follow wall-clock minute boundaries, not the minute after page load.
		clockInterval = setInterval(updateClock, 1_000);
	};
	startClock();
	window.addEventListener('pagehide', () => clearInterval(clockInterval));
	window.addEventListener('pageshow', startClock);
	document.addEventListener('visibilitychange', () => { if (!document.hidden) updateClock(); });
	const systemControls = mountSystem({ anchor: screenStatus, band: sessionRail });
	screenStatus.append(screenClock, systemControls.status);
	terminal.append(screenStatus);
	// What was copied (Mod+V) and a screenshot just taken hang where the
	// system panel does, one at a time; only on the computer's own screen.
	const onlyOne = keep => {
		if (keep !== systemControls && systemControls.isOpen()) systemControls.close();
		for (const other of [clipHistory, shotPreview]) if (other && other !== keep) other.close();
	};
	const clipHistory = mountClipboardHistory({
		anchor: screenStatus, band: sessionRail, beforeOpen: () => onlyOne(clipHistory),
		composer: { input, paste: pasteText, attach: file => attachFiles([file]) },
	});
	const shotPreview = mountScreenshotPreview({
		anchor: screenStatus, band: sessionRail, beforeOpen: () => onlyOne(shotPreview),
		attach: async file => { await attachFiles([file]); input.focus({ preventScroll: true }); },
		files: path => openFiles(path, { base: '' }),
	});
	let railLook = '';
	// The sidebar (focus): Sessions, Files and Sites, as Finder's and
	// Safari's sidebars hold them. What it reads from the browser, Files and
	// the windows, once they exist (sidebarHooks, set below).
	let sidebarHooks = null, historyAll = false, historyOwner = null, historyTried = 0;
	// Settings: after Messages for Kinso, otherwise at the foot above usage.
	// Models and providers, the themes, and the keys (settings.js).
	let settings = null, settingsWin = null, usageWin = null, railSettings = null;
	function settingsButton() {
		const button = el('button', null, 'session-rail-settings');
		button.type = 'button';
		button.append(el('span', 'Settings'));
		button.setAttribute('aria-expanded', 'false');
		button.addEventListener('pointerdown', event => event.stopPropagation());
		button.onclick = () => {
			settings ??= mountSettings({
				signIn: () => currentAuth().login(),
				signOut: () => currentAuth().logout(),
				chooseModel: () => chooseModel(),
				usage: () => usageView?.open(),
				present: body => {
					settingsWin ??= wm.open({ kind: 'settings', body, quiet: true, keys: () => settings.keys(),
						closeOne: () => (settings.close(), true), onClose: () => { settingsWin = null; settings.close(); } });
					showUtility(settingsWin);
				},
				dismiss: () => { wm.close(settingsWin); wm.home(); },
				showing: () => Boolean(settingsWin && wm.showing(settingsWin)),
				ownsFocus: () => wm.focused() === settingsWin && !keysHeld() && !wm.zoomed() && (document.activeElement === document.body || settingsWin.el.contains(document.activeElement)),
			});
			railChosen();
			settings.toggle();
		};
		return button;
	}
	const SIDEBAR_ICONS = { close: '<path d="M8 8l8 8M16 8l-8 8"/>' };
	function sidebarIcon(name) {
		const holder = el('span', null, 'sidebar-icon');
		holder.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${SIDEBAR_ICONS[name]}</svg>`;
		return holder;
	}
	// The sessions no tab holds, read once for this computer, again if it fails.
	function loadHistory() {
		const request = ++historyRequest, owner = selectedOwner;
		historyLoading = true; historyTried = Date.now();
		command('sessions').then(rows => {
			if (request === historyRequest && owner === selectedOwner) { pastSessions = rows ?? []; historyOwner = owner; }
		}).catch(() => { setTimeout(() => { railLook = ''; paintSessionRail(); }, 3500); }).finally(() => {
			if (request !== historyRequest) return;
			historyLoading = false; railLook = ''; paintSessionRail();
		});
	}
	function sidebarLook() {
		if (!railSidebar() || railCollapsed) return null;
		return [historyAll, assemblyStep, sidebarHooks?.views?.() ?? [], sidebarHooks?.sites?.() ?? [], sidebarHooks?.panel?.() ?? null,
			machineRows.map(machine => [machine.id, machine.reachable]), sidebarHooks?.messages?.() ?? null];
	}
	function sidebarRow({ name, meta = null, active = false, dim = false, onclick, title = '', extra = null }) {
		const row = el('div', null, `session-rail-item sidebar-row${active ? ' active' : ''}${dim ? ' dim' : ''}`);
		const open = el('button', null, 'session-rail-open');
		open.type = 'button';
		const line = el('span', null, 'session-rail-line');
		line.append(el('span', name, 'session-rail-asked'));
		if (meta !== null) line.append(typeof meta === 'string' ? el('span', meta, 'sidebar-meta') : meta);
		open.append(line);
		open.title = title;
		// On a phone the sidebar is a sheet: choosing in it puts it away.
		open.onclick = event => { if (phone()) railChosen(); onclick?.(event); };
		row.append(open);
		if (extra) row.append(extra);
		return row;
	}
	function sidebarHead(title, action = null) {
		const head = el('div', null, 'sidebar-head');
		head.append(el('span', title, 'sidebar-head-title'));
		if (action) head.append(action);
		return head;
	}
	function sidebarSections(agents) {
		const parts = [sidebarHead('Sessions'), agents];
		// New session, under the open ones -- unless one nobody has asked
		// anything yet is open: that one is the new session, named so.
		const blankSession = !choosing && railTabs().some(tab => !tab.offline && !String(tab.prompt ?? '').trim());
		if (!blankSession) parts.push(sidebarRow({ name: 'New session', dim: !choosing, active: Boolean(choosing), onclick: () => (choosing ? focusChoice() : newTab().catch(fail)) }));
		// History, folded, under New session: the sessions no tab holds.
		parts.push(sidebarHistory());
		// Files: its views, like the browser's pages below, a folder each,
		// Home to begin with.
		const showingFiles = sidebarHooks?.panel?.() === 'files';
		parts.push(sidebarHead('Files'));
		const views = sidebarHooks?.views?.() ?? [];
		for (const view of views) {
			const machine = view.owner ? machineRows.find(machine => machine.id === view.owner) : null;
			let close = null;
			if (views.length > 1) {
				close = el('button', null, 'sidebar-remove');
				close.type = 'button'; close.title = `Close ${view.name}`; close.setAttribute('aria-label', close.title);
				close.append(sidebarIcon('close'));
				close.onclick = () => sidebarHooks?.closeView(view.key);
			}
			parts.push(sidebarRow({ name: view.name, meta: machine && !machine.self ? machine.name || machine.id : '',
				active: showingFiles && view.front, title: `${machine?.name || 'this computer'} · ${view.path || '~'}`,
				onclick: () => sidebarHooks?.selectView(view.key), extra: close }));
		}
		parts.push(sidebarRow({ name: 'New view', dim: true, onclick: () => sidebarHooks?.newView() }));
		// Sites: the browser's pages.
		parts.push(sidebarHead('Sites'));
		const showingBrowser = sidebarHooks?.panel?.() === 'browser';
		const sites = sidebarHooks?.sites?.() ?? [];
		for (const site of sites) {
			// A page with nothing in it yet is the new page, and says so.
			const blank = site.url === 'about:blank';
			let host = '';
			try { host = new URL(site.url).host.replace(/^www\./, ''); } catch { /* not an address */ }
			const close = el('button', null, 'sidebar-remove');
			const name = blank ? 'New page' : site.name;
			close.type = 'button'; close.title = `Close ${name}`; close.setAttribute('aria-label', close.title);
			close.append(sidebarIcon('close'));
			close.onclick = () => sidebarHooks?.closeSite(site.key);
			parts.push(sidebarRow({ name, meta: site.unread ? el('span', null, 'sidebar-unread') : '', active: showingBrowser && site.front,
				title: blank ? '' : host || site.url, onclick: () => sidebarHooks?.selectSite(site.key), extra: close }));
		}
		if (!sites.some(site => site.url === 'about:blank')) parts.push(sidebarRow({ name: 'New page', dim: true, onclick: () => sidebarHooks?.newPage() }));
		// Messages last: the newest conversations (messages.js), each opening in the panel.
		if (messages && (!assemblyStep || ASSEMBLY_STEPS.indexOf(assemblyStep) >= ASSEMBLY_STEPS.indexOf('messages'))) parts.push(...messages.sidebar({ row: sidebarRow, head: sidebarHead, active: sidebarHooks?.panel?.() === 'messages', open: view => sidebarHooks?.showMessages(view) }));
		return parts;
	}
	// History: the sessions no tab holds, folded until asked for, in
	// Sessions under New session; opened, its rows follow it and scroll with
	// the rest of the list.
	function sidebarHistory() {
		const section = el('div', null, `sidebar-past${historyAll ? ' open' : ''}`);
		const toggle = el('button', null, `sidebar-history${historyAll ? ' open' : ''}`);
		toggle.type = 'button';
		toggle.setAttribute('aria-expanded', String(historyAll));
		toggle.append(el('span', historyAll && historyLoading && !pastSessions.length ? 'History · loading' : 'History'));
		toggle.onclick = () => { historyAll = !historyAll; railLook = ''; paintSessionRail(); };
		section.append(toggle);
		if (historyAll) {
			if (historyOwner !== selectedOwner && !historyLoading && Date.now() - historyTried > 3000) loadHistory();
			const open = new Set(railTabs().flatMap(tab => [tab.sessionFile, tab.sessionId]).filter(Boolean));
			const past = pastSessions.filter(session => !open.has(session.path) && !open.has(session.id) && !open.has(session.sessionId));
			for (const session of past.slice(0, 80)) {
				// No harness marks in the sidebar (Noah): the words say which session.
				section.append(sidebarRow({ name: session.name || String(session.firstMessage ?? '').trim().slice(0, 120) || session.id,
					meta: whenLabel(session.modified) || '', dim: true, title: session.cwd || '', onclick: () => openSession(session) }));
			}
		}
		return section;
	}
	function paintSessionRail() {
		usageView?.syncActivity();
		if (railSwiping) return;
		const look = JSON.stringify([railCollapsed, historyCollapsed, historyLoading, wantedTab, Boolean(choosing), phone(),
			sortedTabs().map(tab => [tab.id, tab.owner, tab.status, tab.agent, tab.model, tab.prompt, tab.offline, tab.focused]),
			machineRows.map(machine => [machine.id, machine.name, machine.self]),
			railCollapsed ? null : pastSessions.map(session => [session.id, session.path, session.agent, session.name, session.firstMessage, session.cwd, whenLabel(session.modified)]),
			sidebarLook()]);
		if (look === railLook) return;
		railLook = look;
		// Measure before changing the folded layout; keep + seated when unfolding.
		const previousPlus = sessionRail.querySelector('.session-rail-new');
		const plusLeft = previousPlus ? previousPlus.getBoundingClientRect().left - sessionRail.getBoundingClientRect().left : 0;
		sessionRail.classList.toggle('collapsed', railCollapsed);
		const heading = el('p', null, 'session-rail-heading');
		if (!railCollapsed) {
			const gap = parseFloat(getComputedStyle(sessionRail.querySelector('.session-rail-heading') || sessionRail).columnGap) || 0;
			const reserve = (previousPlus?.offsetWidth || 44) + (sessionRail.querySelector('.session-rail-fold')?.offsetWidth || 44) + gap;
			heading.style.paddingLeft = `${Math.max(0, Math.min(plusLeft, sessionRail.clientWidth - reserve))}px`;
		}
		const fold = el('button', railCollapsed ? '»' : '«', 'session-rail-fold');
		fold.type = 'button';
		fold.setAttribute('aria-label', railCollapsed ? 'show the agents' : 'collapse the agents');
		fold.title = railCollapsed ? 'Show agents' : 'Collapse agents';
		fold.setAttribute('aria-expanded', String(!railCollapsed));
		fold.onclick = () => setRailCollapsed(!railCollapsed);
		if (railCollapsed) {
			heading.append(fold);
		} else if (phone() && hooks.openThemes) {
			// The phone's one visible way to the theme sheet; three fingers
			// drawn together still open it too.
			const theme = el('button', 'theme', 'session-rail-theme');
			theme.type = 'button';
			theme.onclick = () => { setRailCollapsed(true); hooks.openThemes(); };
			heading.append(theme, fold);
		} else {
			heading.append(fold);
		}
		const agents = el('section', null, 'session-rail-group session-rail-agents');
		// With more than one computer, each computer's sessions sit under its
		// name, this one first, so where a session runs is the heading it is
		// under rather than an icon on every row.
		const ordered = railTabs();
		// The strip has room for a word between one computer's tabs and the next.
		const grouped = new Set(ordered.map(tab => tab.owner)).size > 1;
		let group = null;
		for (const [index, tab] of ordered.entries()) {
			if (grouped && tab.owner !== group) {
				group = tab.owner;
				const machine = machineRows.find(row => row.id === group);
				agents.append(el('p', machine?.name || group || 'this computer', 'session-rail-machine'));
			}
			const lit = wantedTab ? wantedTab === ownerSessionKey(tab.owner, tab.id) : tab.focused && !choosing;
			const row = el('div', null, `session-rail-item${lit ? ' active' : ''}`);
			row.dataset.tabId = tab.id; row.dataset.owner = tab.owner;
			row.dataset.state = tab.status || 'unknown';
			const open = el('button', null, 'session-rail-open');
			open.type = 'button';
			// One line: the mark and the model on one baseline, then what the
			// session was first asked to do.
			const line = el('span', null, 'session-rail-line');
			const identity = el('span', null, 'session-rail-agent');
			// The list names its sessions without marks (Noah); the phone's
			// strip, where a mark is all a tab shows, keeps its harness's.
			const mark = !railCollapsed ? null : phone() ? agentGlyph(tab.status, tab.agent) : el('span', romanNumeral(index + 1), 'session-rail-number');
			mark?.setAttribute('aria-hidden', 'true');
			if (mark) identity.append(mark);
			identity.append(el('span', modelLabel(tab.model) || 'model unknown', 'session-rail-model'));
			identity.setAttribute('aria-label', `${harnessLabel(tab.agent)} · ${modelLabel(tab.model) || 'model unknown'} · ${tab.status || 'unknown'}`);
			line.append(identity);
			const asked = String(tab.prompt ?? '').trim();
			if (asked) line.append(el('span', asked, 'session-rail-asked'));
			else if (railSidebar() && !railCollapsed) line.append(el('span', 'New session', 'session-rail-asked'));
			// Working, done or waiting, at the row's end (the sidebar shows it);
			// at work, it spins while it can be seen.
			const progress = el('span', null, 'session-rail-state');
			if (tab.status === 'working') animateInView(progress);
			line.append(progress);
			open.append(line);
			open.disabled = tab.offline; open.title = tab.offline ? 'Execution owner offline; session remains there' : '';
			// On a desk a tab is entered on the press, as a browser's tabs are. On
			// a phone a press may be the start of a swipe, so there it is the tap.
			const pressed = event => !phone() && event.pointerType === 'mouse';
			const enter = () => {
				if (open.disabled) return;
				railChosen();
				enterTab(tab.id, tab.owner).catch(fail);
			};
			open.onpointerdown = event => { if (pressed(event) && event.button === 0) enter(); };
			open.onclick = event => { if (!pressed(event)) enter(); };
			row.append(open);
			// In the sidebar, a little × on hover closes it, as the keys (MOD+Esc)
			// and a phone's swipe do.
			if (railSidebar() && !railCollapsed && !phone()) {
				const close = el('button', null, 'sidebar-remove');
				close.type = 'button'; close.title = 'Close session'; close.setAttribute('aria-label', close.title);
				close.append(sidebarIcon('close'));
				close.addEventListener('pointerdown', event => event.stopPropagation());
				close.onclick = event => {
					event.stopPropagation();
					let target;
					try { target = closeTarget(tab.id, tab.owner); } catch (error) { fail(error); return; }
					closeSession(target.tabId, target.owner, { ...target, closeConfirmed: true, gesture: 'sidebar-x' }).catch(fail);
				};
				row.append(close);
			}
			agents.append(row);
		}
		// New session stays in the heading, outside the scrolling tabs, so
		// even a full strip leaves its action and the fold reachable.
		{
			const row = el('div', null, `session-rail-item session-rail-new${choosing ? ' active' : ''}`);
			row.dataset.state = 'unknown';
			const open = el('button', null, 'session-rail-open');
			open.type = 'button';
			open.setAttribute('aria-label', 'new session');
			const line = el('span', null, 'session-rail-line');
			line.append(el('span', '+', 'session-rail-agent'));
			open.append(line);
			open.onclick = () => {
				railChosen();
				return choosing ? focusChoice() : newTab().catch(fail);
			};
			row.append(open);
			heading.insertBefore(row, fold);
		}
		const past = el('section', null, 'session-rail-group session-rail-history');
		if (!railCollapsed) {
			const open = new Set(ordered.flatMap(tab => [tab.sessionFile, tab.sessionId]).filter(Boolean));
			const rows = pastSessions.filter(session => !open.has(session.path) && !open.has(session.id) && !open.has(session.sessionId)).slice(0, 80);
			const toggle = el('button', `${historyCollapsed ? '»' : '«'} history${historyLoading ? ' · loading' : ''}`, 'session-rail-open session-rail-machine');
			toggle.type = 'button';
			toggle.setAttribute('aria-label', historyCollapsed ? 'Show history' : 'Collapse history');
			toggle.setAttribute('aria-expanded', String(!historyCollapsed));
			toggle.onclick = toggleHistory;
			past.append(toggle);
			for (const session of historyCollapsed || historyLoading ? [] : rows) {
				const row = el('div', null, 'session-rail-item session-rail-past');
				row.dataset.state = 'unknown';
				const open = el('button', null, 'session-rail-open');
				open.type = 'button';
				const line = el('span', null, 'session-rail-line');
				const identity = el('span', null, 'session-rail-agent');
				identity.append(el('span', whenLabel(session.modified) || '', 'session-rail-model'));
				line.append(identity, el('span', session.name || String(session.firstMessage ?? '').trim().slice(0, 120) || session.id, 'session-rail-asked'));
				open.append(line);
				open.title = session.cwd || '';
				open.onclick = () => { railChosen(); openSession(session); };
				row.append(open);
				past.append(row);
			}
		}
		if (railCollapsed) sessionRail.replaceChildren(heading, agents, past);
		else if (railSidebar()) {
			const list = el('div', null, 'session-rail-list session-rail-sidebar');
			list.append(...sidebarSections(agents));
			sessionRail.replaceChildren(heading, list);
		} else {
			// Only the list below the transparent band needs opaque paper.
			const list = el('div', null, 'session-rail-list');
			list.append(agents, past);
			sessionRail.replaceChildren(heading, list);
		}
		if (railFooter) {
			const list = brand.id === 'kinso' && sessionRail.querySelector('.session-rail-sidebar');
			if (list) {
				const section = el('div', null, 'session-rail-settings-section');
				section.append(railSettings);
				list.append(section);
			} else railFooter.prepend(railSettings);
			sessionRail.append(railFooter);
		}
	}

	// The windows (windows.js): the conversation is the first, Workbench is
	// always beside it, and the browser, which holds every page, website and
	// thing shown as a tab (pages.js), opens in one beside them, all shared by
	// every session.
	const conversation = terminal.closest('.code-face');
	// The keyboard stays where it is while something open is using it: a
	// dialog, the model box, the keys, the themes.
	const keysHeld = () => Boolean(overlay) || [...document.querySelectorAll('dialog[open]:not(.guey-auth), [role="dialog"]:not([hidden]):not(.guey-auth), [role="menu"]:not([hidden]), .keys-face:not([hidden])')].some(node => !node.closest('.wm-usage, [inert]') && node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden');
	// The pointer come into the conversation, the input bar takes the keys,
	// ready to type; unless text is chosen in the conversation, to copy, when
	// the keys only leave wherever they were, so the copy is of that.
	function conversationKeys() {
		const active = document.activeElement;
		// A docked question owns the keys until it has been answered.
		if (!dialog.hidden && dialog.classList.contains('input-dialog')) {
			if (!dialog.contains(active)) dialog.querySelector('input, textarea, button:not(:disabled)')?.focus({ preventScroll: true });
			return;
		}
		if (active === input || (middle.contains(active) && active.matches?.('input, textarea, select, [contenteditable="true"]'))) return;
		const chosen = getSelection();
		if (chosen && !chosen.isCollapsed && middle.contains(chosen.anchorNode)) {
			if (active && active !== document.body && !middle.contains(active)) active.blur();
			return;
		}
		input.focus({ preventScroll: true });
	}
	const middle = terminal.querySelector('.entry-screen');
	// Kinso asks in the placeholder; its bar stays at the foot from the start.
	if (brand.id !== 'kinso') {
		middle.append(el('h1', 'what do you want?', 'fresh-question'));
		new ResizeObserver(() => { if (terminal.classList.contains('fresh')) placeFresh(); }).observe(terminal);
		new ResizeObserver(() => { if (terminal.classList.contains('fresh')) placeFresh(); }).observe(byId('entry-input-zone'));
	}
	const wm = mountWindows({ conversation, panel: middle, keys: conversationKeys, held: keysHeld,
		restoredOrder: restoredView?.order ?? (restoredView?.windows ? ['conversation', ...restoredView.windows.map(win => win.kind)] : []),
		// Only this version's reloads may restore a layout; older choices
		// return to focus, including the native window's saved view.
		restoredLayout: restoredView?.oneLayout === LAYOUT_CHOICE ? restoredView.layout : null,
		onPanel: kind => {
			for (const name of ['settings', 'usage']) {
				const button = sessionRail.querySelector(`.session-rail-${name}`);
				button?.setAttribute('aria-expanded', String(kind === name));
			}
			paintSessionRail();
		},
	});
	// The sea fills the frame; only the conversation gets a quiet veil.
	if (brand.id === 'kinso') mountSharks({ host: middle, canvasHost: terminal, avoid: () => {
		const bar = barBox(true);
		return bar?.width && bar.height ? [bar] : [];
	} });
	// Hardware controls share the right panel; they never replace a conversation.
	let systemWin = null;
	systemControls.setPresenter({
		isShowing: () => Boolean(systemWin && !systemWin.el.classList.contains('wm-tucked') && wm.showing(systemWin)),
		show: () => {
			onlyOne(systemControls);
			if (!systemWin) systemWin = wm.open({ kind: 'system', body: systemControls.panel, quiet: true,
				keys: () => systemControls.panel.focus({ preventScroll: true }),
				closeOne: () => { systemControls.close(); return true; },
				onClose: () => { systemWin = null; systemControls.close(); } });
			wm.show(systemWin);
			if (!phone()) wm.reveal(systemWin, true);
		},
		close: () => {
			const win = systemWin; systemWin = null;
			if (win) wm.close(win);
		},
	});
	function showUtility(win) {
		wm.show(win);
		if (!phone()) wm.reveal(win, true);
	}
	// Focus begun or ended (MOD+L, the window made phone-narrow and wide again).
	syncRailSidebar();
	new MutationObserver(syncRailSidebar).observe(terminal, { attributes: true, attributeFilter: ['class'] });
	// A session question replaces the shared footer. Pickers own only the
	// conversation pane; Settings and Usage belong to the shared side panel.
	const placeDialog = () => {
		const footer = !dialog.hidden && dialog.classList.contains('input-dialog');
		const host = footer ? terminal : middle;
		if (dialog.parentElement === host) return;
		const active = dialog.contains(document.activeElement) ? document.activeElement : null;
		host.append(dialog);
		if (active && footer) active.focus({ preventScroll: true });
	};
	const dialogPlacement = new MutationObserver(placeDialog);
	dialogPlacement.observe(dialog, { attributes: true, attributeFilter: ['hidden', 'class'] });
	dialogPlacement.observe(middle, { attributes: true, attributeFilter: ['class'] });
	const pages = mountPages({ output, wm, base: () => ownerBase(),
		// The browser button on a phone or a browser page: the home computer's
		// browser (the desktop window opens its own: pages.js launch).
		launchBase: async () => {
			// Resolve authenticated home metadata, never the selected execution owner.
			// Fetch independently: opening the browser must not change drafts or focus.
			const response = await fetch('/machines.json', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
			if (!response.ok) throw new Error('Browser computer unavailable');
			const { machines } = await response.json();
			if (!Array.isArray(machines) || !machines.some(machine => machine.home)) throw new Error('Home browser computer unavailable');
			return defaultFilesBase(machines);
		}, launchAllowed: () => !keysHeld(), onLaunchError: error => fail(new Error(`Browser unavailable: ${error.message}. Try again.`)), onFolder: (path, options) => openFiles(path, options),
		onProject: (name, options) => { wm.show(files); return workbench.project(name, options); },
		onApp: async (target, options) => { const opened = await workbench.preview(target, options); if (opened && !options.quiet) wm.show(files); return opened; },
		onTabs: () => paintSessionRail() });
	// A phone's question brings the conversation into view. Kinso's fresh
	// composer comes home explicitly in focusChoice, not on every class update:
	// those updates must not drag a swipe to the side panel back home.
	const asking = () => (!dialog.hidden && !dialog.classList.contains('centre-box'))
		|| (brand.id !== 'kinso' && terminal.classList.contains('choosing'));
	const asked = new MutationObserver(() => { if (phone() && asking()) wm.home(); });
	asked.observe(dialog, { attributeFilter: ['hidden'] });
	asked.observe(terminal, { attributeFilter: ['class'] });
	// Workbench: a computer's folders, from its home (workbench-view.js).
	// Always open: on a desk tiled beside the conversation from the start, on
	// a phone the panel to its right. It is never closed; the phone's back
	// takes the typed address or the map away, then shows the conversation.
	const filesHost = el('div');
	const workbench = mountWorkbench({ host: filesHost,
		onViews: () => { if (sidebarHooks) paintSessionRail(); },
		defaultBase: async machines => {
			// Restore and selected sessions are owned; only a blank surface uses home.
			if (restoredView?.tabId && restoredView.owner) return machines?.some(machine => machine.self && machine.id === restoredView.owner) ? '' : ownerBase(restoredView.owner);
			// A solitary hosted computer has no other execution owner to await.
			// Files is usable even while its conversation socket is reconnecting.
			if (machines?.length === 1 && machines[0].self && machines[0].home) return '';
			let timer;
			try {
				await Promise.race([snapshotReady, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Files owner unavailable')), 5000); })]);
			} finally { clearTimeout(timer); }
			if (state?.sessionId || focusedTabId()) return ownerBase();
			return defaultFilesBase(machines);
		},
		// On a phone a page playing in Workbench fills the screen, as the browser's does.
		onFull: () => wm.full(files) });
	const files = wm.open({ kind: 'files', body: filesHost.firstElementChild, quiet: true, stays: true,
		keys: () => workbench.focus(),
		closeOne: () => workbench.back() || (phone() && (wm.home(), true)) });
	// Messages (messages.js): the person's conversations, a window like
	// Files, shown in the panel beside the session (focus) as Files and the
	// browser are, made the first time it is wanted. A link to sign in to an
	// account opens in the browser: the desktop window's own, else the home
	// computer's, watched live.
	messages = launchPhone ? null : mountMessages({
		openLink: (url, { signIn = false } = {}) => openWebsite(url, { fresh: signIn }),
		onChange: () => { if (sidebarHooks) paintSessionRail(); },
		showing: () => Boolean(messagesWin && wm.showing(messagesWin) && !document.hidden),
	});
	function showMessages(view = null, { quiet = false } = {}) {
		if (!messages) return;
		if (!messagesWin) messagesWin = wm.open({ kind: 'messages', body: messages.el, quiet: true,
			keys: () => messages.keys(),
			closeOne: () => messages.back() || (phone() ? (wm.home(), true) : wm.close(messagesWin)),
			onClose: () => { messagesWin = null; } });
		if (view) messages.open(view);
		if (quiet) return;
		wm.show(messagesWin);
		if (!phone()) wm.reveal(messagesWin, true);
		messages.seen();
		messages.keys();
		paintSessionRail();
	}
	async function openWebsite(url, { fresh = false } = {}) {
		if (globalThis.imperfectDesk) {
			// A sign-in link is good once: an old tab on its site gives way to the new one.
			if (fresh) {
				const host = new URL(url).hostname;
				for (const tab of pages.tabs()) { try { if (new URL(tab.url || tab.target).hostname === host) pages.closeSite(tab.key); } catch { /* not a website */ } }
			}
			pages.visit(url);
			return;
		}
		try {
			const asked = async request => {
				const response = await fetch('/browser', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request), signal: AbortSignal.timeout(30000) });
				const answer = await response.json();
				if (!response.ok || answer.error) throw new Error(answer.error || `Browser unavailable (${response.status})`);
				return answer;
			};
			const page = await asked({ do: 'open', url });
			if (Number.isSafeInteger(page.tab)) await asked({ do: 'front', tab: page.tab }).catch(() => {});
			pages.watch('', { quiet: false, remote: true });
		} catch (error) { throw new Error(`The browser could not be opened: ${error.message}`); }
	}
	sidebarHooks = {
		sites: () => pages.sites(),
		selectSite: key => pages.select(key),
		closeSite: key => pages.closeSite(key),
		newPage: () => { if (!keysHeld()) pages.newTab(); },
		panel: () => wm.panel(),
		views: () => workbench.views(),
		showFiles: () => { wm.show(files); if (!phone()) wm.reveal(files, true); },
		selectView: key => { workbench.selectView(key); sidebarHooks.showFiles(); },
		newView: () => { workbench.newView(); sidebarHooks.showFiles(); },
		closeView: key => workbench.closeView(key),
		messages: () => messages?.sidebarLook(),
		showMessages: view => showMessages(view),
	};
	railLook = ''; paintSessionRail();
	// A folder, on the explicit computer, or the Files tab's resolved owner;
	// quiet, Workbench goes there without being shown.
	function openFiles(path = '', { quiet = false, base } = {}) {
		if (!quiet) {
			wm.show(files);
			if (!phone()) wm.reveal(files, true);
		}
		void workbench.open(path, { base, quiet });
	}
	// Workbench follows the conversation to the computer its session runs on,
	// where the agent's work is: a session on another computer takes it to
	// that computer's home, unless it is there already. Its own bar still
	// chooses another.
	function followFiles() {
		if (workbench.where().base !== ownerBase()) void workbench.open('', { base: ownerBase(), quiet: true });
	}
	// Explicit Files activation brings its column into view; quiet agent
	// folder openings above never reveal it. Phone show() already swipes.
	function showFiles() {
		wm.show(files);
		if (!phone()) wm.reveal(files, true);
		workbench.focus();
	}
	// After a reload Workbench is at the folder it was, and the browser's
	// tabs open again. The passive phone has neither to restore.
	if (!launchPhone) {
		const was = restoredView?.windows?.find(win => win.kind === 'files')?.at;
		void workbench.open(was?.path || '', { base: was?.base, quiet: true });
	}
	setTimeout(() => {
		for (const { kind, at } of restoredView?.windows ?? []) if (kind !== 'files' && at) pages.reopen(at);
		if (restoredView?.windows?.some(win => win.kind === 'messages')) showMessages(null, { quiet: true });
	});

	function romanNumeral(number) {
		let text = '';
		for (const [value, numeral] of [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']]) {
			while (number >= value) { text += numeral; number -= value; }
		}
		return text;
	}

	// The matching harness at rest or at work (Claude's starburst, not the
	// crab); the state stays on the node for blocked, done and unknown.
	function agentGlyph(status, agent) {
		const state = status || 'unknown';
		const glyph = sessionMark(agent, { working: state === 'working' });
		glyph.classList.add('session-rail-logo');
		glyph.dataset.state = state;
		return state === 'working' ? animateInView(glyph) : glyph;
	}
	function cycleTab(delta) {
		const tabs = state?.tabs ?? [];
		if (tabs.length < 2) return false;
		// From the one last asked for while it is still coming (the rail
		// shows it already), else the one on screen.
		const asked = wantedTab ? JSON.parse(wantedTab)[1] : null;
		const at = asked ? tabs.findIndex(tab => tab.id === asked) : -1;
		const i = at >= 0 ? at : Math.max(0, tabs.findIndex(tab => tab.focused));
		const next = tabs[(i + delta + tabs.length) % tabs.length];
		if (!next) return false;
		enterTab(next.id).catch(fail);
		return true;
	}

	// A notification tapped, here or on the device's lock screen, opens the
	// session that sent it: its tab, or brought back from history.
	async function showSession(id, owner = LOCAL) {
		if (!id) return;
		await snapshotReady;
		const tabs = (owner === selectedOwner ? state?.tabs : transports.get(owner)?.snapshot?.tabs) ?? [];
		const tab = tabs.find(item => item.sessionId === id || item.id === id);
		if (tab) {
			if (owner !== selectedOwner || !tab.focused) await enterTab(tab.id, ownerKey(owner)).catch(fail);
			return;
		}
		if (owner !== selectedOwner) return;
		const row = (await command('sessions').catch(() => [])).find(item => item.id === id || item.sessionId === id);
		if (row) await openSession(row);
	}
	const notifications = createNotifications({
		open: showSession,
		tick: () => { try { globalThis.imperfectNative?.tick?.(); } catch { /* no motor */ } },
	});
	void notifications.start();

	const transcriptScroller = transcriptScroll(output);
	// The answer still arriving, let out a little every frame; the view stays
	// at the bottom in the frame the words are drawn.
	const liveAnswer = liveMessage(() => transcriptScroller.pin());
	// Another machine's pictures are fetched through it, like its other files.
	const mediaAt = src => src.startsWith('/media/') && selectedOwner !== LOCAL ? `/peer/${encodeURIComponent(ownerKey(selectedOwner))}${src}` : src;
	// The conversation is drawn the way T3 Code keeps its timeline: each
	// message is drawn once and kept, keyed by the message itself, and every
	// update lays the kept drawings out in order, drawing only what is new.
	// A message already on screen is never drawn again, so nothing moves
	// under the reader; a window (what an agent showed) stays where it is,
	// the rest put around it. What a session drew is kept while it is one of
	// the last few looked at (or drawn ahead, below), so going back to one
	// lays out what is already there.
	const drawings = new Map();
	function drawingsOf(key) {
		let kept = drawings.get(key);
		if (kept) drawings.delete(key);
		else kept = { messages: new WeakMap(), lines: new WeakMap() };
		drawings.set(key, kept);
		const most = kind() === 'desktop' ? 8 : 2;
		for (const old of drawings.keys()) { if (drawings.size <= most) break; if (old !== renderedSessionId && old !== key) drawings.delete(old); }
		return kept;
	}
	// A message's drawing: made once. The turn under way is laid out in full
	// (gui-live): a message skipped as off screen would be measured at a
	// stand-in height the moment it arrives, and the view kept at the bottom
	// would jump. Indices are in the whole conversation.
	function messageNodes(kept, view, message, index, live, resolve) {
		let nodes = kept.messages.get(message);
		if (!nodes) {
			const part = document.createDocumentFragment();
			renderGuiTranscript(part, { ...view, messages: [message], partial: null }, { imageNode: (block, alt) => imageNode(block, alt, resolve), windowNode: windowFor, from: index });
			if (live) for (const node of part.children) if (node.classList.contains('gui-message')) node.classList.add('gui-live');
			nodes = [...part.childNodes];
			kept.messages.set(message, nodes);
		}
		return nodes.map(keptWindow);
	}
	// A local session's conversation is drawn ahead while the computer is
	// idle, so opening it lays out what is already there.
	const preparing = new Set();
	function prepareTranscript(data) {
		const view = { ...data, executionOwner: ownerKey(LOCAL) };
		const id = editorKey(view);
		if (id === renderedSessionId || drawings.has(id) || preparing.has(id)) return;
		preparing.add(id);
		(globalThis.requestIdleCallback ?? (fn => setTimeout(fn, 0)))(() => {
			preparing.delete(id);
			if (id === renderedSessionId || drawings.has(id) || document.hidden || !eagerLocal()) return;
			const messages = view.messages ?? [], base = view.messagesFrom ?? 0, from = messages.findLastIndex(entry => entry?.role === 'user');
			const kept = drawingsOf(id);
			messages.forEach((message, i) => messageNodes(kept, view, message, base + i, i >= from, src => src));
		});
	}
	// The first prompt of a fresh session, drawn at once and until the
	// computer has it: { text, at, key: the session it went to, nodes }.
	let firstPrompt = null;
	function settleFirstPrompt() {
		if (!firstPrompt) return;
		const gone = firstPrompt.key
			? firstPrompt.key !== editorKey(state) || Boolean((state.messages ?? []).length || state.partial || state.failed)
			: !choosing && !creating;
		if (gone) firstPrompt = null;
	}
	// A fresh session: one being opened (choosing), or one made with nothing
	// asked of it yet. Its question and its input bar are in the middle
	// (paintFresh); the first prompt sends the bar down to its place.
	function freshView() {
		if (firstPrompt) return false;
		if (choosing) return true;
		const tab = state?.tabs?.find(tab => tab.focused);
		return Boolean(tab) && !(state.messages ?? []).length && !state.partial && !state.busy && !state.streaming
			&& !(state.messagesFrom > 0) && !String(tab.prompt ?? '').trim();
	}
	const FRESH_MOVE_MS = 420;
	let freshMoveTimer = 0;
	function paintFresh() {
		// Kinso's fresh session has the same layout as its conversation, always.
		if (brand.id === 'kinso') return;
		const fresh = freshView(), was = terminal.classList.contains('fresh');
		// Sent: the question fades, and the input bar resizes and glides down
		// to its place while the conversation appears (imperfect.css). Only
		// then: coming back to a session, it is simply where it always is.
		if (was && !fresh && firstPrompt && !still()) {
			terminal.classList.add('fresh-move');
			clearTimeout(freshMoveTimer);
			freshMoveTimer = setTimeout(() => terminal.classList.remove('fresh-move'), FRESH_MOVE_MS + 120);
		}
		terminal.classList.toggle('fresh', fresh);
		if (fresh) placeFresh();
	}
	// Where the input bar sits in a fresh session: a little under the middle of
	// the conversation's height, the question over it. Measured from the bar's
	// own place at the foot, so the move down is the same distance back.
	const BAR_PARTS = ':scope > :is(#entry-pending, .entry-connection, #entry-input-zone, .entry-status)';
	function barBox(rects = false) {
		const parts = [...terminal.querySelectorAll(BAR_PARTS)].filter(part => part.offsetHeight);
		if (!parts.length) return null;
		if (rects) {
			const boxes = parts.map(part => part.getBoundingClientRect());
			const left = Math.min(...boxes.map(box => box.left)), right = Math.max(...boxes.map(box => box.right));
			const top = Math.min(...boxes.map(box => box.top)), bottom = Math.max(...boxes.map(box => box.bottom));
			return { left, top, right, bottom, width: right - left, height: bottom - top };
		}
		return { top: Math.min(...parts.map(part => part.offsetTop)), bottom: Math.max(...parts.map(part => part.offsetTop + part.offsetHeight)) };
	}
	function placeFresh() {
		const bar = barBox();
		if (!bar || !middle) return;
		const frame = terminal.getBoundingClientRect(), screen = middle.getBoundingClientRect();
		if (!screen.height) return;
		const screenTop = screen.top - frame.top;
		const want = screenTop + screen.height * 0.56 - (bar.bottom - bar.top) / 2;
		const lift = Math.min(0, Math.round(want - bar.top));
		terminal.style.setProperty('--fresh-lift', `${lift}px`);
		middle.style.setProperty('--fresh-bar-top', `${Math.round(bar.top + lift - screenTop)}px`);
	}
	let renderedSessionId = null;
	let guiTop = 0;
	let older = null, olderFails = 0, olderAfter = 0;
	output.addEventListener('scroll', () => { guiTop = output.scrollTop; });

	function renderTranscript() {
		settleFirstPrompt();
		const fresh = freshView();
		output.classList.toggle('gui-transcript', !fresh);
		// What was first asked shows at once, while its session is made and
		// until the computer has it.
		if (firstPrompt) {
			if (!firstPrompt.nodes) {
				const part = document.createDocumentFragment();
				renderGuiTranscript(part, { messages: [{ role: 'user', content: firstPrompt.text, timestamp: firstPrompt.at }], partial: null }, {});
				firstPrompt.nodes = [...part.childNodes];
			}
			place([...firstPrompt.nodes, typingLine(firstPrompt.at)]);
			transcriptScroller.latest();
			return;
		}
		// Nothing has been asked in a fresh session yet.
		if (fresh) { renderedSessionId = null; place([]); return; }
		if (renderedSessionId !== editorKey(state)) {
			renderedSessionId = editorKey(state);
			liveAnswer.reset();
			guiTop = 0;
			transcriptScroller.latest();
			// The rail button that changed sessions is replaced during this render.
			// Return keys to the composer, unless the person chose another window
			// while the session was arriving.
			const selectedKey = editorKey(state), generation = selectionGeneration;
			requestAnimationFrame(() => { if (generation === selectionGeneration && selectedKey === editorKey(state) && !overlay && !wm.owns(document.activeElement) && hooks.canFocus?.()) input.focus(); });
		}
		const previousTop = guiTop;
		const messages = state.messages ?? [], base = state.messagesFrom ?? 0;
		const kept = drawingsOf(renderedSessionId);
		// Where the turn under way begins: the person's last message.
		const from = messages.findLastIndex(entry => entry?.role === 'user');
		const next = [];
		if (!messages.length && !state.partial) {
			const empty = document.createDocumentFragment();
			renderGuiTranscript(empty, state, { imageNode: (block, alt) => imageNode(block, alt, mediaAt), windowNode: windowFor });
			next.push(...empty.childNodes);
		} else {
			// Under the answer that ends each turn, how long it took and when it
			// finished; the last turn's too once it is over.
			const ends = turnEnds(messages, !state.streaming && !state.partial && state.operation !== 'compacting');
			messages.forEach((message, i) => {
				next.push(...messageNodes(kept, state, message, base + i, i >= from, mediaAt));
				const timed = ends.get(i);
				if (timed) next.push(turnLine(kept, message, timed));
			});
			if (state.partial) next.push(...(liveAnswer.draw(state.partial) ?? messageNodes(kept, state, state.partial, base + messages.length, true, mediaAt)));
			else liveAnswer.reset();
			const working = workingLine(state, messages, from);
			if (working) next.push(working);
		}
		place(next);
		transcriptScroller.rendered(previousTop);
		loadOlder();
	}
	// The nodes in this order, and nothing else: what is no longer drawn
	// goes; one already in its place stays, and the others are put around it.
	function place(nodes) {
		const wanted = new Set(nodes);
		for (const child of [...output.childNodes]) if (!wanted.has(child)) child.remove();
		let cursor = output.firstChild;
		for (const node of nodes) { if (node === cursor) cursor = node.nextSibling; else output.insertBefore(node, cursor); }
	}
	// Within a screen of the top of what is held, the page before it is asked
	// for (server.mjs) and drawn above, the reader's place kept. One at a time;
	// an answer for a session no longer in view, or that no longer begins
	// where it was asked from, is dropped. A failure tries again, less often
	// each time.
	output.addEventListener('scroll', () => loadOlder(), { passive: true });
	function loadOlder() {
		if (!state?.sessionId || !(state.messagesFrom > 0) || choosing || switching || Date.now() < olderAfter) return;
		const key = editorKey(state), before = state.messagesFrom, owner = selectedOwner, tabId = focusedTabId();
		if (older?.key === key || output.scrollTop > output.clientHeight) return;
		const asked = older = { key };
		const loaded = loadingBar.begin();
		ownerCommand(owner, 'messages-before', { tabId, sessionId: state.sessionId, before }).then(page => {
			olderFails = 0;
			if (editorKey(state) !== key || state.messagesFrom !== before || switching || page?.sessionId !== state.sessionId
				|| !Array.isArray(page.messages) || page.from + page.messages.length !== before) return;
			const atBottom = output.scrollHeight - output.clientHeight - output.scrollTop < 2, fromBottom = output.scrollHeight - output.scrollTop;
			state = { ...state, messages: page.messages.concat(state.messages), messagesFrom: page.from };
			if (owner === LOCAL && localDesktop()) localSessions.accept(tabId, state);
			render();
			if (!atBottom) output.scrollTop = guiTop = output.scrollHeight - fromBottom;
			if (older === asked) { older = null; loadOlder(); }
		}).catch(() => {
			const wait = Math.min(30_000, 1000 * 2 ** olderFails++);
			olderAfter = Date.now() + wait;
			setTimeout(loadOlder, wait + 10);
		}).finally(() => { loaded(); if (older === asked) older = null; });
	}
	// Where each turn ends, the last thing the agent said before the person
	// spoke again, and how long it took; the last turn too once it is over.
	function turnEnds(messages, over) {
		const ends = new Map();
		let asked = -1, said = -1;
		const close = end => { const timed = asked >= 0 && said > asked ? turnTime(messages, asked, end) : null; if (timed) ends.set(said, timed); };
		messages.forEach((message, i) => {
			if (message?.role === 'user') { close(i); asked = i; said = -1; }
			else if (message?.role === 'assistant' || message?.role === 'toolResult') said = i;
		});
		if (over) close(messages.length);
		return ends;
	}
	// A turn's line, kept with the answer it is under, so the one shown as
	// the turn ends is the one that stays when the person asks again.
	function turnLine(kept, message, timed) {
		const key = `${timed.startedAt}:${timed.endedAt}`, held = kept.lines.get(message);
		if (held?.key === key) return held.node;
		const node = turnTimeNode(timed);
		kept.lines.set(message, { key, node });
		return node;
	}
	// Below the turn under way, as T3 Code shows it: compacting, the context
	// being compacted; at work, how long so far, counting up. One node, made
	// again only when what it says changes.
	// While the agent answers it is "typing", by its own name: Locus, or the
	// brand's (brand.js), with how long so far after it. The conversation is a
	// polite live region (index.html), so the words are said once; the count
	// is not read out every second.
	let below = { key: '', node: null };
	const tick = line => { line.lastChild.textContent = ` · ${formatWorking(Date.now() - Number(line.dataset.since))}`; };
	function typingLine(since) {
		const key = `working:${since}`;
		if (below.key !== key) {
			const node = el('p', null, 'gui-turn-time working gui-typing');
			node.dataset.since = String(since);
			const time = el('span', null, 'gui-typing-time');
			time.setAttribute('aria-hidden', 'true');
			node.append(el('span', `${brand.agent} is typing…`, 'gui-typing-who'), time);
			below = { key, node };
		}
		tick(below.node);
		return below.node;
	}
	function workingLine(state, messages, from) {
		const since = Number(from >= 0 ? messages[from]?.timestamp : NaN);
		if (state.operation === 'compacting') {
			if (below.key !== 'compacting') below = { key: 'compacting', node: compactionNode(null, true) };
			return below.node;
		}
		return state.streaming && Number.isFinite(since) ? typingLine(since) : null;
	}
	setInterval(() => { if (below.node?.isConnected && below.node.classList.contains('gui-typing') && !document.hidden) tick(below.node); }, 1000);

	// The brand's mark moves while the agent works, as the harnesses' did; the
	// one mark is kept, so a snapshot never restarts its motion.
	function paintWork() {
		const working = Boolean(firstPrompt) || (!choosing && Boolean(state?.busy || state?.operation === 'compacting'));
		modelName.classList.toggle('working', working);
		modelName.firstElementChild.classList.toggle('mark-working', working);
	}

	// The harness and model a fresh session will start on: what was picked
	// for it, else what the computer starts a new session on (the harness and
	// model it last used, tabs.mjs), as far as it says.
	function freshChoice() {
		const usual = liveHarnesses(choosing?.owner ?? LOCAL)?.find(row => row.usual);
		if (choosing?.model) return { agent: choosing.agent ?? choosing.model.engine ?? 'pi', model: choosing.model };
		const model = !choosing?.agent || choosing.agent === usual?.agent ? usual?.model ?? null : null;
		const known = model && choosing?.models?.find(m => m.provider === model.provider && m.id === model.id);
		return { agent: choosing?.agent ?? usual?.agent ?? null, model: known ?? model };
	}
	// The status line: the model, the harness that runs it and how hard it thinks.
	function renderStatus() {
		const { agent, model } = choosing ? freshChoice() : { agent: state.agent, model: state.model };
		document.body.dataset.thinking = (!choosing && state.level) || 'off';
		// Until the model is known the label names the harness alone.
		const owner = choosing?.owner ?? selectedOwner;
		const destination = owner !== LOCAL ? machineRows.find(m => m.id === owner)?.name ?? owner : '';
		modelCaption.textContent = [destination, modelText(model) || (agent ? '' : 'model')].filter(Boolean).join(' · ');
		harnessCaption.textContent = agent ? harnessName(agent) : '';
		modelName.title = agent ? [destination, harnessName(agent), modelText(model)].filter(Boolean).join(' · ') : 'Choose the harness and model';
		modelName.setAttribute('aria-label', modelName.title);
		// How hard it thinks.
		const level = choosing ? null : state.level;
		thinking.textContent = level && level !== 'off' ? `· ${level}` : '';
		modelStatus.textContent = choosing?.error || (!choosing && state.failed ? 'failed'
			: !socket || socket.readyState !== WebSocket.OPEN ? 'reconnecting'
			: ''); // a background task working says nothing (Noah, 14 Oct)
	}

	const queueDrafts = new Map();
	let carriedDraft = null;
	const takingQueues = new Set();
	let queueTaking = false;
	// A fresh tab belongs to a host lifetime, not just a recyclable tab id.
	// Aliases migrate every draft/completion, including background attachments,
	// when an owner (possibly watched in another window) gives it its first SID.
	const draftAliases = new Map();
	function draftTargetKey(owner, { sessionId, tabId, instanceId }) {
		return canonicalEditorKey(ownerSessionKey(owner, sessionId ?? `tab:${JSON.stringify([instanceId, tabId])}`));
	}
	function editorKey(data) {
		return data ? draftTargetKey(data.executionOwner || ownerKey(selectedOwner), {
			sessionId: data.sessionId, tabId: data.tabs?.find(tab => tab.focused)?.id, instanceId: data.instanceId,
		}) : null;
	}
	function canonicalEditorKey(key) {
		if (!key) return key;
		const [owner, session] = JSON.parse(key);
		const canonical = ownerSessionKey(ownerKey(owner), session);
		return draftAliases.get(canonical) ?? canonical;
	}
	function migrateDraftIdentities(owner, data) {
		if (!data?.instanceId || !Array.isArray(data.tabs)) return;
		for (const tab of data.tabs) {
			if (tab.sessionId == null) continue;
			const from = ownerSessionKey(ownerKey(owner), `tab:${JSON.stringify([data.instanceId, tab.id])}`);
			if (draftAliases.has(from)) continue;
			const to = draftTargetKey(owner, { sessionId: tab.sessionId });
			const active = !choosing && from === editorKey(state);
			const draft = active ? captureQueueDraft() : queueDrafts.get(from) ?? storedDraft(from);
			draftAliases.set(from, to);
			if (!draft.text && !draft.attachments.length) continue;
			const kept = queueDrafts.get(to) ?? storedDraft(to);
			// A destination can already contain recovered text. Do not discard it.
			const prefix = draft.text && kept.text ? draft.text + '\n\n' : draft.text;
			const merged = !kept.text && !kept.attachments.length ? draft : { ...kept,
				text: prefix + kept.text, attachments: [...new Set([...draft.attachments, ...kept.attachments])],
				start: prefix.length + kept.start, end: prefix.length + kept.end };
			queueDrafts.set(to, merged); queueDrafts.delete(from);
			if (active) displayQueueDraft(merged);
			try { localStorage.setItem(draftKey(to), merged.text); localStorage.removeItem(draftKey(from)); } catch {}
		}
	}
	function captureQueueDraft() {
		return { text: input.value, attachments, start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection };
	}
	function displayQueueDraft(draft) {
		input.value = draft.text;
		attachments = draft.attachments;
		input.setSelectionRange(draft.start, draft.end, draft.direction);
		saveDraft(); paintPending(); paintCaret(); hooks.onDraftChange?.();
	}
	async function takeQueue(fields) {
		const origin = editorKey(state);
		if ([...takingQueues].some(key => canonicalEditorKey(key) === origin)) return;
		takingQueues.add(origin);
		queueTaking = true;
		paintQueue();
		try {
			const { item } = await command('queue-take', { ...fields, expectedSessionId: state.sessionId, expectedTabId: focusedTabId() });
			if (!item) return;
			const destination = canonicalEditorKey(origin);
			const current = !choosing && destination === editorKey(state);
			const draft = current ? captureQueueDraft() : (queueDrafts.get(destination) ?? { text: '', attachments: [], start: 0, end: 0 });
			const recovered = restoreQueueItem(draft, item);
			queueDrafts.set(destination, recovered);
			if (current) { displayQueueDraft(recovered); input.focus(); }
		} catch (error) { fail(error); }
		finally { takingQueues.delete(origin); queueTaking = takingQueues.size > 0; paintQueue(); }
	}
	function paintQueue() {
		const items = choosing ? [] : state?.queue?.items ?? [];
		queueBox.hidden = !items.length;
		queueBox.replaceChildren();
		if (!items.length) return;
		for (const item of items) {
			const row = el('button', `Steering: ${item.text}`, 'entry-queue-line');
			row.type = 'button';
			row.disabled = [...takingQueues].some(key => canonicalEditorKey(key) === editorKey(state)) || !item.id;
			row.dataset.queueId = item.id ?? '';
			row.onmousedown = event => event.preventDefault(); // keep composer focus/selection
			row.onclick = () => takeQueue({ queueId: item.id });
			queueBox.append(row);
		}
		queueBox.append(el('div', '↳ click a line, or ↑ in an empty input bar, to edit latest', 'entry-queue-hint'));
	}

	function applyQueue(q, origin = editorKey(state)) {
		const key = canonicalEditorKey(origin), current = !choosing && key === editorKey(state);
		const before = current ? captureQueueDraft() : (queueDrafts.get(key) ?? storedDraft(key));
		const items = q?.items ?? (q?.steering ?? []).map(text => ({ text }));
		const draft = restoreQueueItem(before, { text: items.map(item => item.text).filter(Boolean).join('\n\n'), images: items.flatMap(item => item.images ?? []) });
		queueDrafts.set(key, draft);
		if (current) displayQueueDraft(draft);
	}

	let viewed;
	function render() {
		usageView?.sync();
		if (!state) return;
		// A fresh session not yet made on the computer (choosing) is drawn as
		// any fresh one is (paintFresh), its composer and status its own.
		terminal.classList.toggle('choosing', Boolean(choosing));
		// On a phone, another session chosen comes into view in its panel; the
		// windows beside it stay as they are.
		const viewing = focusedTabId();
		if (viewing !== viewed) { if (viewed !== undefined && phone()) wm.home(); viewed = viewing; }
		setFileBase(state.cwd);
		renderTranscript();
		paintFresh();
		renderStatus();
		paintCaret();
		paintWork();
		paintQueue();
		// An extension asking a question outranks a picker we opened ourselves.
		// Another session's question waits while a fresh one is open.
		const ask = choosing ? null : state.ui?.dialogs?.[0];
		if (!switching) for (const key of heldDialogs.keys()) {
			const [session, id] = JSON.parse(key);
			if (session === editorKey(state) && !(state.ui?.dialogs ?? []).some(item => item.id === id)) heldDialogs.delete(key);
		}
		if (ask && !switching) showExtensionDialog(ask);
		else if (overlay?.kind === 'extension') closeDialog();
		const authOwner = choosing?.owner ?? selectedOwner;
		currentAuth(authOwner).render((authOwner === selectedOwner ? state : transports.get(authOwner)?.snapshot)?.auth);
		paintSessionRail();
	}

	/* -------------------------------------------------------------- dialogs */
	const heldDialogs = new Map();
	const dialogKey = ask => JSON.stringify([editorKey(state), ask.id]);
	function suspendDialog() {
		if (overlay?.kind === 'extension') {
			heldDialogs.set(shownDialogId, { overlay, nodes: [...dialog.childNodes], keys: dialog.onkeydown, className: dialog.className });
		}
		closeDialog(); // Navigation is not cancellation; the agent keeps waiting.
	}
	let modelPickerRequest = 0;
	function closeDialog(restore = false) {
		if (overlay) modelPickerRequest++; // Dismissal invalidates awaits; a carried draft's new tab does not.
		const cancel = overlay?.onCancel, caret = overlay?.caret;
		if (overlay) hooks.onSheet?.(false);
		overlay = null; dialog.hidden = true; dialog.replaceChildren(); dialog.onkeydown = null;
		if (restore) Promise.resolve(cancel?.()).catch(fail);
		if (hooks.canFocus?.() && wm.focused().kind === 'conversation') {
			input.focus({ preventScroll: true });
			if (caret?.origin === editorKey(state)) input.setSelectionRange(caret.start, caret.end, caret.direction);
		}
	}
	// Only our local pickers dismiss on an outside tap, never an SDK question
	// or permission. Consume that tap so it cannot also submit or navigate.
	let dismissedPickerPointer = null;
	document.addEventListener('pointerdown', event => {
		if (dismissedPickerPointer === event.pointerId) dismissedPickerPointer = null;
		if (!overlay || overlay.kind === 'extension' || dialog.contains(event.target)) return;
		dismissedPickerPointer = event.pointerId;
		event.preventDefault(); event.stopImmediatePropagation();
		dismissDialog(overlay, true);
	}, true);
	// Cancelling pointerdown does not cancel its later click. Swallow that
	// same gesture too, without swallowing keyboard activation or a new tap.
	document.addEventListener('click', event => {
		if (dismissedPickerPointer == null || event.detail === 0 || (event.pointerId != null && event.pointerId !== dismissedPickerPointer)) return;
		dismissedPickerPointer = null;
		event.preventDefault(); event.stopImmediatePropagation();
	}, true);
	document.addEventListener('pointercancel', event => {
		if (dismissedPickerPointer === event.pointerId) dismissedPickerPointer = null;
	}, true);

	function dismissDialog(sheet, restore = false) {
		if (overlay === sheet) closeDialog(restore);
		else if (restore) Promise.resolve(sheet.onCancel?.()).catch(fail);
	}

	function showDialog({ kind, title, hint, detail, footer, className = '', rows, onPick, onMove, onCancel, selected, search = rows.length > 8 }) {
		// A dialog is a sheet over the canvas; the window counts it so a new
		// build never reloads out from under it.
		if (!overlay) hooks.onSheet?.(true);
		const local = kind !== 'extension';
		overlay = { kind, title, onCancel, ...(local ? { caret: { origin: editorKey(state), start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection } } : {}) };
		const sheet = overlay;
		const pick = row => {
			if (row.unavailable || (local && overlay !== sheet)) return;
			dismissDialog(sheet);
			Promise.resolve(row.pick ? row.pick() : onPick?.(row)).catch(fail);
		};
		dialog.hidden = false;
		dialog.className = [search ? 'compact-select' : '', className].filter(Boolean).join(' ');
		let filter = '', active = Math.max(0, rows.findIndex(row => row === selected || row.label === selected));
		const paint = () => {
			const matches = rows.filter(row => row.label.toLowerCase().includes(filter.toLowerCase()));
			active = Math.max(0, Math.min(active, matches.length - 1));
			const frame = document.createDocumentFragment();
			const heading = el('div', null, 'entry-dialog-heading');
			heading.append(el('p', title, 'entry-dialog-title'));
			if (local) {
				const close = el('button', '×', 'entry-dialog-close');
				close.type = 'button'; close.setAttribute('aria-label', 'Close picker');
				close.onclick = () => dismissDialog(sheet, true);
				heading.append(close);
			}
			frame.append(local ? heading : heading.firstChild);
			if (detail) frame.append(el('div', detail, 'entry-dialog-detail'));
			if (search) {
				const box = el('input', null, 'compact-search');
				box.value = filter; box.placeholder = 'filter';
				box.oninput = () => { filter = box.value; active = 0; paint(); box.focus(); };
				frame.append(box);
				frame.append(el('span', `${matches.length}/${rows.length}`, 'compact-count'));
			}
			const options = local ? el('div', null, 'entry-dialog-options') : frame;
			matches.slice(0, 60).forEach((row, index) => {
				if (row.section && (index === 0 || matches[index - 1].section !== row.section)) options.append(el('p', row.section, 'entry-dialog-hint'));
				const option = el('button', null, `entry-dialog-option${index === active ? ' active' : ''}${row.unavailable ? ' unavailable' : ''}`);
				option.type = 'button';
				option.disabled = Boolean(row.unavailable);
				if (row.computer) option.dataset.computer = row.computer;
				if (row.agent) {
					option.append(harnessMark(row.agent));
					option.title = `${harnessName(row.agent)} / ${row.billing}`;
					option.setAttribute('aria-label', `${row.label} · ${option.title}`);
					if (footer) option.setAttribute('aria-describedby', 'entry-dialog-billing');
				}
				option.append(el('span', row.label, 'entry-dialog-option-label'));
				if (row.note) option.append(el('small', row.note));
				if (kind === 'extension') option.onfocus = () => {
					active = index;
					for (const [i, button] of [...dialog.querySelectorAll('.entry-dialog-option')].entries()) button.classList.toggle('active', i === active);
				};
				option.onclick = () => pick(row);
				options.append(option);
			});
			if (!matches.length) options.append(el('p', 'nothing matches', 'entry-dialog-hint'));
			if (local) frame.append(options);
			if (footer) {
				const billing = el('p', footer, 'entry-dialog-billing');
				billing.id = 'entry-dialog-billing'; frame.append(billing);
			}
			frame.append(el('p', hint ?? 'enter chooses · esc closes', 'entry-dialog-hint'));
			dialog.replaceChildren(frame);
			dialog.tabIndex = 0;
			if (search) dialog.querySelector('.compact-search')?.focus();
			else dialog.focus();
			dialog.querySelector('.entry-dialog-option.active')?.scrollIntoView({ block: 'nearest' });
			const row = matches[active];
			if (row && onMove) Promise.resolve(onMove(row)).catch(fail);
		};
		function keys(event) {
			const matches = rows.filter(row => row.label.toLowerCase().includes(filter.toLowerCase()));
			if (event.key === 'ArrowDown') { active = Math.min(active + 1, matches.length - 1); event.preventDefault(); paint(); }
			else if (event.key === 'ArrowUp') { active = Math.max(active - 1, 0); event.preventDefault(); paint(); }
			else if (event.key === 'Enter' && !event.target.closest('button')) { event.preventDefault(); const row = matches[active]; if (row) pick(row); }
			else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismissDialog(sheet, true); }
		}
		dialog.onkeydown = keys;
		paint();
	}

	let shownDialogId = null;
	function showExtensionDialog(ask) {
		const key = dialogKey(ask);
		if (overlay?.kind === 'extension' && shownDialogId === key) return;
		if (overlay?.kind === 'extension') suspendDialog();
		shownDialogId = key;
		const held = heldDialogs.get(key);
		if (held) {
			heldDialogs.delete(key);
			overlay = held.overlay; dialog.replaceChildren(...held.nodes); dialog.onkeydown = held.keys; dialog.className = held.className;
			dialog.hidden = false; hooks.onSheet?.(true);
			return;
		}
		const send = sessionCommand();
		const answer = fields => { heldDialogs.delete(key); return send('dialog', { dialogId: ask.id, ...fields }).catch(fail); };
		if (ask.method === 'questions') { showQuestionsDialog(ask, answer); return; }
		if (ask.method === 'select') {
			showDialog({ kind: 'extension', title: ask.title, className: 'input-dialog', onCancel: () => answer({ cancelled: true }), hint: '↑↓ choose · enter answers · esc cancels', ...(ask.message ? { detail: ask.message, search: false } : {}),
				rows: [...ask.options.map(option => ({ label: option, pick: () => answer({ value: option }) })), { label: 'cancel', pick: () => answer({ cancelled: true }) }] });
			return;
		}
		if (ask.method === 'confirm') {
			const permission = permissionFor(state?.agent);
			showDialog({ kind: 'extension', title: ask.title, detail: ask.message, hint: '↑↓ choose · enter answers · esc cancels', className: `input-dialog ${permission?.className ?? ''}`, search: false, onCancel: () => answer({ cancelled: true }),
				rows: [{ label: 'yes', pick: () => answer({ confirmed: true }) }, { label: 'no', pick: () => answer({ confirmed: false }) }] });
			return;
		}
		if (!overlay) hooks.onSheet?.(true);
		overlay = { kind: 'extension', onCancel: () => answer({ cancelled: true }) };
		const sheet = overlay;
		dialog.hidden = false; dialog.className = 'input-dialog';
		const box = el('textarea');
		box.value = ask.prefill ?? ''; box.placeholder = ask.placeholder ?? '';
		const ok = el('button', 'answer'); ok.type = 'button'; ok.onclick = () => { dismissDialog(sheet); answer({ value: box.value }); };
		const no = el('button', 'cancel'); no.type = 'button'; no.onclick = () => dismissDialog(sheet, true);
		const actions = el('div', null, 'entry-dialog-actions'); actions.append(ok, no);
		dialog.replaceChildren(el('p', ask.title, 'entry-dialog-title'), box, actions);
		dialog.onkeydown = event => {
			if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismissDialog(sheet, true); }
			else if (event.key === 'Enter' && !event.isComposing && (ask.method === 'input' || event.ctrlKey || event.metaKey)) { event.preventDefault(); ok.click(); }
		};
		box.focus();
	}

	// AskUserQuestion: one to four questions, each with its own options and an
	// 'Other' free-text fallback the tool always offers. Single-select toggles
	// one choice at a time; multiSelect keeps a set. 'answer all' stays
	// disabled until every question has something — a question skipped
	// silently would just come back as an empty string Claude has to guess at.
	function showQuestionsDialog(ask, answer) {
		if (!overlay) hooks.onSheet?.(true);
		overlay = { kind: 'extension', onCancel: () => answer({ cancelled: true }) };
		dialog.hidden = false;
		dialog.className = 'input-dialog questions-dialog';
		const sheet = overlay;
		const questions = Array.isArray(ask.questions) ? ask.questions : [];
		const picked = questions.map(() => new Set());
		const otherOn = questions.map(() => false);
		const otherText = questions.map(() => '');
		const answerFor = index => {
			const parts = [...picked[index]];
			const text = otherText[index].trim();
			if (otherOn[index] && text) parts.push(text);
			return parts.join(', ');
		};
		const complete = () => questions.every((_, index) => answerFor(index).length > 0);
		const pick = (index, label) => {
			const question = questions[index];
			if (question.multiSelect) {
				if (picked[index].has(label)) picked[index].delete(label); else picked[index].add(label);
			} else {
				picked[index] = picked[index].has(label) ? new Set() : new Set([label]);
				otherOn[index] = false;
			}
			paint();
		};
		const pickOther = index => {
			if (!questions[index].multiSelect) picked[index] = new Set();
			otherOn[index] = true;
			paint();
			dialog.querySelector(`[data-other-for="${index}"] textarea`)?.focus();
		};
		function paint() {
			const focused = dialog.contains(document.activeElement) ? document.activeElement?.dataset.choice : null;
			const scrollTop = dialog.querySelector('.entry-dialog-questions')?.scrollTop ?? 0;
			const frame = document.createDocumentFragment();
			const content = el('div', null, 'entry-dialog-questions');
			questions.forEach((question, index) => {
				const block = el('div', null, 'entry-dialog-question');
				block.setAttribute('role', 'group');
				block.setAttribute('aria-label', question.question);
				const head = el('p', null, 'entry-dialog-title');
				if (question.header) head.append(el('span', question.header, 'entry-dialog-question-header'));
				head.append(el('span', question.question));
				block.append(head);
				for (const [optionIndex, option] of (question.options ?? []).entries()) {
					const row = el('button', null, `entry-dialog-option${picked[index].has(option.label) ? ' active' : ''}`);
					row.type = 'button'; row.dataset.choice = `${index}-${optionIndex}`;
					row.setAttribute('aria-pressed', String(picked[index].has(option.label)));
					row.append(el('span', option.label, 'entry-dialog-option-label'));
					if (option.description) row.append(el('small', option.description));
					row.onclick = () => pick(index, option.label);
					block.append(row);
				}
				const other = el('button', null, `entry-dialog-option${otherOn[index] ? ' active' : ''}`);
				other.type = 'button'; other.dataset.choice = `${index}-other`;
				other.setAttribute('aria-pressed', String(otherOn[index]));
				other.append(el('span', 'Other', 'entry-dialog-option-label'));
				other.onclick = () => pickOther(index);
				block.append(other);
				if (otherOn[index]) {
					const wrap = el('div', null, 'entry-dialog-other');
					wrap.dataset.otherFor = String(index);
					const box = el('textarea');
					box.rows = 3; box.placeholder = 'say more…'; box.value = otherText[index];
					box.setAttribute('aria-label', `Other: ${question.question}`);
					box.oninput = () => { otherText[index] = box.value; ok.disabled = !complete(); };
					wrap.append(box);
					block.append(wrap);
				}
				content.append(block);
			});
			frame.append(content);
			const actions = el('div', null, 'entry-dialog-actions');
			const ok = el('button', questions.length > 1 ? 'answer all' : 'answer');
			ok.type = 'button';
			ok.disabled = !complete();
			ok.onclick = () => {
				const answers = {};
				questions.forEach((question, index) => { answers[question.question] = answerFor(index); });
				dismissDialog(sheet);
				answer({ value: answers });
			};
			const cancel = el('button', 'cancel'); cancel.type = 'button'; cancel.onclick = () => dismissDialog(sheet, true);
			actions.append(ok, cancel);
			frame.append(actions, el('p', '↑↓ choose · enter answers · esc cancels', 'entry-dialog-hint'));
			dialog.replaceChildren(frame);
			content.scrollTop = scrollTop;
			if (focused) dialog.querySelector(`[data-choice="${focused}"]`)?.focus({ preventScroll: true });
		}
		dialog.onkeydown = event => {
			if (event.isComposing || event.altKey || ((event.ctrlKey || event.metaKey) && event.key !== 'Enter')) return;
			const rows = [...dialog.querySelectorAll('.entry-dialog-option')];
			const focused = document.activeElement;
			if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismissDialog(sheet, true); }
			else if (focused.matches('textarea') && (event.key !== 'Enter' || event.shiftKey)) return;
			else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
				event.preventDefault();
				const other = focused.closest?.('.entry-dialog-other');
				const current = other ? dialog.querySelector(`[data-choice="${other.dataset.otherFor}-other"]`) : focused;
				const index = Math.max(0, rows.indexOf(current));
				rows[Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus();
			} else if (event.key === 'Enter' && !focused.closest?.('.entry-dialog-actions')) {
				event.preventDefault();
				if (complete() && (focused.matches('textarea') || focused.getAttribute('aria-pressed') === 'true')) dialog.querySelector('.entry-dialog-actions button')?.click();
				else if (focused.getAttribute('aria-pressed') === 'true') {
					const next = questions.findIndex((_, index) => !answerFor(index));
					dialog.querySelectorAll('.entry-dialog-question')[next]?.querySelector('.entry-dialog-option')?.focus();
				} else if (focused.matches('.entry-dialog-option')) focused.click();
				else if (!focused.matches('textarea')) rows[0]?.click();
			}
		};
		paint();
		dialog.tabIndex = -1;
		if (hooks.canFocus?.() && wm.focused().kind === 'conversation') dialog.querySelector('.entry-dialog-option')?.focus({ preventScroll: true });
	}

	/* ------------------------------------------------------------ the model */
	// One box in the middle of the screen: the newest model of each line this
	// computer can run, and the one this session is on, the harness that runs
	// it shown by its original mark. Picking asks how hard it should think. A Claude
	// model runs in Claude Code, a Codex one in Codex, every other in Pi.
	async function chooseModel() {
		if (choosing) return chooseFresh();
		const send = sessionCommand(), origin = editorKey(state), generation = selectionGeneration;
		const request = ++modelPickerRequest, now = state?.model;
		const models = await send('models');
		if (request !== modelPickerRequest || overlay?.kind === 'extension' || switching || generation !== selectionGeneration || origin !== editorKey(state)) return;
		const isNow = m => now?.provider === m.provider && now?.id === m.id;
		const claudeFirst = (a, b) => (b.engine === 'claude') - (a.engine === 'claude');
		const listed = newestOfEachLine([...models].sort(claudeFirst), modelText, isNow);
		// Claude's "default" is one of the others under another name.
		const rows = listed.filter(m => !(m.engine === 'claude' && m.id === 'default' && listed.some(o => o !== m && o.engine === 'claude' && modelText(o) === modelText(m))))
			.map(m => {
				const billing = m.billing || 'billing unknown';
				const subscription = /^(?:(?:Claude|ChatGPT) )?subscription(?:$|\s*·)/i.test(billing);
				const api = /^API(?:$|[ /])/i.test(billing);
				return { model: m, label: modelText(m) || m.id, agent: m.engine ?? 'pi', billing,
					note: `${harnessName(m.engine ?? 'pi')} · ${subscription ? 'Subscription' : api ? 'API' : 'Unknown'}`, pick: () => pickModel(m, send, generation) };
			});
		if (state?.auth) rows.push({ label: 'Sign in for more models…', note: '', pick: () => currentAuth().login() });
		const current = models.find(isNow);
		showDialog({ kind: 'model', title: 'model', footer: billingNote(rows), className: 'centre-box model-picker', search: true, hint: 'type to find · enter chooses · esc closes', rows, selected: current && rows.find(row => row.model === current) });
	}
	const billingNote = rows => (rows.some(row => row.agent === 'claude' && (/Subscription$/.test(row.note) || /extra usage/i.test(row.billing)))
		? 'Claude extra usage, if enabled, can cost more.' : null);
	// A fresh session's one picker names the destination, its models and its
	// sign-ins. Picking only changes the draft; nothing starts on a computer.
	function paintFreshPicker(asked) {
		if (choosing !== asked || overlay?.kind === 'extension') return;
		const harnesses = liveHarnesses(asked.owner), models = asked.models ?? [];
		const usual = freshChoice();
		const isNow = m => usual.model?.provider === m.provider && usual.model?.id === m.id && (m.engine ?? 'pi') === usual.agent;
		const claudeFirst = (a, b) => (b.engine === 'claude') - (a.engine === 'claude');
		const listed = newestOfEachLine([...(Array.isArray(models) ? models : [])].sort(claudeFirst), modelText, isNow)
			.filter((m, _, all) => !(m.engine === 'claude' && m.id === 'default' && all.some(o => o !== m && o.engine === 'claude' && modelText(o) === modelText(m))));
		const computers = [{ id: LOCAL, name: machineRows.find(m => m.self)?.name ?? 'this computer', self: true, reachable: true }, ...machineRows.filter(m => !m.self && m.id)];
		const rows = computers.map(machine => ({ computer: machine.id, section: 'computer', label: machine.name,
			note: !machine.reachable ? 'offline' : machine.id === asked.owner ? 'selected' : machine.self ? 'this computer' : '', unavailable: !machine.reachable,
			pick: () => {
				if (choosing !== asked || creating) return;
				if (machine.id !== asked.owner) choosing = { ...asked, owner: machine.id, agent: null, model: null, models: null, catalog: null, error: '' };
				render(); return chooseFresh();
			} }));
		for (const m of listed) {
			const billing = m.billing || 'billing unknown';
			const subscription = /^(?:(?:Claude|ChatGPT) )?subscription(?:$|\s*·)/i.test(billing), api = /^API(?:$|[ /])/i.test(billing);
			rows.push({ section: 'model', model: m, label: modelText(m) || m.id, agent: m.engine ?? 'pi', billing,
				note: `${harnessName(m.engine ?? 'pi')} · ${subscription ? 'Subscription' : api ? 'API' : 'Unknown'}`,
				pick: () => { if (choosing !== asked) return; Object.assign(asked, { agent: m.engine ?? 'pi', model: m, error: '' }); render(); focusChoice(); } });
		}
		for (const row of harnesses ?? []) if (!row.ready && SIGN_IN[row.agent]) {
			rows.push({ section: 'model', label: `${harnessName(row.agent)} · sign in`, note: row.blocked?.replace('Sign in to Codex in imperfect', `Sign in to Codex in ${brand.name}`) ?? '', pick: () => signInTo(row.agent, asked.owner) });
		}
		if (!listed.length && !(harnesses ?? []).some(row => !row.ready)) rows.push({ section: 'model', label: asked.error || (asked.models ? 'no models on this computer yet' : 'loading models…'), note: '', unavailable: true });
		showDialog({ kind: 'model', title: 'new session', footer: billingNote(rows), className: 'centre-box model-picker', search: rows.length > 8,
			hint: 'enter chooses · esc closes', rows, selected: rows.find(row => row.model && isNow(row.model)) ?? rows.find(row => row.model) });
	}
	async function chooseFresh() {
		const asked = choosing;
		if (!asked || creating) return;
		paintFreshPicker(asked);
		const request = ++modelPickerRequest;
		try { await learnModels(asked); } catch (error) { if (choosing === asked) { asked.error = error.message; render(); } }
		if (request === modelPickerRequest && choosing === asked && overlay?.kind === 'model') paintFreshPicker(asked);
	}
	// A model of the other harness continues in a new tab (tabs.mjs). What is in
	// the input bar goes with it: the snapshot that brings the new tab moves the
	// draft there. The first snapshot after the answer settles it either way,
	// since by then the computer has this window on the tab it chose.
	async function pickModel(m, send = sessionCommand(), generation = selectionGeneration) {
		if (switching || generation !== selectionGeneration) return;
		const request = ++modelPickerRequest;
		const carry = carriedDraft = m.engine && m.engine !== state?.agent ? { from: editorKey(state), generation, answered: false } : null;
		try { await send('model', { provider: m.provider, modelId: m.id }); }
		catch (error) { if (carry && carriedDraft === carry) carriedDraft = null; throw error; }
		if (carry) carry.answered = true;
		if (request !== modelPickerRequest || overlay?.kind === 'extension' || switching || generation !== selectionGeneration) return;
		// Choosing another harness may intentionally create/select a new tab.
		// Read its effort only if no navigation intervened, then bind the picker
		// to that resulting session rather than the old harness's tab.
		const origin = editorKey(state), readLevel = sessionCommand();
		// The model response precedes its new-tab snapshot on the wire. For a
		// cross-harness move, read this owner's resulting selection, not the old tab.
		const info = await (carry ? command('level') : readLevel('level')).catch(() => null);
		if (request !== modelPickerRequest || overlay?.kind === 'extension' || switching || generation !== selectionGeneration || (!carry && origin !== editorKey(state))) return;
		const setLevel = sessionCommand();
		const levels = info?.available ?? [];
		if (!levels.length) return;
		showDialog({ kind: 'effort', title: `${modelText(m)} · effort`, className: 'centre-box', search: false, hint: `enter chooses · esc keeps ${info.current ?? 'the default'}`,
			rows: levels.map(level => ({ label: level, note: level === info.current ? 'now' : '', pick: () => setLevel('level', { level }) })), selected: info.current });
	}

	/* ---------------------------------------------------------------- input */
	// A draft is kept per conversation, as it is typed.
	const draftKey = key => `guey-draft:${key}`;
	function storedDraft(key) {
		let text = ''; try { text = localStorage.getItem(draftKey(key)) ?? ''; } catch {}
		return { text, attachments: [], start: text.length, end: text.length };
	}
	const saveDraft = () => {
		try {
			if (choosing) { freshText = input.value; localStorage.setItem(FRESH_DRAFT, input.value); }
			else if (editorKey(state)) localStorage.setItem(draftKey(editorKey(state)), input.value);
		} catch {}
	};

	const filesInput = byId('entry-files'), attachLabel = byId('entry-plus'), pendingStrip = byId('entry-pending');
	const localFileAccept = filesInput.accept;
	const attachIcon = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M10 3h4v7h7v4h-7v7h-4v-7H3v-4h7z" fill="currentColor"/></svg>';
	{
		// Every control in the input bar, the same on the desk as on the
		// phone, always in sight: the mic, usage and +.
		const dock = document.querySelector('.session-actions');
		// Usage has its own authority scope; a conversation never moves it.
		let localOnly = false;
		const usageComputer = () => usageOwner(machineRows, usageAuthority, localOnly) || (machinesKnown ? ownerKey(LOCAL) : '');
		const usageTransport = () => usageComputer() === hereOwner() || usageComputer() === LOCAL ? LOCAL : usageComputer();
		const sendUsage = async (owner, type, fields = {}) => {
			if (!owner) throw new Error('Usage computer unavailable');
			const transport = ensureTransport(owner);
			transport.connect();
			const until = Date.now() + 8000;
			while (transport.socket?.readyState === 0 && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 50));
			return transport.command(type, fields);
		};
		// Limits belong to the account a computer signs in with, so while the
		// usage computer cannot be reached (the PC off), this computer's own
		// are still true now: they are shown, and said to be this computer's,
		// rather than the last the other one gave, hours old.
		let limitsHere = false;
		const usageHost = el('div', null, 'usage-panel');
		usageView = mountUsage({
			panel: usageHost,
			present: () => {
				usageWin ??= wm.open({ kind: 'usage', body: usageHost, quiet: true, keys: () => usageView.keys(),
					closeOne: () => (usageView.close(), true), onClose: () => { usageWin = null; usageView.close(); } });
				showUtility(usageWin);
			},
			dismiss: () => { wm.close(usageWin); wm.home(); },
			showing: () => Boolean(usageWin && wm.showing(usageWin)),
			ownsFocus: () => wm.focused() === usageWin && !overlay && (document.activeElement === document.body || usageWin.el.contains(document.activeElement)),
			canClose: () => !wm.zoomed(),
			tabs: sortedTabs,
			command: async (type, fields) => {
				if (!machinesKnown) await refreshMachines();
				const owner = usageTransport();
				limitsHere = false;
				try {
					return await sendUsage(owner, type, { ...fields, ...(type === 'usage-history' && localOnly ? { thisComputerOnly: true } : {}) });
				} catch (error) {
					if (type !== 'usage' || owner === LOCAL) throw error;
					const answer = await sendUsage(LOCAL, type, fields);
					limitsHere = true;
					return answer;
				}
			},
			captureCommand: () => {
				const owner = usageTransport();
				return (type, fields) => sendUsage(owner, type, { ...fields, scope: 'computer' });
			},
			identity: () => JSON.stringify([usageComputer(), localOnly, viewKey()]),
			cacheIdentity: () => JSON.stringify([hereOwner(), usageComputer(), localOnly]),
			ownerLabel: () => machineName(usageTransport()),
			scopeLabel: () => limitsHere ? `${machineName(LOCAL)} · this computer (${machineName(usageTransport())} cannot be reached)` : `${machineName(usageTransport())} · ${localOnly || (!usageAuthority && !machineRows.some(m => m.home && !m.self)) ? 'this computer only' : 'all computers'}`,
			selectScope: value => { localOnly = value; },
		});
		const browser = document.createElement('button');
		browser.type = 'button'; browser.className = 'entry-browser';
		browser.title = 'Browser (Chromium) · PC browser'; browser.setAttribute('aria-label', 'Open PC browser (Chromium)');
		// Chromium's three blades and centre, in the dock's accent. Transparent
		// seams keep the mark legible over every theme, including custom colours.
		browser.innerHTML = `<svg class="entry-chromium" viewBox="1 1 22 22" width="20" height="20" fill="currentColor" aria-hidden="true" focusable="false">
			<path d="M3.75 6.35A10 10 0 0 1 20.25 6.35H12A5.65 5.65 0 0 0 7.107 14.825Z"/>
			<path d="M3.75 6.35A10 10 0 0 1 20.25 6.35H12A5.65 5.65 0 0 0 7.107 14.825Z" transform="rotate(120 12 12)"/>
			<path d="M3.75 6.35A10 10 0 0 1 20.25 6.35H12A5.65 5.65 0 0 0 7.107 14.825Z" transform="rotate(240 12 12)"/>
			<circle cx="12" cy="12" r="4.2"/>
		</svg>`;
		browser.onclick = () => { if (!keysHeld()) pages.portal(); };
		dock.prepend(usageView.button, browser, voice.button);
		// In focus (a Mac's window and the laptop's) the input bar is only the
		// words: + and the mic stay in this line above it, usage is the
		// sidebar's foot and the browser is its Sites (focus.css hides
		// both here).
		railFooter = el('div', null, 'session-rail-foot');
		usageView.summary.classList.add('session-rail-usage');
		usageView.summary.addEventListener('click', railChosen);
		railSettings = settingsButton();
		railFooter.append(railSettings, usageView.summary);
		railLook = '';
		paintSessionRail();
		dock.addEventListener('mousedown', event => { if (document.activeElement === input) event.preventDefault(); });
	}
	let attachments = [];
	// The words in the input bar that stand for an image.
	const standIns = () => /(image \d+)/g;
	function nextImageNumber() {
		const used = new Set(attachments.map(piece => Number(piece.token?.match(/\d+$/)?.[0])).filter(Number.isFinite));
		let number = 1;
		while (used.has(number)) number += 1;
		return number;
	}
	// Text pasted into the input bar at the cursor, as Ctrl+V would.
	function pasteText(text) {
		input.focus({ preventScroll: true });
		if (document.execCommand('insertText', false, text)) return;
		const start = input.selectionStart ?? input.value.length;
		input.setRangeText(text, start, input.selectionEnd ?? start, 'end');
		input.dispatchEvent(new Event('input', { bubbles: true }));
	}
	// Words put in the input bar at the cursor, a word of their own.
	function insertWords(words) {
		const start = input.selectionStart ?? input.value.length;
		const end = input.selectionEnd ?? start;
		const before = input.value.slice(0, start);
		const space = before && !/\s$/.test(before) ? ' ' : '';
		input.setRangeText(`${space}${words} `, start, end, 'end');
		saveDraft(); paintCaret(); hooks.onDraftChange?.();
	}
	function insertImageToken(piece) {
		piece.token = `image ${nextImageNumber()}`;
		insertWords(piece.token);
	}
	function dropAttachment(piece) {
		piece.controller?.abort();
		if (piece.imageUrl) URL.revokeObjectURL(piece.imageUrl);
		const index = attachments.indexOf(piece);
		if (index >= 0) attachments.splice(index, 1);
		if (piece.token) input.value = input.value.replace(piece.token, '').replace(/ {2,}/g, ' ');
		saveDraft(); paintCaret(); paintPending();
	}
	function paintPending() {
		filesInput.accept = localFileAccept;
		attachLabel.title = 'Attach existing audio, photos or files';
		attachLabel.classList.toggle('has-files', attachments.length > 0);
		attachLabel.setAttribute('aria-label', attachments.length ? attachments.map(p => p.name).join(', ') : 'attach');
		const attachMark = attachLabel.querySelector('span');
		if (attachments.length) attachMark.textContent = String(attachments.length);
		else attachMark.innerHTML = attachIcon;
		pendingStrip.replaceChildren();
		// Ready images already have their blue token in the input. Keep only
		// file chips and upload progress/retry controls above it.
		const visible = attachments.filter(piece => !piece.token || piece.error || (!piece.reference && !piece.image));
		pendingStrip.hidden = !visible.length;
		visible.forEach(piece => {
			const chip = el('button', null, 'entry-pending-chip');
			chip.type = 'button';
			chip.setAttribute('aria-label', piece.error ? `retry ${piece.name}` : `remove ${piece.name}`);
			if (!piece.reference && !piece.image) chip.classList.add('is-uploading');
			chip.append(el('span', piece.name));
			if (!piece.reference && !piece.image) chip.append(el('span', uploadPercent(piece.loaded, piece.total), 'entry-pending-progress'));
			if (piece.error) chip.append(el('span', 'failed · retry'));
			chip.onclick = () => piece.error ? void piece.retry() : dropAttachment(piece);
			if (piece.error) {
				const remove = el('button', '×', 'entry-pending-chip'); remove.type = 'button';
				remove.setAttribute('aria-label', `remove ${piece.name}`); remove.onclick = () => dropAttachment(piece);
				pendingStrip.append(remove);
			}
			pendingStrip.append(chip);
		});
	}
	function isImageFile(file) {
		const name = file.name || '';
		const type = file.type || '';
		return type.startsWith('image/') || (!type && /\.(png|jpe?g|gif|webp|bmp)$/i.test(name));
	}
	function captureUploadTarget() {
		const tab = state?.tabs?.find(tab => tab.focused);
		if (!tab || switching || choosing) throw new Error('wait for the selected session before attaching');
		return Object.freeze({ owner: ownerKey(selectedOwner), servingOwner: hereOwner() || LOCAL,
			tabId: tab.id, sessionId: tab.sessionId ?? null, instanceId: state.instanceId });
	}
	async function attachPersonal(file, origin = editorKey(state), target = captureUploadTarget()) {
		if (attachments.length >= 8) { fail(new Error('attach at most 8 files')); return; }
		if (file.size > MAX_UPLOAD_BYTES) { fail(new Error(`${file.name || 'file'} is larger than 1 GB`)); return; }
		const piece = { name: file.name || (isImageFile(file) ? 'image' : 'file'),
			kind: isImageFile(file) ? 'image' : 'file', loaded: 0, total: file.size || 0,
			imageUrl: isImageFile(file) ? URL.createObjectURL(file) : null };
		const key = canonicalEditorKey(origin);
		if (key === editorKey(state)) {
			attachments.push(piece); if (piece.imageUrl) insertImageToken(piece);
		} else {
			const draft = queueDrafts.get(key) ?? storedDraft(key);
			queueDrafts.set(key, { ...draft, attachments: [...draft.attachments, piece] });
		}
		piece.retry = async () => {
			if (piece.controller && !piece.controller.signal.aborted && !piece.error) return;
			piece.error = null; piece.loaded = 0; piece.controller = new AbortController(); paintPending();
			try {
				const saved = await postUpload(file, { ...target, signal: piece.controller.signal,
					onProgress(loaded, total) { piece.loaded = loaded; piece.total = total || piece.total; paintPending(); } });
				piece.reference = saved.reference; piece.loaded = saved.size ?? piece.total;
			} catch (error) {
				if (error.name !== 'AbortError') { piece.error = error; fail(error); }
			} finally { saveDraft(); paintPending(); hooks.onDraftChange?.(); }
		};
		await piece.retry();
		return piece;
	}
	async function attachFile(file) {
		if (switching) { fail(new Error('Wait for owner selection before attaching files')); return; }
		attachmentProcessing++;
		try {
			// A file attached to a fresh session makes it, then goes to it.
			if (choosing && !await materialize()) return;
			return await attachFileCaptured(file);
		} finally { attachmentProcessing--; }
	}
	async function attachFileCaptured(file) {
		if (!file) return;
		const target = captureUploadTarget(), origin = editorKey(state);
		// Keep imported recordings as ordinary file attachments as well as
		// hearing their words. Transcription reuses this upload, even on retry.
		const piece = await attachPersonal(file, origin, target);
		if (!isVoiceFile(file) || !piece?.reference) return;
		return voice.transcribe(file, (text, target) => {
			const pieces = canonicalEditorKey(origin) === editorKey(state) ? attachments : queueDrafts.get(canonicalEditorKey(origin))?.attachments;
			if (!pieces?.includes(piece)) throw new Error('the audio attachment was removed; no words were added');
			const owner = ownerKey(target.owner);
			const snapshot = owner === ownerKey(selectedOwner) ? state : transports.get(owner === ownerKey(LOCAL) ? LOCAL : owner)?.snapshot;
			const tab = snapshot?.tabs?.find(tab => tab.id === target.tabId);
			if (!tab || (target.sessionId != null ? tab.sessionId !== target.sessionId : !target.instanceId || target.instanceId !== snapshot.instanceId)) throw new Error('the recording’s original session is no longer open; no words were added');
			const key = draftTargetKey(owner, target);
			if (!switching && key === editorKey(state)) insertWords(text);
			else {
				const draft = queueDrafts.get(key) ?? storedDraft(key);
				queueDrafts.set(key, restoreQueueItem(draft, { text }));
			}
		}, { target, reference: piece.reference });
	}
	filesInput.addEventListener('change', async () => {
		const chosen = [...(filesInput.files ?? [])];
		filesInput.value = '';
		await Promise.all(chosen.map(attachFile));
		paintPending();
	});
	async function attachFiles(list) {
		const files = [...(list ?? [])].filter(Boolean);
		if (!files.length) return;
		await Promise.all(files.map(attachFile));
		paintPending();
		hooks.onDraftChange?.();
	}
	async function filesFromAsyncClipboard() {
		if (!navigator.clipboard?.read) return [];
		try {
			return await filesFromClipboardItems(await navigator.clipboard.read());
		} catch {
			return [];
		}
	}
	async function ingestPaste(event) {
		if (switching) return;
		attachmentProcessing++;
		try { await ingestPasteCaptured(event); } finally { attachmentProcessing--; }
	}
	async function ingestPasteCaptured(event) {
		if (wm.owns(event.target) || clipboardHasText(event.clipboardData)) return;
		const origin = editorKey(state);
		let files = filesFromClipboardData(event.clipboardData);
		if (!files.length) files = await filesFromAsyncClipboard();
		if (!files.length) return;
		event.preventDefault();
		if (canonicalEditorKey(origin) !== editorKey(state)) { fail(new Error('Session changed while reading clipboard; paste again')); return; }
		await attachFiles(files);
	}
	document.addEventListener('paste', event => { void ingestPaste(event); });

	let promptAccepting = 0;
	const acceptingPrompts = new Set();
	// A prompt that failed is kept with its request id until it goes through,
	// so sending it again cannot deliver it twice. It goes along through a
	// reload (prepareReload) rather than holding one up: a window that kept one
	// it was never sent again never took a new version.
	const PROMPT_RETRIES_KEY = 'imperfect.prompt-retries';
	const promptRetries = new Map();
	try {
		for (const [key, retry] of JSON.parse(sessionStorage.getItem(PROMPT_RETRIES_KEY) || '[]')) promptRetries.set(key, retry);
		sessionStorage.removeItem(PROMPT_RETRIES_KEY);
	} catch {}
	async function sendPrompt(fields) {
		const origin = editorKey(state), send = sessionCommand();
		acceptingPrompts.add(origin);
		const identity = { expectedSessionId: state?.sessionId, expectedTabId: focusedTabId() };
		const key = JSON.stringify({ owner: ownerKey(selectedOwner), ...fields, ...identity });
		const localKey = selectedOwner === LOCAL ? JSON.stringify({ owner: LOCAL, ...fields, ...identity }) : key;
		const retry = promptRetries.get(key) ?? promptRetries.get(localKey) ?? { requestId: crypto.randomUUID?.() ?? Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join(''), fields };
		promptRetries.set(key, retry);
		try {
			const result = await send('prompt', { ...retry.fields, ...identity, requestId: retry.requestId });
			if (result?.accepted === false) throw new Error(result.error || 'Prompt not accepted');
			promptRetries.delete(key); promptRetries.delete(localKey);
			return result;
		} finally { acceptingPrompts.delete(origin); promptAccepting--; }
	}
	function restoreFailedPrompt(text, sent, key) {
		key = canonicalEditorKey(key);
		if (choosing || key !== editorKey(state)) {
			const draft = queueDrafts.get(key) ?? { text: '', attachments: [], start: 0, end: 0 };
			queueDrafts.set(key, { ...draft, text: [text, draft.text].filter(Boolean).join('\n\n'), attachments: sent.concat(draft.attachments) });
			return;
		}
		input.value = [text, input.value].filter(Boolean).join('\n\n'); saveDraft(); hooks.onDraftChange?.();
		attachments = sent.concat(attachments); paintPending();
	}
	byId('entry-send').addEventListener('click', () => { void submit(); });
	async function submit(extra = {}) {
		if (choosing) return submitFresh(extra);
		if (switching || [...acceptingPrompts].some(key => canonicalEditorKey(key) === editorKey(state))) return { accepted: false, error: 'workspace unavailable' };
		transcriptScroller.latest();
		const text = input.value;
		if (attachments.some(piece => !piece.reference && !piece.image)) {
			fail(new Error('wait for the file to finish uploading'));
			return { accepted: false, error: 'uploading' };
		}
		const body = text.trim();
		if (!body && !attachments.length) return { accepted: false, error: 'empty' };
		const sent = attachments, sentKey = editorKey(state);
		// A fresh session's first prompt shows at once, and its bar goes down.
		const first = freshView() ? firstPrompt = { text: body || 'See attached.', at: Date.now(), key: sentKey } : null;
		promptAccepting++;
		attachments = []; paintPending();
		input.value = ''; saveDraft(); hooks.onDraftChange?.();
		unlockDoneSound(); notifications.ask();
		if (first) render();
		try {
			const data = await sendPrompt({ text: body || 'See attached.', attachments: sent.filter(piece => piece.reference).map(({ reference, kind }) => ({ reference, kind })), ...(sent.some(piece => piece.image) ? { images: sent.map(piece => piece.image).filter(Boolean) } : {}), ...extra });
			for (const piece of sent) if (piece.imageUrl) URL.revokeObjectURL(piece.imageUrl);
			return data && typeof data === 'object' ? { accepted: data.accepted !== false, ...data } : { accepted: true };
		} catch (error) {
			if (first && firstPrompt === first) { firstPrompt = null; render(); }
			restoreFailedPrompt(text, sent, sentKey); fail(error);
			return { accepted: false, error: error.message ?? String(error) };
		}
	}
	// The first prompt of a fresh session not yet made: the bar goes down at
	// once and what was asked shows while the session is made on the computer,
	// harness and model the picker names; then it is sent there, as if typed
	// in it. Not made, it is back in the bar as it was.
	async function submitFresh(extra) {
		if ((assemblyStep && assemblyStep !== 'done') || creating || materializing || switching) return { accepted: false, error: 'workspace unavailable' };
		const text = input.value, body = text.trim();
		if (!body) return { accepted: false, error: 'empty' };
		const first = firstPrompt = { text: body, at: Date.now(), key: null };
		input.value = ''; saveDraft(); hooks.onDraftChange?.();
		unlockDoneSound(); notifications.ask();
		promptAccepting++;
		render();
		let made = false;
		try { made = await materialize(); } finally { if (!made) promptAccepting--; }
		if (!made) {
			if (firstPrompt === first) firstPrompt = null;
			if (choosing) { input.value = [text, input.value].filter(Boolean).join('\n\n'); saveDraft(); hooks.onDraftChange?.(); }
			render(); focusChoice();
			return { accepted: false, error: choosing?.error || 'no session was started' };
		}
		const sentKey = editorKey(state);
		try {
			const data = await sendPrompt({ text: body, attachments: [], ...extra });
			return data && typeof data === 'object' ? { accepted: data.accepted !== false, ...data } : { accepted: true };
		} catch (error) {
			if (firstPrompt === first) firstPrompt = null;
			restoreFailedPrompt(text, [], sentKey); fail(error); render();
			return { accepted: false, error: error.message ?? String(error) };
		}
	}

	// A recording from the mic, sent as the prompt: whatever is in the input
	// bar goes first and is cleared, the computer serving this window hears the
	// rest on its execution computer (POST /dictate) and sends it to the session in
	// view, here or on another computer. Nothing sent: the bar gets back what
	// it had, and the mic keeps the recording (voice.js).
	const dictations = new WeakMap();
	function captureDictationTarget() {
		if (assemblyStep && assemblyStep !== 'done') throw new Error('Finish opening the computer before recording');
		// Speaking to a fresh session makes it first.
		if (choosing && !switching) return materialize().then(made => {
			if (!made) throw new Error(choosing?.error || 'no session was started; try again');
			return captureDictationTarget();
		});
		if (switching || choosing || disconnectedOwners.has(selectedOwner)) throw new Error('wait for the selected session to be ready before recording');
		const tab = state?.tabs?.find(tab => tab.focused);
		if (!tab) throw new Error('there is no tab in view to record for');
		// A fresh Claude (or Pi) tab can exist before its first session id.
		if (tab.sessionId == null && (typeof state.instanceId !== 'string' || !state.instanceId)) throw new Error('update imperfect on the session computer, or send a typed first message in this tab before recording');
		return Object.freeze({ owner: selectedOwner, machine: ownerKey(selectedOwner), tab: tab.id, session: tab.sessionId ?? null,
			instanceId: state.instanceId,
			requestId: crypto.randomUUID?.() ?? String(Math.random()).slice(2) });
	}
	function dictationTargetMatches(target, snapshot) {
		const tab = snapshot?.tabs?.find(tab => tab.id === target.tab);
		return Boolean(tab && (target.session != null ? tab.sessionId === target.session : target.instanceId && target.instanceId === snapshot.instanceId));
	}
	async function dictate(recording, target, signal) {
		if (!target) throw new Error('the recording has no destination; press Esc and record again');
		const sameOwner = ownerKey(selectedOwner) === ownerKey(target.owner);
		const snapshot = sameOwner ? state : transports.get(target.owner)?.snapshot;
		if (!dictationTargetMatches(target, snapshot)) throw new Error('the session this recording was made for is no longer open; press Esc to let the recording go');
		if (switching || choosing || disconnectedOwners.has(target.owner)) throw new Error('wait for the original recording session to reconnect, then retry');
		if (!sameOwner || focusedTabId() !== target.tab) throw new Error('this recording belongs to another tab or computer; return to its original tab to retry, or press Esc to let it go');
		let held = dictations.get(recording);
		if (!held) {
			if (attachments.some(piece => !piece.reference && !piece.image)) throw new Error('wait for the file to finish uploading');
			const text = input.value, sent = attachments;
			held = { text, sent, prompt: Object.freeze({
				tab: target.tab, session: target.session,
				...(target.session == null ? { instanceId: target.instanceId } : {}),
				text: text.trim(), attachments: sent.filter(piece => piece.reference).map(({ reference, kind }) => ({ reference, kind })),
				images: sent.map(piece => piece.image).filter(Boolean), requestId: target.requestId,
			}) };
			dictations.set(recording, held);
		}
		// Freeze the prefix, attachments and request id along with the audio.
		// A failed prefix is restored; retry takes only that prefix back out,
		// leaving anything newly typed/attached in the original tab alone.
		const { text, sent, prompt } = held, sentKey = editorKey(state);
		let removedText = '', removed = [];
		if (text && input.value === text) { removedText = text; input.value = ''; }
		else if (text && input.value.startsWith(text + '\n\n')) { removedText = text; input.value = input.value.slice(text.length + 2); }
		removed = attachments.filter(piece => sent.includes(piece));
		attachments = attachments.filter(piece => !sent.includes(piece));

		paintPending(); saveDraft(); hooks.onDraftChange?.();
		unlockDoneSound();
		transcriptScroller.latest();
		const first = freshView() ? firstPrompt = { text: text.trim() || 'Voice message', at: Date.now(), key: sentKey } : null;
		if (first) render();
		try {
			const uploadTarget = { owner: target.machine, servingOwner: hereOwner() || LOCAL,
				tabId: target.tab, sessionId: target.session, instanceId: target.instanceId };
			if (!held.audio) held.audio = (await postUpload(recording, { ...uploadTarget, signal })).reference;
			const answer = await useUpload('dictate', { ...prompt, audio: held.audio }, uploadTarget, { signal });
			for (const piece of sent) if (piece.imageUrl && !attachments.includes(piece)) URL.revokeObjectURL(piece.imageUrl);
			return answer;
		} catch (error) {
			if (first && firstPrompt === first) firstPrompt = null;
			// Lazy creation can give this very tab an id while HTTP is pending,
			// but a replacement host must not receive the old prefix or files.
			const originalSnapshot = ownerKey(selectedOwner) === ownerKey(target.owner) ? state : transports.get(target.owner)?.snapshot;
			if (target.session != null || target.instanceId === originalSnapshot?.instanceId) {
				const originalInView = ownerKey(selectedOwner) === ownerKey(target.owner) && focusedTabId() === target.tab && dictationTargetMatches(target, originalSnapshot);
				const originalTab = originalSnapshot?.tabs?.find(tab => tab.id === target.tab);
				const key = originalInView ? editorKey(state) : originalTab ? draftTargetKey(ownerKey(target.owner), { sessionId: target.session, tabId: target.tab, instanceId: target.instanceId }) : sentKey;
				restoreFailedPrompt(removedText, removed, key);
			}
			if (first) render();
			throw error;
		}
	}

	/* ---------------------------------------------------------- the cursor */
	// A block, the way the terminal draws one. A textarea cannot be told to
	// draw a block (no engine here honours caret-shape), so the text is
	// mirrored over itself with the native caret made transparent, and the
	// character the cursor is sitting on is painted in reverse. At the end of
	// the line the block sits on a space, as it does in the terminal.
	function mountCaret() {
		const wrap = el('span', null, 'entry-input-mirror');
		input.parentNode.insertBefore(wrap, input);
		wrap.append(input);
		// Shown only where the cursor is the system's own (focus.css).
		if (!input.placeholder) input.placeholder = brand.id === 'kinso' ? 'what do you want?' : 'Message';
		caretMirror = el('div', null, 'entry-caret-mirror');
		caretMirror.setAttribute('aria-hidden', 'true');
		wrap.append(caretMirror);
		// A long message scrolls inside the field; the drawn text scrolls with it.
		input.addEventListener('scroll', () => { if (caretMirror) caretMirror.scrollTop = input.scrollTop; });
	}
	function paintCaret() {
		if (!caretMirror) return;
		// A selection has its own highlight, so there the mirror steps aside. An
		// unfocused composer has no cursor, but its draft is still drawn here:
		// the field's own letters are transparent, so hiding the mirror made a
		// draft vanish whenever the phone's keyboard went down.
		const focused = document.activeElement === input;
		const collapsed = input.selectionStart === input.selectionEnd;
		caretMirror.hidden = focused && !collapsed;
		const value = input.value ?? '';
		const fragment = document.createDocumentFragment();
		const appendText = text => {
			for (const [i, part] of text.split(standIns()).entries()) {
				if (!part) continue;
				fragment.append(i % 2 ? el('span', part, 'entry-inline-attachment') : document.createTextNode(part));
			}
		};
		if (focused && collapsed) {
			const at = input.selectionStart ?? value.length;
			const char = value[at];
			const onNewline = char === undefined || char === '\n';
			appendText(value.slice(0, at));
			fragment.append(el('span', onNewline ? ' ' : char, 'entry-block-caret'));
			appendText(onNewline ? value.slice(at) : value.slice(at + 1));
		} else appendText(value);
		caretMirror.replaceChildren(fragment);
		caretMirror.scrollTop = input.scrollTop;
	}
	mountCaret();
	for (const name of ['input', 'keyup', 'click', 'focus', 'blur', 'scroll', 'select']) {
		input.addEventListener(name, paintCaret);
	}
	// Arrow keys and the mouse move the caret without firing `input`, and
	// `selectionchange` is the only event that covers every one of them.
	document.addEventListener('selectionchange', () => {
		if (document.activeElement === input) paintCaret();
	});
	// The composer is the terminal's standing keyboard target. Empty terminal
	// space returns the caret, and a printable key repairs drifted focus before
	// the browser dispatches that key to the newly focused input.
	// Only a click returns it, never a press: a press is also how text is
	// chosen, and taking the keys in the middle of that drag cleared what was
	// being chosen (Noah: "really difficult to select text in imperfect").
	// A click that chose nothing still brings the caret back.
	document.addEventListener('click', event => {
		if (!terminal?.contains(event.target) || wm.owns(event.target) || overlay || event.target.closest('button, input, textarea, select, a, [contenteditable="true"]')) return;
		if (event.detail > 1) return; // a double or triple click chooses a word or a line
		requestAnimationFrame(() => { if (!getSelection()?.toString()) input.focus({ preventScroll: true }); });
	});
	containChoosing(document);
	document.addEventListener('keydown', event => {
		if (wm.owns(document.activeElement) || overlay || document.activeElement === input || event.ctrlKey || event.metaKey || event.altKey || event.key.length !== 1) return;
		if (!hooks.canFocus?.() || event.target.closest?.('input, textarea, select, [contenteditable="true"], .screen-panel')) return;
		input.focus();
	}, { capture: true });
	input.addEventListener('beforeinput', event => {
		if (event.inputType !== 'deleteContentBackward' && event.inputType !== 'deleteContentForward') return;
		const start = input.selectionStart ?? 0;
		const end = input.selectionEnd ?? start;
		const probe = event.inputType === 'deleteContentBackward' ? Math.max(0, start - 1) : start;
		const tokens = [...input.value.matchAll(/\bimage \d+\b\s?/g)];
		const hit = tokens.find(match => {
			const from = match.index;
			const to = from + match[0].length;
			return start !== end ? start < to && end > from : probe >= from && probe < to;
		});
		if (!hit) return;
		event.preventDefault();
		const token = hit[0].trim();
		const piece = attachments.find(item => item.token === token);
		piece?.controller?.abort();
		if (piece?.imageUrl) URL.revokeObjectURL(piece.imageUrl);
		if (piece) attachments.splice(attachments.indexOf(piece), 1);
		input.setRangeText('', hit.index, hit.index + hit[0].length, 'end');
		input.dispatchEvent(new Event('input', { bubbles: true }));
		paintPending();
	});
	input.addEventListener('input', () => {
		// If a token is removed by a selection, cut, or replacement rather than a
		// single backspace, its hidden attachment must leave with it.
		for (const piece of [...attachments]) {
			if (!piece.token || input.value.includes(piece.token)) continue;
			piece.controller?.abort();
			if (piece.imageUrl) URL.revokeObjectURL(piece.imageUrl);
			attachments.splice(attachments.indexOf(piece), 1);
		}
		saveDraft(); paintCaret(); paintPending();
	});
	// The session chords live where the sessions live. MOD+Up and MOD+Down
	// step through the tabs, and the view follows: the conversation comes
	// into view with the keys.
	const sessionStep = step => { if (cycleTab(step)) wm.bring(); };
	registerKeyBinding({ label: `${MOD}+↑`, description: 'previous session', code: 'ArrowUp', mod: true, when: event => !event || !keysHeld(), handler: () => sessionStep(-1) });
	registerKeyBinding({ label: `${MOD}+↓`, description: 'next session', code: 'ArrowDown', mod: true, when: event => !event || !keysHeld(), handler: () => sessionStep(1) });
	for (let n = 1; n <= 5; n++) registerKeyBinding({ label: `${MOD}+${n}`, description: `session ${n} in the rail`, code: `Digit${n}`, mod: true, handler: () => enterNthTab(n) });
	registerKeyBinding({ label: `${MOD}+Space`, description: 'start a new session', code: 'Space', mod: true, handler: () => newTab().catch(fail) });
	registerKeyBinding({ label: `${MOD}+R`, description: 'speak a prompt (again to transcribe)', code: 'KeyR', mod: true, handler: () => voice.toggle() });
	// Before any reload: drafts of every conversation, the tab and the open
	// windows are kept, and come back after it.
	function prepareReload() {
		try {
			saveDraft();
			for (const [key, draft] of queueDrafts) if (key !== editorKey(state) && draft.text) localStorage.setItem(draftKey(key), draft.text);
			// The one layout's windows.
			const windows = wm.list().map(win => ({ kind: win.kind, at: win.kind === 'files' ? workbench.where() : pages.at(win) }));
			sessionStorage.setItem(SURFACE_VIEW_KEY, JSON.stringify({ tabId: focusedTabId(), owner: ownerKey(selectedOwner), windows, order: wm.order(), layout: wm.tiling(), oneLayout: LAYOUT_CHOICE }));
		} catch {}
		try { if (promptRetries.size) sessionStorage.setItem(PROMPT_RETRIES_KEY, JSON.stringify([...promptRetries])); } catch {}
	}
	// The desktop window's webview has no reload of its own; this is it, and
	// what was open comes back as it does after a new version.
	registerKeyBinding({ label: 'Ctrl+R', description: 'reload the window', code: 'KeyR', ctrl: true, handler: () => { prepareReload(); location.reload(); } });
	if (globalThis.imperfectDesk) {
		registerKeyBinding({ label: 'Ctrl+T', description: 'open a browser tab', code: 'KeyT', ctrl: true, handler: () => pages.newTab() });
		registerKeyBinding({ label: 'Ctrl+W', description: 'close the browser tab', code: 'KeyW', ctrl: true, when: () => ['browser', 'live'].includes(wm.focused()?.kind), handler: () => pages.closeFront() });
	}
	// The windows' keys (MOD is Super in the desktop window, Alt in a browser:
	// pi-card.js). MOD+W closes what is under the pointer, or failing
	// that what has the keys: in the browser the tab in front (the last takes
	// the browser with it); never Workbench or the conversation. MOD+Left and
	// MOD+Right bring the next window out of sight on that side into view
	// with the keys (windows.js navigate), without wrapping or reordering;
	// MOD+Up and MOD+Down are the session before and after. MOD+L tiles the
	// windows the other way (scrolling, dwindle). MOD held, a window can be
	// dragged to another's place (hold and release: the desktop window says
	// when MOD goes down and up inside a website). MOD+F
	// has the focused window fill the canvas, and back; in focus, the
	// conversation or the panel fills the whole window (Escape back too). With
	// another window full, MOD+Shift+Enter lays the agents' strip and the input
	// bar over it, and takes them away (Escape too); focus has neither it nor
	// MOD+Shift+F. MOD+Shift+Left and MOD+Shift+Right
	// move every window one slot along, bringing another into the focused
	// one. Electron hears them inside websites and pages too, and sends them here
	// (desktop/electron/main.mjs).
	const windowKeys = {
		newTab: () => pages.newTab(),
		closeTab: () => pages.closeFront(),
		browser: () => pages.launch(),
		close: () => wm.closeHovered() || wm.closeAt(document.activeElement),
		previous: () => wm.navigate(-1),
		next: () => wm.navigate(1),
		up: () => sessionStep(-1),
		down: () => sessionStep(1),
		full: () => wm.full(),
		fullWindow: () => wm.fullWindow(),
		restoreFullWindow: () => wm.restoreFullWindow(),
		over: () => wm.over(),
		back: () => wm.rotate(-1),
		along: () => wm.rotate(1),
		layout: () => wm.layout(),
		hold: () => wm.grab(true),
		release: () => wm.grab(false),
		clipboard: () => clipHistory.toggle(),
		...Object.fromEntries([1, 2, 3, 4, 5].map(n => [`session${n}`, () => enterNthTab(n)])),
	};
	globalThis.imperfectDesk?.onKey(key => { if (key === 'release' || !keysHeld()) windowKeys[key]?.(); });
	// The page listener serves projects on an isolated origin. Accept only
	// this narrow chord from the frame actually holding the keyboard, never
	// a background tab or another window's message. In the desktop window
	// Electron hears the chord before any frame does: a frame saying Alt
	// there is Alt, which imperfect leaves alone under sway.
	addEventListener('message', event => {
		const type = event.data?.type;
		const launch = type === 'imperfect-browser-launch';
		if (globalThis.imperfectDesk || (!launch && (!['imperfect-pane-step', 'imperfect-session-step'].includes(type) || ![-1, 1].includes(event.data.step))) || keysHeld()) return;
		const frame = document.activeElement;
		if (frame?.localName !== 'iframe' || frame.contentWindow !== event.source || !frame.closest('.wm-window')) return;
		if (launch) pages.launch();
		else if (type === 'imperfect-session-step') sessionStep(event.data.step);
		else wm.navigate(event.data.step);
	});
	// imperfect-open again, with this window already open (desktop/electron/main.mjs):
	// Workbench at the folder asked for, or a new session, as MOD+Space starts one.
	// A file or folder from the Mac's Finder or Dock (here) is this computer's.
	globalThis.imperfectDesk?.onOpen?.(({ face, path, here }) => face === 'files' ? openFiles(path || '', here ? { base: '' } : {}) : newTab().catch(fail));
	registerKeyBinding({ label: `${MOD}+Shift+M`, description: 'Messages: every conversation, newest first', code: 'KeyM', mod: true, shift: true, when: () => Boolean(messages) && !keysHeld(), handler: () => showMessages() });
	registerKeyBinding({ label: `${MOD}+Shift+B`, description: 'open or reveal the browser', code: 'KeyB', mod: true, shift: true, consumeRepeat: true, when: () => !keysHeld(), handler: windowKeys.browser });
	registerKeyBinding({ label: `${MOD}+${MOD === 'Super' ? 'Shift+' : ''}V`, description: 'what was copied, to copy again', code: 'KeyV', mod: true, shift: MOD === 'Super', when: event => clipHistory.available() && (!event || clipHistory.isOpen() || systemControls.isOpen() || !keysHeld()), handler: windowKeys.clipboard });
	registerKeyBinding({ label: `${MOD}+W`, description: 'close the browser tab in front, or the window under the pointer', code: 'KeyW', mod: true, handler: windowKeys.close });
	registerKeyBinding({ label: `${MOD}+←`, description: 'the next window out of sight on the left, with the keys', code: 'ArrowLeft', mod: true, consumeRepeat: true, when: event => !event || !keysHeld(), handler: windowKeys.previous });
	registerKeyBinding({ label: `${MOD}+→`, description: 'the next window out of sight on the right, with the keys', code: 'ArrowRight', mod: true, consumeRepeat: true, when: event => !event || !keysHeld(), handler: windowKeys.next });
	registerKeyBinding({ label: `${MOD}+L`, description: 'tile the windows focus, scrolling or dwindle', code: 'KeyL', mod: true, when: event => !event || !keysHeld(), handler: windowKeys.layout });
	registerKeyBinding({ label: `${MOD}+F`, description: 'focused window full screen, and back', code: 'KeyF', mod: true, handler: windowKeys.full });
	// Last, after anything nearer that wants Escape (a menu, a file open in Files).
	registerKeyBinding({ label: 'Esc', description: 'leave full screen', code: 'Escape', late: true, when: () => Boolean(wm.zoomed()) && !keysHeld(), handler: windowKeys.full });
	registerKeyBinding({ label: `${MOD}+Shift+F`, description: 'focused browser or Files covers the input bar, and back', code: 'KeyF', mod: true, shift: true, consumeRepeat: true, when: () => (phone() || wm.tiling() !== 'focus') && !keysHeld(), handler: windowKeys.fullWindow });
	registerKeyBinding({ label: 'Esc', description: 'restore the full-window pane', code: 'Escape', when: () => wm.fullWindowed() && !keysHeld(), handler: event => { event?.stopImmediatePropagation(); windowKeys.restoreFullWindow(); } });
	registerKeyBinding({ label: `${MOD}+Shift+Enter`, description: 'the agents and the input bar over a full-screen window, and away', code: 'Enter', mod: true, shift: true, when: () => wm.tiling() !== 'focus', handler: windowKeys.over });
	registerKeyBinding({ label: 'Esc', description: 'the agents and the input bar away', code: 'Escape', when: () => wm.overlaid() && !keysHeld(), handler: windowKeys.over });
	registerKeyBinding({ label: `${MOD}+Shift+←`, description: 'move the windows one place back', code: 'ArrowLeft', mod: true, shift: true, handler: windowKeys.back });
	registerKeyBinding({ label: `${MOD}+Shift+→`, description: 'move the windows one place along', code: 'ArrowRight', mod: true, shift: true, handler: windowKeys.along });
	// Up in an empty input bar takes the latest steering back to edit, as in
	// a chat; a line of it can also be clicked.
	registerKeyBinding({
		label: '↑', description: 'edit latest queued prompt (input bar empty)', code: 'ArrowUp', target: input,
		when: event => !event || (!choosing && !input.value && !attachments.length && Boolean(state?.queue?.items?.length) && !overlay),
		handler: () => takeQueue({ latest: true }),
	});
	registerKeyBinding({
		label: 'Ctrl+C', description: 'interrupt a running turn', code: 'KeyC', ctrl: true, target: input,
		when: () => !choosing && Boolean(state?.busy), handler: () => {
			const origin = editorKey(state);
			sessionCommand()('abort').then(q => applyQueue(q, origin)).catch(fail);
		},
	});
	registerKeyBinding({
		label: 'Esc', description: 'collapse the agents', code: 'Escape',
		// The desktop's sidebar stays; a phone's sheet goes, as choosing in it does.
		when: () => !railCollapsed && !overlay && (!railSidebar() || phone()),
		handler: () => setRailCollapsed(true),
	});
	registerKeyBinding({
		// One Escape, in the order a person means it: cancel what is being
		// chosen, close what is open, then stop the turn; with none of them,
		// it is left to whatever else wants it (leaving full screen).
		label: 'Esc', description: 'close or interrupt the agent', code: 'Escape', target: input,
		// A fresh session goes back to the one before it, whether or not the
		// sidebar is open; another session's turn is never stopped from it.
		when: () => Boolean(overlay) || (Boolean(choosing) && (railCollapsed || (railSidebar() && !phone()))) || (railCollapsed && Boolean(state?.busy)),
		handler: () => {
			if (overlay) { closeDialog(true); return; }
			if (choosing) { cancelChoosing(); return; }
			if (state?.busy) {
				const origin = editorKey(state);
				sessionCommand()('abort').then(q => applyQueue(q, origin)).catch(fail); return;
			}
		},
	});
	// Every submission steers at the next step, or starts an idle agent.
	registerKeyBinding({
		label: 'Enter', description: 'send, or steer while working', code: 'Enter', target: input,
		when: event => !event?.isComposing && !overlay, handler: () => submit(),
	});
	registerKeyBinding({
		label: `${MOD}+Enter`, description: 'send, or steer while working', code: 'Enter', mod: true, target: input,
		when: event => !event?.isComposing && !overlay,
		handler: () => submit(),
	});
	// The model name in the input bar opens the model box.
	modelName.onclick = () => { chooseModel().catch(fail); };

	// Where the person is: a window they use says so, to every computer it is
	// connected to, so an agent's browser opens where they are (browser.mjs).
	// Real use only, not being connected; at most every few seconds, saying
	// how long ago, so the latest use wins. Only a window that takes
	// websites: the desktop window, and the phone app.
	const surface = globalThis.imperfectDesk ? 'desktop' : globalThis.imperfectNative ? 'phone' : '';
	let usedAt = 0, toldAt = 0, telling = 0;
	function tellHere(owner) {
		if (surface && hereOwner()) ownerCommand(owner, 'here', { machine: hereOwner(), kind: surface, ago: Date.now() - usedAt }).catch(() => {});
	}
	function used() {
		if (!surface || document.hidden) return;
		usedAt = Date.now();
		telling ||= setTimeout(() => {
			telling = 0; toldAt = Date.now();
			for (const [owner, transport] of transports) if (transport.socket?.readyState === WebSocket.OPEN) tellHere(owner);
		}, Math.max(0, toldAt + 5000 - usedAt));
	}
	for (const type of ['keydown', 'pointerdown', 'wheel']) addEventListener(type, used, { capture: true, passive: true });
	addEventListener('focus', used);
	document.addEventListener('visibilitychange', used);
	addEventListener('pointerdown', unlockDoneSound);
	addEventListener('keydown', unlockDoneSound);
	addEventListener('resize', () => { if (socket?.readyState === WebSocket.OPEN) hello(); });
	// A tab left open in the background is not somebody using a computer, but it holds the socket
	// open, and the control plane reads an open socket as "in use" and keeps the machine awake --
	// which is how a forgotten tab bills a whole night. So a hidden tab lets go after a while and
	// reconnects the moment it is looked at again. Never mid-turn: the agent is doing work
	// somebody is waiting on, and dropping the socket there would abandon its output.
	const IDLE_TAB_MS = 5 * 60 * 1000;
	let hiddenTimer;
	function releaseIfStillHidden() {
		if (!document.hidden) return;
		if (state?.busy) { hiddenTimer = setTimeout(releaseIfStillHidden, 30_000); return; }
		try { socket?.close(1000, 'tab hidden'); } catch {}
	}
	// Looked at again: the window shown, the computer awake, the network back,
	// the phone app in front. What is on screen may be old and its socket dead
	// without knowing it (a phone's network goes with its screen, and TCP takes
	// minutes to say so). So every socket is asked at once, a dead one is
	// replaced, and the view is marked stale until it is shown to be current
	// (refreshView), whichever computer it is on; nothing waits for a timeout.
	//
	// Away for longer than the computer waits for an answer to its ping
	// (server.mjs: half a minute), a socket over the network has been dropped
	// at the far end whatever it reads here: it is replaced without asking.
	// On this computer's own desk it is asked all the same; that costs nothing.
	const ASLEEP_MS = 25_000, TICK_MS = 5000;
	let resumedAt = 0, hiddenSince = document.hidden ? Date.now() : 0, tickAt = Date.now();
	// A page frozen with its app (a phone's screen off) misses its ticks.
	setInterval(() => { tickAt = Date.now(); }, TICK_MS);
	function resume({ force = false } = {}) {
		if (document.hidden) return;
		// A desk window's focus comes and goes all day: once a second is plenty.
		if (!force && Date.now() - resumedAt < 1000) return;
		const now = resumedAt = Date.now();
		const away = Math.max(hiddenSince ? now - hiddenSince : 0, now - tickAt - TICK_MS);
		hiddenSince = 0; tickAt = now;
		void refreshMachines();
		// Doubted first: an answer to a question asked from here on is
		// evidence from after the doubt began (freshness.js), even within
		// the same millisecond's tick. A session asked for and not yet come
		// is still what is wanted.
		const doubt = freshness.state;
		if (doubt.phase !== 'fresh' && (doubt.want || switching)) freshness.stale({ owner: doubt.owner, want: doubt.want, restart: true });
		else doubtOwner(selectedOwner, { restart: true });
		// Each open socket is asked, the one a switch waits on included: a dead
		// one fails what waits on it at once, rather than in half a minute.
		for (const [owner, transport] of transports) {
			if (transport.socket?.readyState === WebSocket.OPEN && away >= ASLEEP_MS && !localDesktop()) transport.close();
			if (transport.socket?.readyState === WebSocket.OPEN) void transport.check({ fields: owner === LOCAL ? helloFields() : { kind: phone() ? 'phone' : 'viewer', machine: hereOwner(), visible: !launchPhone } });
			else if (owner === selectedOwner || owner === LOCAL || machineRows.some(m => m.id === owner && m.reachable)) transport.connect();
		}
	}
	document.addEventListener('visibilitychange', () => {
		clearTimeout(hiddenTimer);
		if (document.hidden) { hiddenSince ||= Date.now(); hiddenTimer = setTimeout(releaseIfStillHidden, IDLE_TAB_MS); return; }
		resume({ force: true });
	});
	addEventListener('focus', () => resume());
	addEventListener('online', () => resume({ force: true }));
	addEventListener('pageshow', () => resume({ force: true }));
	// The phone app (MainActivity.kt) and the desktop window (main.mjs) say so
	// too: a WebView's page does not always hear its app come back, nor a desk
	// window its computer wake.
	globalThis.imperfectResume = () => resume({ force: true });
	globalThis.imperfectDesk?.onResume?.(() => resume({ force: true }));
	mountAssembly({ apply: step => {
		assemblyStep = step;
		document.documentElement.dataset.assemblyStep = step;
		// This is a client-side blank page even when the computer has sessions.
		// Opening it never focuses, creates or changes a server-side tab.
		if (!choosing) choosing = { auto: false, agent: null, model: null, error: '', launch: true };
		if (!launchPhone && ASSEMBLY_STEPS.indexOf(step) >= ASSEMBLY_STEPS.indexOf('files') && !assemblyFiles) {
			assemblyFiles = true;
			void workbench.open('', { base: '', quiet: true });
			sidebarHooks.showFiles();
		}
		if (!launchPhone && ASSEMBLY_STEPS.indexOf(step) >= ASSEMBLY_STEPS.indexOf('browser') && !assemblyBrowser) {
			assemblyBrowser = true;
			void pages.assembleBrowser().catch(fail);
		}
		render();
	} });
	let assemblyFiles = false, assemblyBrowser = false;
	mountLaunchOpen({ open: url => pages.openShop(url), canOpen: () => assemblyStep === 'done', onError: fail });
	connect();

	function reloadSafe() {
		return !switching && !foregroundRequests && !attachmentProcessing && !promptAccepting && !queueTaking && !creating
			&& !voice.holding() && !workbench.unsaved()
			&& attachments.length === 0 && ![...queueDrafts.values()].some(draft => draft.attachments.length);
	}

	return {
		submit,
		ready: Promise.all([snapshotReady, refreshMachines()]),
		// Workbench, at a folder if one is named (a face=files window, or
		// a folder opened from elsewhere).
		openFiles,
		// MOD+Shift+F: Workbench focused.
		showFiles,
		// Messages, at an account or a conversation if one is named.
		showMessages,
		// A project's page, as its preview in Workbench opens it.
		openProject: (name, base) => pages.project(name, { base }),
		guiSnapshot,
		showSession,
		composerStatus: () => ({ attachments: attachments.length }),
		// A new version reloads the window as soon as nothing is in flight. What
		// the person had open comes back (prepareSurfaceReload): drafts are kept
		// per conversation already, and the tab and the open windows are kept here.
		// Picked files hold it, since they live only here, and so does a
		// recording the mic holds (being made, being sent, or not sent), and a
		// file being edited in Files until what was typed is saved.
		surfaceReloadSafe: reloadSafe,
		prepareSurfaceReload: () => prepareReload(),
		newTab,
		closeTab: (tabId, extra = {}) => (switching || disconnectedOwners.has(selectedOwner) ? Promise.reject(new Error('Execution selection unavailable; choose a session first')) : closeSession(tabId, selectedOwner, extra)),
		// The fold the rail's chevron drives, so a key can reach it too.
		toggleRail: () => setRailCollapsed(!railCollapsed),
		attachFiles,
	};
}
