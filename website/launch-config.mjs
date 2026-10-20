// Static configuration. Which computer the launch ends in is not here: the lock's password decides, and the locker
// says where (locker/site-locks.mjs, from a private file), so no workbench's address is in the site's source.
export const config = Object.freeze({
  // The film the QuickTime window plays after the unlock (macos/launch.mjs): Noah's three variations, glued end to end.
  quicktimeFilm: Object.freeze({ url: new URL('media/kinso-variations.mp4?v=1fac0608', import.meta.url).href, title: 'kinso-variations.mp4' }),
  // The website's film, if it has one: packed side by side (picture | matte), composited over the existing backdrop (film.mjs);
  // its address is media/<film>.mp4?v=<hash> resolved against import.meta.url. null: no film, and the unlock goes
  // straight to the Mac over the wallpaper (launch.mjs). The last was the v8 trailer ("let's begin."), archived; git has it.
  videoUrl: null,
  // Required: the REAL product emits this only when its connected UI is usable.
  // Navigation/load (including refused/auth frames) can never establish readiness.
  demoReadyType: 'imperfect:demo-ready',
  mediaTimeoutMs: 20000,
  demoTimeoutMs: 15000,
  fadeMs: 650,
  // While the film plays, the real product mounts hidden once this much film has
  // actually played with this much buffered ahead, so it is usually verified by
  // the end. Then film-out and product-in share one window (0 with reduced motion).
  preloadAfterS: 10,
  preloadAheadS: 15,
  handoffMs: 1200,
  // Unlocked: the lock and its wallpaper fade away from the painting (0 with reduced motion).
  unlockMs: 600,
  // A one-word hint ("scroll") if the visitor has not moved them this long after the unlock. false removes it.
  scrollHint: true,
  hintAfterMs: 4000,
});
