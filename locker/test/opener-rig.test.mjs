import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LOCUS, START, VAITA } from '../../website/opener/cast.mjs';
import { chainWeights, createPainting, deformPoint, swayWeight } from '../../website/opener/rig.mjs';
import { CONTACT, POSE_FROM, timeline } from '../../website/opener/timeline.mjs';
import manifest from '../../website/opener/assets/manifest.mjs';

// The parent wires this into the timeline/opener: heavier wool moves less than Vaita's robe,
// with the same slow oscillation and exact settle at contact.
const coatPose = (p, t = 0) => {
  const state = timeline(p, t);
  return { ...state.locus, sway: { ...state.vaita.sway, amp: state.vaita.sway.amp * (4.5 / 7) } };
};
function painting() {
  const previous = globalThis.document;
  globalThis.document = { createElement() {
    return { getContext() { return {
      drawImage() {},
      // Conservatively include every cell, even transparent ones, to exercise the real mesh builder.
      getImageData: () => ({ data: new Uint8ClampedArray(manifest.locus.crop[2] * manifest.locus.crop[3] * 4).fill(255) }),
    }; } };
  } };
  try { return createPainting(LOCUS, {}, manifest.locus.crop); }
  finally { globalThis.document = previous; }
}

test('original skeleton weights have no added held-object mask', () => {
  assert.equal(LOCUS.keep, undefined);
  const rig = painting();
  try {
    for (let v = 0; v < rig.n; v++) {
      const p = rig.rest.slice(v * 2, v * 2 + 2);
      assert.deepEqual(rig.weights[v], LOCUS.chains.map(chain => chainWeights(chain, p)));
    }
    assert.deepEqual(LOCUS.chains[1].keep, [{ at: [398, 468], r: [78, 70] }]);
  } finally { rig.dispose(); }
});

test('the original front-leg bend is retained, held objects stay put, and the hip cut has no jump', () => {
  const rig = painting();
  try {
    // the bend at its fullest, the original start angles (the opener now begins part-way, at POSE_FROM)
    const pose = { ...timeline(0).locus, chains: { arm: START.locus.arm, leg: START.locus.leg } };
    for (const p of [[540, 585], [520, 675], [470, 735]]) {
      const moved = rig.deform(pose, ...p);
      assert.ok(Math.hypot(moved[0] - p[0], moved[1] - p[1]) > 20, `leg moves at ${p}`);
    }
    for (const p of [[490, 480], [510, 510], [530, 470], [410, 480]]) {
      assert.deepEqual(rig.deform(pose, ...p), p, `torso stays at ${p}`);
    }
    const leg = LOCUS.chains.find(c => c.name === 'leg');
    assert.equal(leg.soft, 12, 'keep the previous bend rather than narrowing its trouser region');
    assert.deepEqual(leg.region.slice(0, 6), [[392, 552], [446, 540], [500, 526], [552, 510], [606, 488], [648, 540]]);
    let previous;
    for (let y = 560; y <= 620; y += 0.25) {
      const p = [445, y], weights = chainWeights(leg, p, LOCUS.keep);
      const moved = deformPoint({ chains: [leg] }, [weights], 0, { chains: { leg: pose.chains.leg } }, ...p);
      if (previous) assert.ok(Math.hypot(moved[0] - previous[0], moved[1] - previous[1]) < 1.5);
      previous = moved;
    }
  } finally { rig.dispose(); }
});

