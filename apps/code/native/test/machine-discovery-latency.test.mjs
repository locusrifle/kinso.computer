import test from 'node:test';
import assert from 'node:assert/strict';
import { createMachines } from '../../../../system/machines.mjs';

const node = (id, os = 'linux') => ({ ID:id, DNSName:`${id}.example.ts.net.`, Online:true, OS:os });
const status = async () => ({ Self:node('laptop'), Peer:{ desktop:node('desktop'), slow:node('slow'), phone:node('phone','android') } });
const health = () => ({ ok:true, json:async () => ({ protocol:1, capabilities:['preferences'] }) });

test('pinned authority lookup never waits for unrelated computers or phones', {timeout:1000}, async () => {
  const calls=[];
  const machines=createMachines({status,fetchImpl:async url=>{calls.push(url);if(url.includes('desktop.'))return health();return new Promise(()=>{});}});
  const peer=await machines.peer('desktop');
  assert.equal(peer.id,'desktop');
  assert.deepEqual(calls,['https://desktop.example.ts.net/health']);
  assert.equal(await machines.peer('phone'),null);
  assert.equal(await machines.peer('https://untrusted.example'),null);
  assert.equal(calls.length,1);
});

test('inventory does not probe phones as execution backends', async () => {
  const calls=[];
  const machines=createMachines({status,fetchImpl:async url=>{calls.push(url);return health();}});
  assert.deepEqual((await machines.list()).map(x=>x.id),['laptop','desktop','slow']);
  assert.equal(calls.some(url=>url.includes('phone.')),false);
});

test('a node answering as another machine is not that machine', async () => {
  const machines=createMachines({status,fetchImpl:async()=>({ok:true,json:async()=>({protocol:1,owner:'laptop'})})});
  assert.equal(await machines.peer('desktop'),null);
});

test('an unreachable pinned authority remains unavailable, never falls back', async () => {
  const machines=createMachines({status,fetchImpl:async()=>{throw Error('offline');}});
  assert.equal(await machines.peer('desktop'),null);
});
