// Which face this window is, read before anything is painted.
//
// A window opened as `?face=code` is one app standing on its own rather than
// the whole canvas, and the stylesheets key off `html[data-face]` to say so.
// That means the attribute has to be set before the first paint, which is why
// this is a plain script in the head and not part of site.js -- site.js is a
// module, modules are deferred, and a deferred answer arrives after the page
// has already drawn itself as the wrong thing.
//
// It lives in a file rather than inline in the page because the machine sends
// `script-src 'self'`, which blocks inline scripts outright. As an inline
// script this never ran at all: every window came up as the full canvas, and
// `?face=` looked like it had never been wired.
(() => {
  try {
    const face = new URLSearchParams(location.search).get('face');
    if (face) document.documentElement.dataset.face = face;
  } catch { /* keep the ordinary canvas */ }
})();
