import { FIELD_IN } from '../wordmark.mjs?v=kinso-lift-2';

// The held logo is the identity. Share the password's wake clock, including interrupted wakes and Reduce Motion.
export function logoLock(word, screen) {
  return {
    wakeMs: FIELD_IN * 1000,
    identity: { logo: true },
    onwake(progress) {
      if (!word) return;
      const height = globalThis.visualViewport?.height ?? innerHeight;
      const offset = globalThis.visualViewport?.offsetTop ?? 0;
      const width = parseFloat(word.style.width), h = parseFloat(word.style.height);
      const top = parseFloat(word.style.top), left = parseFloat(word.style.left);
      if (![width, h, top, left].every(Number.isFinite)) return;
      const centre = top + h / 2;
      const target = offset + (height < 540 ? height * .53 : height / 2 - 24);
      const scale = 1 - .25 * progress;
      const dy = (target - centre) * progress;
      word.style.scale = String(scale);
      // Centre on the screen, not on the slightly offset optical image box.
      word.style.translate = `${(innerWidth / 2 - left - width / 2) * progress}px ${dy}px`;
      screen.style.setProperty('--kinso-field-top', `${centre + dy + h * scale / 2 + 22 - offset}px`);
    },
  };
}
