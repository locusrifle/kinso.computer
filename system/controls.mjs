// The computer's own controls, for a window that is the whole screen: Wi-Fi,
// Bluetooth, sound, brightness, battery and power, through the same tools a
// terminal would use (nmcli, bluetoothctl, wpctl, brightnessctl, upower,
// systemctl). No agent and no network is involved, so on a fresh boot with no
// Wi-Fi this is how the person gets online.
//
//   GET  /system            what applies here and how it is now (?panel=1 adds
//                           the networks, the devices and the outputs)
//   POST /system {do, ...}  change one thing; answers with the state after it
//
// They act on the computer whose screen this is, and only for its own person:
// the request must come to this server's loopback name from a connection
// opened by this same user (not Tailscale Serve, whose connections arrive on
// loopback from root, not another user on the box, not another computer
// through /peer/, never a hosted computer). Anything not here (a tool missing,
// no battery, no backlight, no Bluetooth controller) is null and not drawn.
// A Wi-Fi password goes to nmcli on its stdin, never in its arguments, and is
// never written down or echoed back.

import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const QUICK = 5000;

// A tool run with a deadline; never a shell. missing: the tool is not here.
// bytes: stdout as it came (a picture), not text.
export function runTool(command, args = [], { input = null, timeout = QUICK, bytes = false } = {}) {
  return new Promise(resolve => {
    let stdout = '', stderr = '', done = false;
    const chunks = [];
    const finish = result => {
      if (done) return;
      done = true; clearTimeout(timer);
      resolve(bytes ? { ...result, stdout: Buffer.concat(chunks) } : result);
    };
    let child;
    try {
      child = spawn(command, args, { env: { ...process.env, LC_ALL: 'C', LANG: 'C' }, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) { finish({ ok: false, code: null, stdout, stderr: error.message, missing: error.code === 'ENOENT' }); return; }
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish({ ok: false, code: null, stdout, stderr: `${command} took too long`, timedOut: true }); }, timeout);
    if (bytes) child.stdout.on('data', chunk => { chunks.push(chunk); });
    else child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.stdin.on('error', () => {});
    child.on('error', error => finish({ ok: false, code: null, stdout, stderr: error.message, missing: error.code === 'ENOENT' }));
    child.on('close', code => finish({ ok: code === 0, code, stdout, stderr }));
    child.stdin.end(input ?? '');
  });
}

/* ------------------------------------------------------------- reading */

// One line of `nmcli -t`: fields split on ':' that is not escaped as '\:'.
export function terse(line) {
  const fields = [];
  let field = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\' && i + 1 < line.length) { field += line[++i]; continue; }
    if (c === ':') { fields.push(field); field = ''; continue; }
    field += c;
  }
  fields.push(field);
  return fields;
}
const lines = text => String(text ?? '').split('\n').filter(line => line.trim());

// nmcli -t -f DEVICE,TYPE,STATE,CONNECTION device
export const parseDevices = text => lines(text).map(terse).map(([device, type, state, connection]) => ({ device, type, state, connection: connection || '' }));

// nmcli -t -f WIFI-HW,WIFI radio
export function parseRadio(text) {
  const [hardware, enabled] = terse(lines(text)[0] ?? '');
  return { hardware: hardware !== 'disabled' && hardware !== 'missing', enabled: enabled === 'enabled' };
}

// nmcli -t -f IN-USE,SSID,SIGNAL,SECURITY device wifi list: one row per
// network name, at its strongest, the one in use first; hidden ones left out.
export function parseWifiList(text) {
  const bySsid = new Map();
  for (const [inUse, ssid, signal, security = ''] of lines(text).map(terse)) {
    if (!ssid) continue;
    const kinds = security.split(/\s+/).filter(word => word && word !== '--');
    const row = { ssid, signal: Number(signal) || 0, security: kinds.join(' '), secured: kinds.length > 0, enterprise: kinds.includes('802.1X'), active: inUse.trim() === '*' };
    const kept = bySsid.get(ssid);
    if (!kept) { bySsid.set(ssid, row); continue; }
    kept.active ||= row.active;
    if (row.signal > kept.signal) kept.signal = row.signal;
  }
  return [...bySsid.values()].sort((a, b) => (b.active - a.active) || (b.signal - a.signal) || a.ssid.localeCompare(b.ssid));
}

