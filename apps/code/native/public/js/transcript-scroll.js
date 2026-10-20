// Follow layout growth only until the reader deliberately leaves the latest output.
export function transcriptScroll(output) {
	let following = true;
	let userScroll = false;
	let frame = 0;
	let writtenTop = 0;
	const bottom = () => { output.scrollTop = output.scrollHeight; writtenTop = output.scrollTop; };
	const atBottom = () => output.scrollHeight - output.clientHeight - output.scrollTop < 2;
	const schedule = () => {
		if (frame || !following) return;
		frame = requestAnimationFrame(() => {
			frame = 0;
			if (following) bottom();
		});
	};
	const interrupt = () => { userScroll = true; following = false; };
	const finishGesture = () => {
		if (atBottom()) { userScroll = false; following = true; schedule(); }
	};
	output.addEventListener('wheel', event => {
		if (event.deltaY < 0 || !atBottom()) interrupt();
	}, { passive: true });
	output.addEventListener('touchstart', interrupt, { passive: true });
	output.addEventListener('pointerdown', interrupt, { passive: true });
	// A tap/click without scrolling must not turn off following at the bottom.
	output.addEventListener('pointerup', finishGesture, { passive: true });
	output.addEventListener('touchend', finishGesture, { passive: true });
	output.addEventListener('keydown', event => {
		if (event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
		if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) interrupt();
	});
	output.addEventListener('scroll', () => {
		// Layout and replaceChildren can themselves dispatch scroll events. Only
		// an explicit reader gesture may change the follow policy.
		// Native scrollbar drags need not dispatch pointer events to the element.
		// Growth leaves the offset unchanged; clamping on shrink lands at bottom.
		if (following && output.scrollTop < writtenTop && !atBottom()) interrupt();
		if (userScroll) following = atBottom();
	}, { passive: true });
	// What can move the bottom: the transcript changing (every render is a
	// mutation), the box itself changing size, a picture or a font arriving.
	new ResizeObserver(schedule).observe(output);
	new MutationObserver(schedule).observe(output, { childList: true, subtree: true, characterData: true });
	output.addEventListener('load', schedule, true);
	// A message coming on screen is laid out then (content-visibility), and
	// takes its real height.
	output.addEventListener('contentvisibilityautostatechange', schedule, true);
	document.fonts?.addEventListener('loadingdone', schedule);
	window.addEventListener('resize', schedule);
	schedule();
	return {
		latest() { userScroll = false; following = true; schedule(); },
		// Words drawn in a frame of their own: kept at the bottom in that frame,
		// and a reader elsewhere is left alone (writing the offset would stop a
		// fling).
		pin() { if (following) bottom(); },
		rendered(previousTop) {
			if (following) { userScroll = false; bottom(); schedule(); }
			else output.scrollTop = previousTop;
		},
	};
}
