// The website owns the password before the boot and the film afterwards (launch.mjs).
import { createSequence } from '../boot/sequence.mjs?v=kinso-lift-2';
import { variant } from '../variant.mjs?v=kinso-lift-2';
import { WORD } from '../wordmark.mjs?v=kinso-lift-2';
const clock = () => window.__introClock ?? performance.now() / 1000;
const kinso = variant.id === 'kinso';
let lockDue = false;
const tell = type => window.dispatchEvent(new CustomEvent('imperfect:intro', {
  detail: { type: type.split(':')[0], at: clock(), contactSeconds: boot.intro.state().tau },
}));
const boot = createSequence({
  clock, fixed: () => window.__introClock !== undefined,
  wall: () => window.__introWall ?? Date.now() / 1000,
  ...(kinso ? { ink: '#30302e' } : {}),
  // Kinso's logo stays and shrinks as the password wakes, on the shared field-in mark.
  // Do not change native boot timing.
  tell: type => { if (!kinso || type !== 'complete') tell(type); },
  onFrame: (_t, state) => {
    if (kinso && !lockDue && state.started && state.tau >= WORD.gone) { lockDue = true; tell('complete'); }
  },
});
export const { intro, ready, skyReady } = boot;