// nmcli -t -f NAME,UUID,TYPE,DEVICE connection show
export const parseConnections = text => lines(text).map(terse).map(([name, uuid, type, device]) => ({ name, uuid, type, device: device || '' }));

// bluetoothctl show: the default controller, or null when there is none.
export function parseBluetoothShow(text) {
  const head = /^Controller\s+([0-9A-F:]{17})/im.exec(String(text ?? ''));
  if (!head) return null;
  const field = name => new RegExp(`^\\s*${name}:\\s*(.*)$`, 'm').exec(text)?.[1]?.trim() ?? '';
  return { address: head[1], name: field('Alias') || field('Name'), powered: field('Powered') === 'yes', discovering: field('Discovering') === 'yes' };
}

// bluetoothctl devices [Paired|Connected]: "Device <address> <name>". A
// device that never said its name is called by its address.
export const parseBluetoothDevices = text => lines(text).map(line => /^Device\s+([0-9A-F:]{17})\s*(.*)$/i.exec(line.trim())).filter(Boolean)
  .map(([, address, name]) => ({ address: address.toUpperCase(), name: name.trim(), named: Boolean(name.trim()) && name.trim().toUpperCase() !== address.toUpperCase().replaceAll(':', '-') }));

// wpctl status, its Audio part: the outputs (sinks) and inputs (sources),
// each with its id, name, volume and whether it is the default ('*'). A
// filter standing in as a sink or source (a Bluetooth headset's mic) counts.
export function parseWpctlStatus(text) {
  const sinks = [], sources = [];
  let inAudio = false, section = '';
  for (const raw of String(text ?? '').split('\n')) {
    if (/^\S/.test(raw)) { inAudio = raw.trim() === 'Audio'; section = ''; continue; }
    if (!inAudio) continue;
    const heading = /[├└]─\s*([A-Za-z]+):/.exec(raw);
    if (heading) { section = heading[1]; continue; }
    const row = /^[\s│]*(\*)?\s*(\d+)\.\s+(.*?)\s*(?:\[(.*)\])?\s*$/.exec(raw);
    if (!row) continue;
    const [, star, id, name, tag = ''] = row;
    const vol = /vol:\s*([\d.]+)(\s+MUTED)?/.exec(tag);
    const entry = { id: Number(id), name: name.trim(), default: Boolean(star), ...(vol ? { volume: Number(vol[1]), muted: Boolean(vol[2]) } : {}) };
    if (section === 'Sinks') sinks.push(entry);
    else if (section === 'Sources') sources.push(entry);
    else if (section === 'Filters' && tag === 'Audio/Sink') sinks.push(entry);
    else if (section === 'Filters' && tag === 'Audio/Source') sources.push(entry);
  }
  return { sinks, sources };
}

// wpctl get-volume: "Volume: 0.40 [MUTED]".
export function parseVolume(text) {
  const match = /Volume:\s*([\d.]+)(.*)$/m.exec(String(text ?? ''));
  return match ? { volume: Number(match[1]), muted: /MUTED/.test(match[2]) } : null;
}

