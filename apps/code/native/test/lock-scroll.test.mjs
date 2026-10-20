import test from 'node:test';
import assert from 'node:assert/strict';
import {createMomentum} from '../../../../website/boot/scroll.mjs';
import {readFileSync} from 'node:fs';
test('lock release carries through with exponential decay; reverse replaces velocity', () => {
 const m=createMomentum(); m.input(20,0); m.input(20,.04);
 const a=m.step(.2,.04), b=m.step(.24,.04); assert.ok(a>b && b>0);
 m.input(-10,.25); assert.ok(m.step(.4,.04)<0);
 m.cancel(); assert.equal(m.step(1,.1),0);
});
test('native declining wheel tail gets no second synthetic fling', () => {
 const m=createMomentum(); for(const [i,n] of [40,30,20,10,4].entries())m.input(n,i*.03);
 assert.equal(m.step(.4,.1),0);
});
test('touch only flings after release and cancellation kills it', () => {
 const m=createMomentum();m.input(20,0,true);m.input(20,.04,true);
 assert.equal(m.step(.3,.04),0);m.release();assert.ok(m.step(.34,.04)>0);
 m.cancel();assert.equal(m.step(.5,.04),0);
});
test('lock keeps website unchanged, removes frame, and the world comes in the moment the bubble bursts, no pause',()=>{
 const s=readFileSync(new URL('../../../../website/boot/sequence.mjs',import.meta.url),'utf8');
 assert.doesNotMatch(s,/WORLD_ENTER/);assert.match(s,/rv\.popAt = t; S\.phase = 'opening';\n\}/); // the wallpaper is already inside the bubble when it opens
 assert.doesNotMatch(s,/bindScrollInput|buildRect|buildDots|ink.draw/);
 assert.match(s,/px \* 5/);assert.match(s,/momentum.cancel\(\);\n  S.phase = 'bubble'/);
});
