import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import {
  createSystemControls, loopbackPeerUid, lsofPeerUid, parseBluetoothDevices, parseBluetoothShow, parseBrightness, parseConnections,
  parseDevices, parseRadio, parseUpower, parseVolume, parseWifiList, parseWpctlStatus, refusal, runTool, terse,
} from '../../../system/controls.mjs';
import { createGueyServer } from '../../../system/server.mjs';

import { fixture, recordedComputer } from './fixtures/system/computer.mjs';

async function serve(t, handle) {
  const server = createServer(async (req, res) => { if (!await handle(req, res, new URL(req.url, 'http://x').pathname)) res.writeHead(418).end(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}
const post = (base, body) => fetch(`${base}/system`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const owner = { refuse: async () => '' };

test('nmcli terse lines split on bare colons only', () => {
  assert.deepEqual(terse(' :Cafe\\: free wifi:41:'), [' ', 'Cafe: free wifi', '41', '']);
  assert.deepEqual(terse('*:a\\\\b:9:WPA2'), ['*', 'a\\b', '9', 'WPA2']);
});

test('the laptop\'s Wi-Fi: device, radio, one row per network, hidden ones out, the one in use first', async () => {
  assert.deepEqual(parseDevices(await fixture('laptop', 'nmcli-device.txt'))[0], { device: 'wlp192s0', type: 'wifi', state: 'connected', connection: 'home' });
  assert.deepEqual(parseRadio(await fixture('laptop', 'nmcli-radio.txt')), { hardware: true, enabled: true });
  assert.deepEqual(parseRadio('disabled:enabled\n'), { hardware: false, enabled: true });
  const networks = parseWifiList(await fixture('laptop', 'nmcli-wifi.txt'));
  assert.deepEqual(networks.map(n => n.ssid), ['home', 'Neighbour0895C8', 'Cafe: free wifi', 'Aussie Broadband 4222', 'BV Home backup', 'Office', 'orbit']);
  assert.deepEqual(networks[0], { ssid: 'home', signal: 74, security: 'WPA2', secured: true, enterprise: false, active: true });
  assert.equal(networks.find(n => n.ssid === 'Cafe: free wifi').secured, false);
  assert.equal(networks.find(n => n.ssid === 'Office').enterprise, true);
  assert.deepEqual(parseConnections(await fixture('laptop', 'nmcli-connections.txt')).filter(c => c.type === '802-11-wireless').map(c => c.name), ['home', 'Galaxy S22 C2C3', 'orbit']);
});

test('Bluetooth: the controller, or none; devices named or called by their address', async () => {
  assert.deepEqual(parseBluetoothShow(await fixture('laptop', 'bt-show.txt')), { address: '7C:FA:80:00:00:01', name: 'laptop', powered: true, discovering: false });
  assert.equal(parseBluetoothShow('No default controller available\n'), null);
  const devices = parseBluetoothDevices(await fixture('laptop', 'bt-devices.txt'));
  assert.deepEqual(devices.map(d => [d.name, d.named]), [['OpenComm2 by Shokz_II', true], ['ZV-E10', true], ['5C-44-3E-00-00-12', false], ['WH-1000XM4', true]]);
  assert.deepEqual(parseBluetoothDevices(await fixture('desktop', 'bt-devices.txt')), []);
});

test('wpctl: outputs and inputs with the default marked, a headset\'s mic filter included, video ignored', async () => {
  const laptop = parseWpctlStatus(await fixture('laptop', 'wpctl-status.txt'));
  assert.deepEqual(laptop.sinks, [
    { id: 63, name: 'Ryzen HD Audio Controller Speaker', default: true, volume: 1, muted: false },
    { id: 77, name: 'OpenComm2 by Shokz_II', default: false, volume: 1, muted: false },
  ]);
  assert.deepEqual(laptop.sources.map(s => [s.id, s.name, s.default]), [[64, 'Ryzen HD Audio Controller Stereo Microphone', false], [65, 'Ryzen HD Audio Controller Digital Microphone', false], [80, 'bluez_input.A0:0C:E2:00:00:AA', true]]);
  const desktop = parseWpctlStatus(await fixture('desktop', 'wpctl-status.txt'));
  assert.deepEqual(desktop.sinks.map(s => [s.id, s.default, s.volume]), [[34, false, 0.4], [57, true, 0.4]]);
  assert.deepEqual(desktop.sources.map(s => s.id), [47, 58]);
  assert.deepEqual(parseWpctlStatus(' ├─ Sinks:\n │  *   5. x [vol: 0.10]\n'), { sinks: [], sources: [] }, 'nothing outside the Audio part');
  assert.deepEqual(parseWpctlStatus('Audio\n ├─ Sinks:\n │  *   57. Speaker   [vol: 0.25 MUTED]\n').sinks[0], { id: 57, name: 'Speaker', default: true, volume: 0.25, muted: true });
  assert.deepEqual(parseVolume(await fixture('laptop', 'wpctl-source.txt')), { volume: 0.6, muted: true });
  assert.deepEqual(parseVolume('Volume: 1.00\n'), { volume: 1, muted: false });
});

test('upower and brightnessctl: the laptop\'s battery and backlight; the PC has neither', async () => {
  assert.deepEqual(parseUpower(await fixture('laptop', 'upower-d.txt')), { percent: 17, low: true, state: 'discharging', charging: false, plugged: false, timeToEmpty: 28, timeToFull: null });
  assert.equal(parseUpower(await fixture('desktop', 'upower-d.txt')), null, 'a headset\'s battery or an empty display device is not the computer\'s');
  const charging = (await fixture('laptop', 'upower-d.txt')).replaceAll('discharging', 'charging').replace(/time to empty:.*$/gm, 'time to full:         1.5 hours').replace(/online:\s+no/, 'online:              yes');
  assert.deepEqual(parseUpower(charging), { percent: 17, low: false, state: 'charging', charging: true, plugged: true, timeToEmpty: null, timeToFull: 90 });
  assert.deepEqual(parseBrightness(await fixture('laptop', 'brightnessctl.txt')), { device: 'amdgpu_bl1', percent: 30, current: 148800, max: 496000 });
  assert.equal(parseBrightness('phy0-led,leds,1,100%,1\n'), null);
});

test('state: everything the laptop has, and only what the PC has', async t => {
  const laptop = await (await fetch(`${await serve(t, createSystemControls({ run: recordedComputer('laptop').run, ...owner }))}/system?panel=1`)).json();
  assert.deepEqual(Object.keys(laptop).filter(key => laptop[key]), ['wifi', 'bluetooth', 'sound', 'brightness', 'battery', 'power']);
  assert.equal(laptop.wifi.network, 'home');
  assert.equal(laptop.wifi.signal, 74);
  assert.deepEqual(laptop.wifi.networks.filter(n => n.known).map(n => n.ssid), ['home', 'orbit']);
  assert.deepEqual(laptop.bluetooth.devices.map(d => [d.name, d.paired, d.connected]), [['OpenComm2 by Shokz_II', true, true], ['ZV-E10', true, false], ['WH-1000XM4', false, false]], 'nameless strangers left out');
  assert.equal(laptop.sound.inputs.find(i => i.default).name, 'OpenComm2 by Shokz_II', 'the headset mic is called by the headset');
  assert.deepEqual(laptop.sound.input, { volume: 0.6, muted: true });
  const quick = await (await fetch(`${await serve(t, createSystemControls({ run: recordedComputer('laptop').run, ...owner }))}/system`)).json();
  assert.equal(quick.wifi.networks, undefined, 'the band\'s glance carries no lists');
  const pc = await (await fetch(`${await serve(t, createSystemControls({ run: recordedComputer('desktop').run, ...owner }))}/system?panel=1`)).json();
  assert.equal(pc.battery, null);
  assert.equal(pc.brightness, null);
  assert.equal(pc.wifi.device, 'wlp6s0');
  assert.deepEqual(pc.bluetooth.devices, []);
  const bare = await (await fetch(`${await serve(t, createSystemControls({ run: recordedComputer('laptop', { missing: ['nmcli', 'bluetoothctl', 'wpctl', 'brightnessctl', 'upower', 'systemctl'] }).run, ...owner }))}/system`)).json();
  assert.deepEqual(bare, { wifi: null, bluetooth: null, sound: null, brightness: null, battery: null, power: null });
});

test('a Wi-Fi password goes to nmcli on stdin only, and never comes back, even in a failure', async t => {
  const secret = 'correct horse battery';
  const computer = recordedComputer('laptop', { fail: (command, args, { input }) => (command === 'nmcli' && args.includes('connect') ? { stdout: `Password: ${input}`, stderr: `Error: Connection activation failed: Secrets were required, but not provided (${secret}).` } : null) });
  const logged = [];
  for (const name of ['log', 'error', 'warn', 'info']) t.mock.method(console, name, (...args) => logged.push(args.join(' ')));
  const base = await serve(t, createSystemControls({ run: computer.run, ...owner }));
  const res = await post(base, { do: 'wifi-connect', ssid: 'Neighbour0895C8', password: secret });
  const answer = await res.text();
  assert.equal(res.status, 502);
  assert.doesNotMatch(answer, /correct horse/);
  assert.match(answer, /Secrets were required/);
  const connect = computer.ran.find(r => r.args.includes('connect'));
  assert.deepEqual(connect.args, ['--ask', '-w', '30', 'device', 'wifi', 'connect', 'Neighbour0895C8', 'ifname', 'wlp192s0']);
  assert.equal(connect.input, `${secret}\n`);
  for (const { args } of computer.ran) assert.ok(!args.some(arg => arg.includes('horse')), 'never in a command line');
  assert.deepEqual(logged, []);
});

test('Wi-Fi: a saved network rejoins without a password; radio, disconnect, forget', async t => {
  const computer = recordedComputer('laptop');
  const base = await serve(t, createSystemControls({ run: computer.run, ...owner }));
  for (const body of [{ do: 'wifi-connect', ssid: 'orbit' }, { do: 'wifi-connect', ssid: 'Cafe: free wifi' }, { do: 'wifi-radio', on: false }, { do: 'wifi-disconnect' }, { do: 'wifi-forget', ssid: 'orbit' }]) assert.equal((await post(base, body)).status, 200, JSON.stringify(body));
  assert.deepEqual(computer.changes().map(r => [r.command, ...r.args].join(' ')), [
    'nmcli -w 30 connection up uuid 6b0daf31-1821-4fde-8780-8deef890d7bc',
    'nmcli --ask -w 30 device wifi connect Cafe: free wifi ifname wlp192s0',
    'nmcli radio wifi off',
    'nmcli device disconnect wlp192s0',
    'nmcli connection delete uuid 6b0daf31-1821-4fde-8780-8deef890d7bc',
  ]);
  assert.equal((await post(base, { do: 'wifi-forget', ssid: 'never saved' })).status, 404);
  assert.equal((await post(base, { do: 'wifi-connect', ssid: '' })).status, 400);
});

test('Bluetooth, sound, brightness and power do what they say, within bounds', async t => {
  const computer = recordedComputer('laptop');
  const base = await serve(t, createSystemControls({ run: computer.run, ...owner }));
  for (const body of [
    { do: 'bluetooth-power', on: false }, { do: 'bluetooth-pair', address: 'f4:4e:fd:00:00:31' }, { do: 'bluetooth-disconnect', address: 'A0:0C:E2:00:00:AA' },
    { do: 'sound-volume', target: 'output', value: 1.7 }, { do: 'sound-mute', target: 'input', on: false }, { do: 'sound-default', target: 'output', id: 77 },
    { do: 'brightness', percent: 0 }, { do: 'lock' }, { do: 'reboot' },
  ]) assert.equal((await post(base, body)).status, 200, JSON.stringify(body));
  assert.deepEqual(computer.changes().map(r => [r.command, ...r.args].join(' ')), [
    'bluetoothctl power off',
    'bluetoothctl --timeout 23 pair F4:4E:FD:00:00:31', 'bluetoothctl --timeout 6 trust F4:4E:FD:00:00:31', 'bluetoothctl --timeout 23 connect F4:4E:FD:00:00:31',
    'bluetoothctl --timeout 8 disconnect A0:0C:E2:00:00:AA',
    'wpctl set-volume -l 1.0 @DEFAULT_AUDIO_SINK@ 1.00', 'wpctl set-mute @DEFAULT_AUDIO_SOURCE@ 0', 'wpctl set-default 77',
    'brightnessctl -q -d amdgpu_bl1 set 1%',
    'loginctl lock-sessions',
    'systemctl --no-ask-password reboot',
  ]);
  assert.equal((await post(base, { do: 'bluetooth-pair', address: 'F4:4E:FD:00:00:31; rm -rf /' })).status, 400);
  assert.equal((await post(base, { do: 'sound-default', target: 'output', id: 9999 })).status, 400);
  assert.equal((await post(base, { do: 'format the disk' })).status, 400);
  const pc = await serve(t, createSystemControls({ run: recordedComputer('desktop').run, ...owner }));
  assert.equal((await post(pc, { do: 'brightness', percent: 50 })).status, 404, 'no backlight, no brightness');
});

test('a tool that is not here, or hangs, is no answer rather than a crash', async () => {
  assert.equal((await runTool('imperfect-no-such-tool-here', [])).missing, true);
  const slow = await runTool(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { timeout: 200 });
  assert.equal(slow.ok, false);
  assert.equal(slow.timedOut, true);
  const echoed = await runTool(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], { input: 'through stdin\n' });
  assert.equal(echoed.stdout, 'through stdin\n');
});

test('only this computer\'s own user, at its own screen, may use them', async t => {
  const me = process.getuid();
  const asked = (headers, method = 'GET') => ({ method, headers: { host: '127.0.0.1:5067', ...headers }, socket: {} });
  const same = { uid: me, peerUid: async () => me };
  assert.equal(await refusal(asked({}), same), '');
  assert.equal(await refusal(asked({ origin: 'http://127.0.0.1:5067', 'sec-fetch-site': 'same-origin' }, 'POST'), same), '');
  assert.match(await refusal(asked({}), { ...same, hosted: true }), /hosted/);
  assert.match(await refusal(asked({ host: 'desktop.tail1234.ts.net' }), same), /own screen/);
  assert.match(await refusal(asked({ 'tailscale-user-login': 'noah@example.com' }), same), /tailnet/);
  assert.match(await refusal(asked({ 'sec-fetch-site': 'cross-site' }), same), /own page/);
  assert.match(await refusal(asked({}, 'POST'), same), /origin/);
  assert.match(await refusal(asked({ origin: 'http://127.0.0.1:5068' }, 'POST'), same), /origin/, 'not the pages agents show');
  assert.match(await refusal(asked({}), { uid: me, peerUid: async () => 0 }), /own user/, 'Tailscale Serve connects as root');
  assert.match(await refusal(asked({}), { uid: me, peerUid: async () => me + 1 }), /own user/, 'another user on the box');
  // The kernel's own table, for a real loopback connection made here.
  let seen;
  const server = createServer(async (req, res) => { seen = await loopbackPeerUid(req.socket); res.end(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  await fetch(`http://127.0.0.1:${server.address().port}/`);
  assert.equal(seen, me);
  const table = 'sl local rem st\n 0: 0100007F:9C40 0100007F:13CB 01 00000000:00000000 00:00000000 00000000  1001 0 1 1\n';
  assert.equal(await loopbackPeerUid({ remotePort: 0x9C40, localPort: 0x13CB }, async path => (path.endsWith('tcp') ? table : '')), 1001);
});

test('a Mac, with no /proc, finds who opened a loopback connection with lsof: the client end\'s process, its user', async () => {
  // lsof -Fpun: both ends of the connection are this user's; only the client's local port is the server's remote one.
  const listed = 'p700\nu501\nn127.0.0.1:5067->127.0.0.1:53211\np812\nu502\nn127.0.0.1:53211->127.0.0.1:5067\n';
  assert.equal(lsofPeerUid(listed, 53211, 5067), 502);
  assert.equal(lsofPeerUid('p812\nu501\nn[::1]:53211->[::1]:5067\n', 53211, 5067), 501);
  assert.equal(lsofPeerUid('p700\nu501\nn127.0.0.1:5067->127.0.0.1:53211\n', 53211, 5067), null, 'another user\'s process is not listed: no one');
  assert.equal(lsofPeerUid('', 53211, 5067), null);
  const asked = [];
  const list = async port => { asked.push(port); return listed; };
  assert.equal(await loopbackPeerUid({ remotePort: 53211, localPort: 5067 }, async () => { throw new Error('no /proc'); }, { platform: 'darwin', list }), 502);
  assert.deepEqual(asked, [53211]);
});

test('the real server: loopback and its own user only; never through /peer/, the tailnet or a hosted computer', async t => {
  const root = await mkdtemp(join(tmpdir(), 'imperfect-controls-'));
  const apps = [];
  t.after(async () => { for (const app of apps) await app.close(); await rm(root, { recursive: true, force: true }); });
  const runtime = () => ({ events: new EventEmitter(), snapshot: () => ({ sessionId: 's', cwd: '/tmp', messages: [] }), command: async () => ({}), close: async () => {} });
  const start = async options => {
    const app = await createGueyServer({ port: 0, host: '127.0.0.1', stateDir: join(root, `state-${Math.random()}`), runtime: runtime(), origins: ['https://desktop.tail1234.ts.net'], ...options });
    apps.push(app);
    const { port } = await app.listen();
    return port;
  };
  const call = (port, path, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers: { host: `127.0.0.1:${port}`, ...headers } }, res => { let text = ''; res.on('data', c => { text += c; }); res.on('end', () => resolve({ status: res.statusCode, text })); });
    req.on('error', reject);
    req.end(body);
  });
  const computer = recordedComputer('laptop');
  const port = await start({ controls: { run: computer.run } });
  const local = await call(port, '/system');
  assert.equal(local.status, 200);
  assert.equal(JSON.parse(local.text).battery.percent, 17);
  assert.equal((await call(port, '/system', { headers: { host: 'desktop.tail1234.ts.net' } })).status, 403, 'the phone and the other computers reach it by its tailnet name');
  assert.equal((await call(port, '/system', { headers: { 'tailscale-user-login': 'noah@example.com' } })).status, 403);
  assert.equal((await call(port, '/system', { method: 'POST', body: '{"do":"poweroff"}' })).status, 403, 'a change needs the exact origin');
  assert.equal((await call(port, '/system', { method: 'POST', headers: { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' }, body: '{"do":"wifi-radio","on":true}' })).status, 200);
  for (const path of ['/peer/desktop/system', '/peer/desktop/%73ystem?panel=1', '/peer/desktop//system']) assert.equal((await call(port, path)).status, 403, path);
  assert.deepEqual(computer.changes().map(r => r.args.join(' ')), ['radio wifi on']);
  const hosted = await start({ hosted: true, controls: { run: recordedComputer('laptop').run } });
  assert.equal((await call(hosted, '/system')).status, 403);
});

test('a stale lock marker without its keeper cannot authorize sleep', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'stale-native-lock-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'imperfect-lock')); await writeFile(join(dir, 'imperfect-lock', 'locked'), '');
  const computer = recordedComputer('laptop');
  const base = await serve(t, createSystemControls({ run: computer.run, ...owner, env: { XDG_RUNTIME_DIR: dir }, lockWaitMs: 0 }));
  assert.equal((await post(base, { do: 'suspend' })).status, 409);
  assert.ok(!computer.ran.some(r => r.command === 'systemctl' && r.args.includes('suspend')));
});

test('power key is only a menu trigger; sleep waits for lock; locked controls refuse', async t => {
  const computer = recordedComputer('laptop'); let menus = 0, held = false, locked = false;
  const base = await serve(t, createSystemControls({ run: computer.run, ...owner,
    onPowerMenu: () => menus++, lockState: async name => name === 'held' ? held : locked, lockWaitMs: 0 }));
  assert.equal((await post(base, { do: 'power-menu' })).status, 200);
  assert.equal(menus, 1); assert.deepEqual(computer.changes(), []);
  assert.equal((await post(base, { do: 'suspend' })).status, 409);
  assert.ok(!computer.ran.some(r => r.command === 'systemctl' && r.args.includes('suspend')));
  locked = true;
  assert.equal((await post(base, { do: 'suspend' })).status, 200);
  const changes = computer.changes().map(r => [r.command, ...r.args].join(' '));
  assert.deepEqual(changes.slice(-2), ['loginctl lock-sessions', 'systemctl --no-ask-password suspend']);
  held = true;
  assert.equal((await post(base, { do: 'power-menu' })).status, 423);
  assert.equal((await post(base, { do: 'poweroff' })).status, 423);
  assert.equal((await fetch(`${base}/system`)).status, 423, 'locked for now, not refused for good');
  assert.equal(menus, 1);
});
