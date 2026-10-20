// Checks the server makes on a command before running it. No DOM, no network.

export function staleCommandError(c, snap = {}) {
	if (!c || (c.expectedSessionId == null && c.expectedTabId == null)) return null;
	const focused = (snap.tabs ?? []).find(tab => tab.focused);
	const focusedId = focused?.id ?? null;
	if (['prompt', 'queue-take', 'dialog', 'model', 'level', 'abort', 'codex-reset-consume'].includes(c.type)) {
		if (c.expectedSessionId != null && c.expectedSessionId !== snap.sessionId) return 'session changed';
		if (c.expectedTabId != null && focusedId != null && c.expectedTabId !== focusedId) return 'session changed';
	}
	if (c.type === 'tab-close' || c.type === 'tab-focus') {
		if (c.expectedTabId != null && c.tabId != null && c.expectedTabId !== c.tabId) return 'session changed';
		if (c.expectedSessionId != null) {
			const target = (snap.tabs ?? []).find(tab => tab.id === c.tabId);
			if (target?.sessionId && target.sessionId !== c.expectedSessionId) return 'session changed';
		}
	}
	return null;
}

export function tabCloseBusyError(c, snap = {}) {
	if (c?.type !== 'tab-close') return null;
	const target = (snap.tabs ?? []).find(tab => tab.id === c.tabId);
	if (target?.busy && !c.closeConfirmed) return 'tab is busy';
	return null;
}
