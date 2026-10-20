// Per serving computer/origin, written only by the person's layout chord.
// Version 2 brings every window back to focus once, leaving old choices behind.
// Reload snapshots use this same version so they cannot revive an old layout.
export const LAYOUT_CHOICE = 'imperfect.layout-choice.v2';
export const LAYOUTS = ['focus', 'scrolling', 'dwindle'];
export function initialLayout(choice, restored, native = false) {
  if (LAYOUTS.includes(choice)) return choice;
  if (native && LAYOUTS.includes(restored)) return restored;
  return 'focus';
}
