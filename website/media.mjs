// Small DOM-independent helpers, also tested in Node.
export function demoAddress(value, base) {
  const url = new URL(value, base);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))) {
    throw new Error('Demo URL must be HTTPS (or loopback HTTP), without credentials');
  }
  return url;
}
export function isDemoReady(event, frame, url, type) {
  return Boolean(type && event.source === frame.contentWindow && event.origin === url.origin && event.data?.type === type);
}
export function waitForMedia(video, { timeoutMs = 20000, signal } = {}) {
  return new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      for (const name of ['loadeddata', 'canplay']) video.removeEventListener(name, check);
      video.removeEventListener('error', fail);
      signal?.removeEventListener('abort', abort);
    };
    const finish = error => { cleanup(); error ? reject(error) : resolve(); };
    const check = () => { if (video.readyState >= 2) finish(); };
    const fail = () => finish(new Error('The launch film could not load'));
    const abort = () => finish(new DOMException('Cancelled', 'AbortError'));
    if (signal?.aborted) return abort();
    if (video.error) return fail();
    if (video.readyState >= 2) return finish();
    for (const name of ['loadeddata', 'canplay']) video.addEventListener(name, check);
    video.addEventListener('error', fail);
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => finish(new Error('The launch film is taking too long to load')), timeoutMs);
  });
}
// Invoke synchronously inside the initial user gesture, on the SAME video element.
// Use muted, not volume=0 (which is not reliable on iOS). This does NOT grant
// later audible autoplay: callers must retain the explicit Play-button fallback.
export function primeVideo(video, { isCurrent = () => true } = {}) {
  const muted = video.muted;
  video.muted = true;
  let pending;
  try { pending = video.play(); } catch (error) { if (isCurrent()) video.muted = muted; return Promise.reject(error); }
  return Promise.resolve(pending).then(() => {
    if (isCurrent()) { video.pause(); video.currentTime = 0; }
  }).finally(() => { if (isCurrent()) video.muted = muted; });
}
export function playVideo(video, { timeoutMs = 20000, signal } = {}) {
  // The play() call itself is synchronous so a Play-button gesture is retained.
  let playing;
  try { playing = video.play(); } catch (error) { return Promise.reject(error); }
  return new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    const finish = error => { cleanup(); error ? reject(error) : resolve(); };
    const abort = () => finish(new DOMException('Cancelled', 'AbortError'));
    if (signal?.aborted) { Promise.resolve(playing).catch(() => {}); return abort(); }
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => finish(new Error('The launch film did not start in time')), timeoutMs);
    Promise.resolve(playing).then(() => finish(), finish);
  });
}
export function firstVideoFrame(video, timeoutMs = 250) {
  return new Promise(resolve => {
    let handle;
    const finish = () => { clearTimeout(timer); if (handle !== undefined) video.cancelVideoFrameCallback?.(handle); resolve(); };
    const timer = setTimeout(finish, timeoutMs);
    if (video.requestVideoFrameCallback) handle = video.requestVideoFrameCallback(finish);
    else requestAnimationFrame(finish);
  });
}
export const fadeDuration = (reduced, duration) => reduced ? 0 : duration;
// Preload the product only once the film has really played `afterS` seconds
// (media time: a stall, pause or hidden tab never counts) and is playing with at
// least `aheadS` seconds buffered beyond the playhead, or through to its end.
export function preloadDue(video, { afterS = 10, aheadS = 15 } = {}) {
  if (video.paused || video.ended || video.readyState < 3 || !(video.currentTime >= afterS)) return false;
  const now = video.currentTime, slack = 0.5;
  const need = Math.min(aheadS, (Number.isFinite(video.duration) ? video.duration : Infinity) - now);
  const ranges = video.buffered;
  for (let i = 0; i < (ranges?.length ?? 0); i++) {
    if (ranges.start(i) <= now + slack && ranges.end(i) >= now + need - slack) return true;
  }
  return false;
}