// upower -d: the battery, as the composite display device reports it (all
// batteries as one), or null when nothing here runs on a battery.
export function parseUpower(text) {
  const blocks = String(text ?? '').split(/^Device:\s*/m).slice(1).map(block => {
    const [path, ...rest] = block.split('\n');
    const body = rest.join('\n');
    const field = name => new RegExp(`^\\s*${name}:\\s*(.*)$`, 'm').exec(body)?.[1]?.trim() ?? '';
    return { path: path.trim(), field };
  });
  const batteries = blocks.filter(b => /\/battery_/.test(b.path) && b.field('power supply') === 'yes' && b.field('present') !== 'no');
  if (!batteries.length) return null;
  const display = blocks.find(b => /DisplayDevice$/.test(b.path) && b.field('power supply') === 'yes') ?? batteries[0];
  const line = blocks.find(b => /\/line_power_/.test(b.path));
  const minutes = value => {
    const match = /^([\d.]+)\s*(second|minute|hour|day)s?/.exec(value);
    if (!match) return null;
    return Math.round(Number(match[1]) * { second: 1 / 60, minute: 1, hour: 60, day: 1440 }[match[2]]);
  };
  const state = display.field('state') || 'unknown';
  const plugged = line ? line.field('online') === 'yes' : ['charging', 'fully-charged', 'pending-charge'].includes(state);
  const percent = Math.round(parseFloat(display.field('percentage')) || 0);
  return {
    percent,
    // upower's own warning (low, critical, action) or a fifth left, unplugged.
    low: !plugged && (['low', 'critical', 'action'].includes(display.field('warning-level')) || percent <= 20),
    state,
    charging: state === 'charging',
    plugged,
    timeToEmpty: minutes(display.field('time to empty')),
    timeToFull: minutes(display.field('time to full')),
  };
}

// brightnessctl -m -c backlight: "device,class,current,percent%,max".
export function parseBrightness(text) {
  const [device, kind, current, percent, max] = (lines(text)[0] ?? '').split(',');
  if (kind !== 'backlight' || !Number(max)) return null;
  return { device, percent: Math.round(Number(current) / Number(max) * 100), current: Number(current), max: Number(max) };
}

/* -------------------------------------------------------------- owner */

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const loopbackHost = host => { try { return LOOPBACK_HOSTS.has(new URL(`http://${host}`).hostname); } catch { return false; } };
const LOOPBACK_HEX = /^(0100007F|0{24}01000000|0{16}FFFF00000100007F):/i;

// A Mac has no /proc: lsof names the process holding the client end of the
// connection (its local port the server's remote port), and its user. It
// sees only this user's own processes, so another user's is not found: null.
export function lsofPeerUid(text, remotePort, localPort) {
  const ends = new Set([`127.0.0.1:${remotePort}->127.0.0.1:${localPort}`, `[::1]:${remotePort}->[::1]:${localPort}`]);
  let uid = null;
  for (const line of String(text).split('\n')) {
    if (line[0] === 'p') uid = null;
    else if (line[0] === 'u') uid = Number(line.slice(1));
    else if (line[0] === 'n' && ends.has(line.slice(1)) && Number.isInteger(uid)) return uid;
  }
  return null;
}
const lsof = remotePort => new Promise(resolve => {
  const child = spawn('/usr/sbin/lsof', ['-nP', `-iTCP:${remotePort}`, '-sTCP:ESTABLISHED', '-Fpun'], { stdio: ['ignore', 'pipe', 'ignore'] });
  let out = '';
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => { out += chunk; });
  child.on('error', () => { clearTimeout(timer); resolve(''); });
  child.on('close', () => { clearTimeout(timer); resolve(out); });
});

// Which user opened a loopback connection: the kernel's socket table lists
// the client end (its local port is the server's remote port) with its uid.
export async function loopbackPeerUid(socket, read = path => readFile(path, 'utf8'), { platform = process.platform, list = lsof } = {}) {
  const { remotePort, localPort } = socket ?? {};
  if (!remotePort || !localPort) return null;
  if (platform === 'darwin') return lsofPeerUid(await list(remotePort), remotePort, localPort);
  for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
    const text = await read(table).catch(() => '');
    for (const row of text.split('\n').slice(1)) {
      const f = row.trim().split(/\s+/);
      if (f.length < 8 || !LOOPBACK_HEX.test(f[1]) || !LOOPBACK_HEX.test(f[2])) continue;
      if (parseInt(f[1].split(':')[1], 16) === remotePort && parseInt(f[2].split(':')[1], 16) === localPort) return Number(f[7]);
    }
  }
  return null;
}

