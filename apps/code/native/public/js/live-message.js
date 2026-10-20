// The answer still being written, drawn so it flows rather than lands.
//
// One article is kept for it from one update to the next. Its markdown is cut
// into blocks where a blank line stands outside a code fence; a block already
// finished keeps its nodes, and only the block still being written is drawn
// again (Paseo's split-markdown-blocks, T3 Code's stable prefix). Nothing above
// the last line is ever replaced, so nothing on screen moves.
//
// The words come off the socket in lumps (one update every 40 ms or so,
// however many the model wrote in that time). They are let out on every frame
// instead, a share of what is waiting each time, so a burst catches up faster
// rather than landing at once (Paseo's paced reveal). A message first seen
// already long (a session entered mid-answer) is shown whole.
import { markdown } from './gui-transcript.js';

const REVEAL_MS = 150; // what is waiting is let out over about this long

// Nothing markdown() draws spans a blank line outside a fence, so each block
// draws alone exactly as it does inside the whole.
export function markdownBlocks(value) {
	const blocks = [];
	let block = [], fence = false;
	for (const line of String(value ?? '').split('\n')) {
		if (/^\s*```/.test(line)) fence = !fence;
		if (!fence && !line.trim()) { if (block.length) blocks.push(block.join('\n')); block = []; continue; }
		block.push(line);
	}
	if (block.length) blocks.push(block.join('\n'));
	return blocks;
}

// The text blocks of a message this can draw, or null for one it leaves to the
// whole renderer (pictures, an error).
function textsOf(message) {
	if (message?.role !== 'assistant' || !Array.isArray(message.content) || message.errorMessage) return null;
	if (message.content.some(b => !['text', 'thinking', 'toolCall'].includes(b?.type))) return null;
	return message.content.filter(b => b.type === 'text').map(b => b.text ?? '');
}

// `painted` is called after each frame's words are drawn, so the view can stay
// at the bottom in that same frame.
export function liveMessage(painted) {
	let article = null, blocks = [], texts = [], total = 0, shown = 0, frame = 0, at = 0;
	const cut = () => {
		let left = shown;
		return texts.map(text => {
			const n = Math.min(text.length, left); left -= n;
			// never half of a surrogate pair
			return n < text.length && /[\ud800-\udbff]/.test(text[n - 1] ?? '') ? text.slice(0, n - 1) : text.slice(0, n);
		});
	};
	const paint = () => {
		const next = cut().flatMap(markdownBlocks);
		let same = 0;
		while (same < blocks.length && same < next.length && blocks[same].text === next[same]) same++;
		for (const old of blocks.slice(same)) for (const n of old.nodes) n.remove();
		blocks = blocks.slice(0, same);
		for (const text of next.slice(same)) {
			const part = document.createDocumentFragment();
			markdown(part, text);
			blocks.push({ text, nodes: [...part.childNodes] });
			article.append(part);
		}
	};
	const tick = now => {
		frame = 0;
		const elapsed = Math.min(250, at ? now - at : 1000 / 60);
		at = now;
		const backlog = total - shown;
		shown += Math.min(backlog, Math.max(1, Math.ceil(backlog * elapsed / REVEAL_MS)));
		paint();
		painted();
		if (shown < total) frame = requestAnimationFrame(tick); else at = 0;
	};
	return {
		// The nodes for this message, or null when it is not one this draws.
		draw(message) {
			const next = textsOf(message);
			if (!next) { this.reset(); return null; }
			const before = cut().join('\u0000');
			texts = next;
			total = texts.reduce((n, text) => n + text.length, 0);
			if (!article) {
				article = document.createElement('article');
				article.className = 'gui-message gui-assistant gui-live';
				shown = total;
			} else if (!texts.join('\u0000').startsWith(before)) shown = total; // not a continuation: show it as it is
			shown = Math.min(shown, total);
			paint();
			if (shown < total && !frame) frame = requestAnimationFrame(tick);
			return blocks.length ? [article] : [];
		},
		reset() {
			if (frame) cancelAnimationFrame(frame);
			article = null; blocks = []; texts = []; total = shown = frame = at = 0;
		},
	};
}