test('coat tails flutter gently over time without moving torso, carrying arm, head, wand or trousers', () => {
  const rig = painting();
  try {
    for (const p of [[180, 610], [220, 600], [250, 640], [275, 650]]) {
      assert.ok(swayWeight(LOCUS, p) > 0.4, `tail has weight at ${p}`);
      const a = rig.deform(coatPose(0, 0), ...p), b = rig.deform(coatPose(0, 2), ...p);
      assert.ok(Math.hypot(a[0] - b[0], a[1] - b[1]) > 1, `visible flutter at ${p}`);
      assert.ok(Math.hypot(a[0] - p[0], a[1] - p[1]) < 5, `gentle flutter at ${p}`);
    }
    for (const p of [[490, 480], [510, 510], [530, 515], [410, 550],
      [330, 480], [345, 520], [355, 550], [518, 316], [658, 357], LOCUS.tip,
      [540, 585], [520, 675], [470, 735], [250, 735], [320, 700]]) {
      assert.equal(swayWeight(LOCUS, p), 0, `protected paint at ${p}`);
      // Arms and front leg retain their independent articulated motion, never coat flutter.
      const baseline = rig.deform(timeline(0).locus, ...p);
      for (const t of [0, 2, 7, 17]) assert.deepEqual(rig.deform(coatPose(0, t), ...p), baseline);
    }
  } finally { rig.dispose(); }
});

test('coat sway fades smoothly and holds the exact contact painting at every time', () => {
  const rig = painting();
  try {
    for (const t of [0, 2, 17, 100]) {
      assert.ok(coatPose(CONTACT - 0.001, t).sway.amp < 0.00003);
      for (const p of [CONTACT, 0.78, 1]) {
        const pose = coatPose(p, t);
        assert.equal(pose.sway.amp, 0);
        for (let v = 0; v < rig.n; v++) {
          const rest = rig.rest.slice(v * 2, v * 2 + 2);
          assert.deepEqual(rig.deform(pose, ...rest), rest);
        }
      }
    }
  } finally { rig.dispose(); }
});

test('contact is the exact source painting for both characters and every mesh vertex', () => {
  const state = timeline(CONTACT, 17), rig = painting();
  try {
    for (const def of [LOCUS, VAITA]) {
      const pose = state[def.name];
      for (const p of [def.tip, ...def.chains.flatMap(c => c.joints.map(j => j.at))]) {
        const weights = def.chains.map(c => chainWeights(c, p, def.keep));
        assert.deepEqual(deformPoint(def, weights, 0, pose, ...p), p);
      }
    }
    rig.pose(state.locus);
    for (let v = 0; v < rig.n; v++) {
      assert.deepEqual(rig.deform(state.locus, ...rig.rest.slice(v * 2, v * 2 + 2)), rig.rest.slice(v * 2, v * 2 + 2));
    }
    assert.deepEqual(LOCUS.tip, manifest.contact);
    assert.deepEqual(VAITA.tip, manifest.contact);
  } finally { rig.dispose(); }
});

test('the figures start from the pose they used to reach 40% of the way in, the wand arm level (Noah, 12 Oct)', () => {
  assert.equal(POSE_FROM, 0.4 / CONTACT);
  const left = (q, a, b) => { const t = Math.min(1, Math.max(0, (q - a) / (b - a))); return 1 - t * t * (3 - 2 * t); };
  const start = timeline(0);
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);
  near(start.locus.chains.arm[0], START.locus.arm[0] * left(POSE_FROM, 0.04, 0.86));
  near(start.locus.chains.leg[0], START.locus.leg[0] * left(POSE_FROM, 0, 0.82));
  near(start.vaita.chains.arm[0], START.vaita.arm[0] * left(POSE_FROM, 0.08, 0.9));
  assert.ok(start.locus.chains.arm[0] < START.locus.arm[0] / 2, 'the wand arm starts raised to level, not down by his side');
  for (const who of ['locus', 'vaita']) assert.ok(start[who].travel === 1, 'the drift still starts from the first scroll');
  const contact = timeline(CONTACT);
  for (const who of ['locus', 'vaita']) {
    for (const angles of Object.values(contact[who].chains)) for (const a of angles) assert.ok(a === 0);
    assert.ok(contact[who].roll === 0 && contact[who].yaw === 0, 'the contact frame is still exactly the painting');
  }
});