// Why a request may not use the controls, or '' when it may.
export async function refusal(req, { hosted = false, uid = process.getuid?.(), peerUid = loopbackPeerUid } = {}) {
  if (hosted) return 'not on a hosted computer';
  if (!loopbackHost(req.headers.host)) return 'only on this computer\'s own screen';
  if (req.headers['tailscale-user-login'] || req.headers['tailscale-user-name']) return 'not through the tailnet';
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return 'only from imperfect\'s own page';
  if (req.method !== 'GET') {
    let origin;
    try { origin = new URL(String(req.headers.origin)); } catch { return 'exact origin required'; }
    if (origin.host !== req.headers.host) return 'exact origin required';
  }
  if (uid == null || await peerUid(req.socket) !== uid) return 'only for this computer\'s own user';
  return '';
}

/* -------------------------------------------------------------- state */

const ADDRESS = /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/i;
const fail = (status, message) => Object.assign(new Error(message), { status });
// A tool's complaint, short, with nothing the person typed in it.
const complaint = (result, secret = '') => {
  let text = `${result.stderr || ''}\n${result.stdout || ''}`;
  if (secret) text = text.split(secret).join('•••');
  const line = text.split('\n').map(l => l.replace(/^(Error|error):\s*/, '').trim()).filter(l => l && !/^(Password|Passwords or encryption keys)/i.test(l)).at(-1);
  return (line || 'it did not work').slice(0, 200);
};

export function createSystemControls({ run = runTool, hosted = false, refuse = req => refusal(req, { hosted }), onPowerMenu = () => {}, env = process.env, lockWaitMs = 15_000,
  lockState = async name => {
    const dir = join(env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.()}`, 'imperfect-lock');
    if (!await stat(join(dir, name)).catch(() => null)) return false;
    if (name !== 'locked') return true;
    if (!await stat(join(dir, 'held')).catch(() => null) || !await stat(join(dir, 'keeper')).catch(() => null)) return false;
    // A leftover marker is not a lock: its native keeper must still own the
    // guard. A dedicated conflict exit code distinguishes tool errors.
    return (await runTool('flock', ['-n', '-E', '73', join(dir, 'keeper'), 'true'])).code === 73;
  },
} = {}) {
  const sh = (command, args, options) => run(command, args, options);

  async function wifi(panel) {
    const [devices, radio] = await Promise.all([sh('nmcli', ['-t', '-f', 'DEVICE,TYPE,STATE,CONNECTION', 'device']), sh('nmcli', ['-t', '-f', 'WIFI-HW,WIFI', 'radio'])]);
    if (!devices.ok) return null;
    const device = parseDevices(devices.stdout).find(row => row.type === 'wifi');
    if (!device) return null;
    const { hardware, enabled } = parseRadio(radio.stdout);
    const state = { device: device.device, hardware, enabled, connected: device.state === 'connected', state: device.state, network: device.state === 'connected' ? device.connection : '', signal: null };
    const [list, saved] = await Promise.all([
      sh('nmcli', ['-t', '-f', 'IN-USE,SSID,SIGNAL,SECURITY', 'device', 'wifi', 'list', '--rescan', 'no']),
      panel ? sh('nmcli', ['-t', '-f', 'NAME,UUID,TYPE,DEVICE', 'connection', 'show']) : null,
    ]);
    const networks = list.ok ? parseWifiList(list.stdout) : [];
    const here = networks.find(row => row.active);
    if (here) { state.signal = here.signal; state.network = here.ssid; }
    if (panel) {
      const known = new Map(parseConnections(saved?.stdout).filter(row => row.type === '802-11-wireless').map(row => [row.name, row.uuid]));
      state.networks = networks.map(row => ({ ...row, known: known.has(row.ssid) }));
    }
    return state;
  }

  async function bluetooth(panel) {
    const show = await sh('bluetoothctl', ['show'], { timeout: 4000 });
    const controller = show.ok ? parseBluetoothShow(show.stdout) : null;
    if (!controller) return null;
    const state = { powered: controller.powered, discovering: controller.discovering };
    if (panel) {
      const [all, paired, connected] = await Promise.all(['', 'Paired', 'Connected'].map(kind => sh('bluetoothctl', kind ? ['devices', kind] : ['devices'], { timeout: 4000 })));
      const pairedSet = new Set(parseBluetoothDevices(paired.stdout).map(d => d.address));
      const connectedSet = new Set(parseBluetoothDevices(connected.stdout).map(d => d.address));
      state.devices = parseBluetoothDevices(all.stdout)
        .map(d => ({ address: d.address, name: d.named ? d.name : d.address, paired: pairedSet.has(d.address), connected: connectedSet.has(d.address) }))
        // Nameless strangers nearby are noise; one already paired is not.
        .filter(d => d.paired || d.connected || d.name !== d.address)
        .sort((a, b) => (b.connected - a.connected) || (b.paired - a.paired) || a.name.localeCompare(b.name));
    }
    return state;
  }

  async function sound(panel) {
    const status = await sh('wpctl', ['status']);
    if (!status.ok) return null;
    const { sinks, sources } = parseWpctlStatus(status.stdout);
    if (!sinks.length) return null;
    const [output, input] = await Promise.all([sh('wpctl', ['get-volume', '@DEFAULT_AUDIO_SINK@']), sources.length ? sh('wpctl', ['get-volume', '@DEFAULT_AUDIO_SOURCE@']) : null]);
    const state = { output: parseVolume(output.stdout), input: input?.ok ? parseVolume(input.stdout) : null };
    if (panel) {
      const row = ({ id, name, default: chosen }) => ({ id, name: name.replace(/^bluez_(input|output)\.([0-9A-F:]{17}).*$/i, 'bluetooth $2'), default: chosen });
      Object.assign(state, { outputs: sinks.map(row), inputs: sources.map(row) });
    }
    return state;
  }

  async function brightness() {
    const result = await sh('brightnessctl', ['-m', '-c', 'backlight']);
    return result.ok ? parseBrightness(result.stdout) : null;
  }

  async function battery() {
    const result = await sh('upower', ['-d']);
    return result.ok ? parseUpower(result.stdout) : null;
  }

  async function power() {
    const result = await sh('systemctl', ['--version']);
    return result.ok ? { actions: ['suspend', 'reboot', 'poweroff'] } : null;
  }

  async function state(panel = false) {
    const [w, b, s, l, bat, p] = await Promise.all([wifi(panel), bluetooth(panel), sound(panel), brightness(), battery(), power()].map(job => job.catch(() => null)));
    // A headset's mic is called what the headset is called.
    for (const row of [...(s?.outputs ?? []), ...(s?.inputs ?? [])]) {
      const device = b?.devices?.find(d => row.name === `bluetooth ${d.address}`);
      if (device) row.name = device.name;
    }
    return { wifi: w, bluetooth: b, sound: s, brightness: l, battery: bat, power: p };
  }

  // Each thing the panel can ask, and the commands that do it.
  async function act(body) {
    const must = async (command, args, options = {}, secret = '') => {
      const result = await sh(command, args, options);
      if (result.missing) throw fail(404, `${command} is not on this computer`);
      if (!result.ok) throw fail(502, complaint(result, secret));
      return result;
    };
    const what = String(body?.do ?? '');
    if (what === 'power-menu') { onPowerMenu(); return { done: what }; }
    const current = await state(true);
    const need = name => { if (!current[name]) throw fail(404, `no ${name} here`); return current[name]; };
    switch (what) {
      case 'wifi-radio': need('wifi'); await must('nmcli', ['radio', 'wifi', body.on ? 'on' : 'off']); break;
      case 'wifi-scan': need('wifi'); await sh('nmcli', ['device', 'wifi', 'rescan'], { timeout: 10_000 }); break;
      case 'wifi-disconnect': await must('nmcli', ['device', 'disconnect', need('wifi').device], { timeout: 15_000 }); break;
      case 'wifi-forget': {
        const ssid = String(body.ssid ?? '');
        const saved = parseConnections((await must('nmcli', ['-t', '-f', 'NAME,UUID,TYPE,DEVICE', 'connection', 'show'])).stdout);
        const row = saved.find(c => c.type === '802-11-wireless' && c.name === ssid);
        if (!row) throw fail(404, 'that network is not saved');
        await must('nmcli', ['connection', 'delete', 'uuid', row.uuid]);
        break;
      }
      case 'wifi-connect': {
        const { device } = need('wifi');
        const ssid = String(body.ssid ?? ''), password = typeof body.password === 'string' ? body.password : '';
        if (!ssid || Buffer.byteLength(ssid) > 32 || /[\0\n]/.test(ssid)) throw fail(400, 'no such network');
        if (/[\0\n]/.test(password) || password.length > 128) throw fail(400, 'that password cannot be right');
        const saved = parseConnections((await must('nmcli', ['-t', '-f', 'NAME,UUID,TYPE,DEVICE', 'connection', 'show'])).stdout).filter(c => c.type === '802-11-wireless');
        const known = saved.find(c => c.name === ssid);
        if (known && !password) { await must('nmcli', ['-w', '30', 'connection', 'up', 'uuid', known.uuid], { timeout: 40_000 }); break; }
        if (known) await must('nmcli', ['connection', 'delete', 'uuid', known.uuid]);
        // --ask reads the password from stdin when the network wants one.
        const result = await sh('nmcli', ['--ask', '-w', '30', 'device', 'wifi', 'connect', ssid, 'ifname', device], { input: password ? `${password}\n` : '', timeout: 40_000 });
        if (!result.ok) {
          // A profile left behind by a failed first try would keep the wrong password.
          const after = parseConnections((await sh('nmcli', ['-t', '-f', 'NAME,UUID,TYPE,DEVICE', 'connection', 'show'])).stdout);
          const before = new Set(saved.map(c => c.uuid));
          for (const row of after) if (row.type === '802-11-wireless' && row.name === ssid && !before.has(row.uuid)) await sh('nmcli', ['connection', 'delete', 'uuid', row.uuid]);
          throw fail(502, complaint(result, password));
        }
        break;
      }
      case 'bluetooth-power': {
        need('bluetooth');
        const on = body.on ? 'on' : 'off';
        const first = await sh('bluetoothctl', ['power', on], { timeout: 8000 });
        if (!first.ok || /Failed|Blocked/i.test(first.stdout)) {
          // A soft block (rfkill) stops the controller coming on.
          if (on === 'on') await sh('rfkill', ['unblock', 'bluetooth']);
          const again = await must('bluetoothctl', ['power', on], { timeout: 8000 });
          if (/Failed|Blocked/i.test(again.stdout)) throw fail(502, complaint(again));
        }
        break;
      }
      case 'bluetooth-scan': need('bluetooth'); await sh('bluetoothctl', ['--timeout', '8', 'scan', 'on'], { timeout: 12_000 }); break;
      case 'bluetooth-pair': case 'bluetooth-connect': case 'bluetooth-disconnect': case 'bluetooth-remove': {
        need('bluetooth');
        const address = String(body.address ?? '').toUpperCase();
        if (!ADDRESS.test(address)) throw fail(400, 'no such device');
        const verb = what.slice('bluetooth-'.length);
        const step = async (command, ms = 25_000) => {
          const result = await must('bluetoothctl', ['--timeout', String(Math.round(ms / 1000) - 2), command, address], { timeout: ms });
          if (/Failed|not available|Error/i.test(result.stdout)) throw fail(502, complaint({ stdout: result.stdout.split('\n').filter(l => /Failed|not available|Error/i.test(l)).join('\n') }));
        };
        // Paired once, trusted so it comes back by itself, then connected.
        if (verb === 'pair') { await step('pair'); await step('trust', 8000); await step('connect'); }
        else await step(verb, verb === 'connect' ? 25_000 : 10_000);
        break;
      }
      case 'sound-volume': case 'sound-mute': case 'sound-default': {
        const sound = need('sound');
        const input = body.target === 'input';
        const node = input ? '@DEFAULT_AUDIO_SOURCE@' : '@DEFAULT_AUDIO_SINK@';
        if (what === 'sound-volume') {
          const value = Math.max(0, Math.min(1, Number(body.value)));
          if (!Number.isFinite(value)) throw fail(400, 'no such volume');
          await must('wpctl', ['set-volume', '-l', '1.0', node, value.toFixed(2)]);
        } else if (what === 'sound-mute') {
          await must('wpctl', ['set-mute', node, body.on ? '1' : '0']);
        } else {
          const id = Number(body.id);
          if (!(input ? sound.inputs : sound.outputs).some(row => row.id === id)) throw fail(400, 'no such device');
          await must('wpctl', ['set-default', String(id)]);
        }
        break;
      }
      case 'brightness': {
        const { device } = need('brightness');
        // Never fully dark: a black screen is one nobody can turn back up.
        const percent = Math.max(1, Math.min(100, Math.round(Number(body.percent))));
        if (!Number.isFinite(percent)) throw fail(400, 'no such brightness');
        await must('brightnessctl', ['-q', '-d', device, 'set', `${percent}%`]);
        break;
      }
      case 'lock':
        need('power');
        // The OS lock branch's swayidle listener owns the actual lock.
        // This server is a user service, not a login session's process:
        // without an explicit session ID, lock-session cannot find sway.
        await must('loginctl', ['lock-sessions'], { timeout: 15_000 });
        return { done: what };
      case 'suspend': case 'reboot': case 'poweroff':
        need('power');
        if (what === 'suspend') {
          await must('loginctl', ['lock-sessions'], { timeout: 15_000 });
          // Requesting a lock is not proof it succeeded. Fail closed until
          // the native keeper reports its compositor lock acquired.
          const until = Date.now() + lockWaitMs;
          while (!await lockState('locked')) {
            if (Date.now() >= until) throw fail(409, 'screen did not lock; not sleeping');
            await delay(50);
          }
        }
        await must('systemctl', ['--no-ask-password', what], { timeout: 15_000 });
        return { done: what };
      default: throw fail(400, 'unknown control');
    }
    return state(true);
  }

  const send = (res, status, value) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(value));
  };
  return async function handle(req, res, path) {
    if (path !== '/system') return false;
    const why = await refuse(req);
    if (why) { send(res, 403, { error: why }); return true; }
    try {
      // Locked is for now (423), not a refusal: the page asks again once it is unlocked.
      if (await lockState('held')) throw fail(423, 'screen is locked');
      if (req.method === 'GET') { send(res, 200, await state(new URL(req.url, 'http://local').searchParams.has('panel'))); return true; }
      if (req.method !== 'POST') { send(res, 405, { error: 'GET or POST' }); return true; }
      let raw = '';
      req.setEncoding('utf8');
      for await (const chunk of req) { raw += chunk; if (raw.length > 4096) throw fail(413, 'too long'); }
      let body;
      try { body = JSON.parse(raw || '{}'); } catch { throw fail(400, 'not JSON'); }
      send(res, 200, await act(body));
    } catch (error) {
      if (!res.headersSent) send(res, error.status || 500, { error: error.status ? error.message : 'it did not work' });
    }
    return true;
  };
}
