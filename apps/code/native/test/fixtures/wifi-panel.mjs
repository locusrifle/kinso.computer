// A synthetic radio, never the computer's actual Wi-Fi. Shared by interaction
// checks and the task's 2x stills, rendered inside the real imperfect page.
import { readFile } from 'node:fs/promises';
import { themeCss } from '../../../../../system/theme.mjs';
import { harnessFixture, readBody } from './harness-page.mjs';
import { withSystemPresenter } from './system-presenter.mjs';

export const wifiState = () => ({
  wifi: {
    hardware: true, enabled: true, connected: true, network: 'Home Studio', signal: 88,
    networks: [
      { ssid: 'Garden', signal: 19, secured: true },
      { ssid: 'Library', signal: 45, known: true, secured: false },
      { ssid: 'Home Studio', signal: 88, active: true, known: true, secured: true },
      { ssid: 'Cafe', signal: 56, secured: true },
      { ssid: 'Guest', signal: 93, secured: true },
      { ssid: 'Workshop', signal: 65, known: true, secured: true },
      { ssid: 'Campus', signal: 37, secured: true, enterprise: true },
    ],
  },
  bluetooth: { powered: false, devices: [] },
  sound: { output: { volume: 0.6, muted: false }, outputs: [], inputs: [] },
  battery: { percent: 82, plugged: true }, power: true,
});

export async function wifiPanelFixture({ theme = 'mac-light', width = 1200, height = 900, hasTouch = width < 500, hardware = true, enabled = true, empty = false, holdScan = false, holdAction = '', browser, fail = '', devices = false, modules = false, hosted = true, refused = false } = {}) {
  const themeFile = theme.startsWith('mac-') ? `../../themes/${theme}.json` : `./themes/${theme}.json`;
  const css = themeCss(JSON.parse(await readFile(new URL(themeFile, import.meta.url), 'utf8')));
  const state = wifiState();
  Object.assign(state.wifi, { hardware, enabled });
  if (empty) state.wifi.networks = [];
  if (devices || modules) state.bluetooth = { powered: true, devices: [
    { address: 'AA:00:00:00:00:01', name: 'Studio Headphones', connected: true, paired: true },
    { address: 'AA:00:00:00:00:02', name: 'Magic Keyboard', connected: false, paired: true },
    { address: 'AA:00:00:00:00:03', name: 'Nearby Speaker', connected: false, paired: false },
  ] };
  if (modules) {
    state.brightness = { percent: 66 };
    state.sound.input = { volume: 0.5, muted: true };
    state.sound.outputs = [{ id: 1, name: 'Studio Display', default: true }, { id: 2, name: 'Headphones' }];
    state.sound.inputs = [{ id: 3, name: 'Studio Microphone', default: true }];
  }
  const requests = [], clipboard = [];
  let release = () => {}, releaseAction = () => {}, scanning = holdScan;
  const releaseScan = () => { scanning = false; release(); };
  const f = await harnessFixture({
    site: true, themeCSS: css, viewport: { width, height }, hasTouch, browser,
    messages: [{ role: 'assistant', content: 'Ready.' }],
    handleRequest: async (req, res, path) => {
      const json = body => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); };
      if (hosted && path === '/js/harness.js') {
        res.setHeader('content-type', 'text/javascript');
        res.end(withSystemPresenter(await readFile(new URL('../../public/js/harness.js', import.meta.url), 'utf8')));
        return true;
      }
      if (path === '/files/list') { json({ path: '/workspace', home: '/workspace', entries: [] }); return true; }
      if (path === '/clipboard' && req.method === 'POST') { clipboard.push(await readBody(req)); json({ ok: true }); return true; }
      if (path !== '/system') return false;
      if (refused) { res.statusCode = 403; json({ error: 'only on this computer\'s own screen' }); return true; }
      if (req.method === 'POST') {
        const body = await readBody(req); requests.push(body);
        if (body.do === 'wifi-scan' && scanning) await new Promise(resolve => { release = resolve; });
        if (body.do === holdAction) await new Promise(resolve => { releaseAction = resolve; });
        if (body.do === fail) { res.statusCode = 500; json({ error: 'The connection could not be completed' }); return true; }
        const network = state.wifi.networks.find(n => n.ssid === body.ssid);
        if (body.do === 'wifi-radio') state.wifi.enabled = body.on;
        if (body.do === 'wifi-connect') {
          state.wifi.networks.forEach(n => { n.active = n === network; });
          Object.assign(state.wifi, { connected: true, network: body.ssid }); network.known = true;
        }
        if (body.do === 'wifi-disconnect') {
          state.wifi.connected = false; state.wifi.networks.forEach(n => { n.active = false; });
        }
        if (body.do === 'wifi-forget') network.known = false;
        if (body.do === 'sound-mute') state.sound[body.target].muted = body.on;
        if (body.do === 'sound-volume') state.sound[body.target].volume = body.value;
        if (body.do === 'sound-default') (body.target === 'output' ? state.sound.outputs : state.sound.inputs).forEach(d => { d.default = d.id === body.id; });
        if (body.do === 'brightness') state.brightness.percent = body.percent;
        if (body.do === 'bluetooth-power') state.bluetooth.powered = body.on;
        const device = state.bluetooth.devices.find(d => d.address === body.address);
        if (body.do === 'bluetooth-connect') device.connected = true;
        if (body.do === 'bluetooth-disconnect') device.connected = false;
        if (body.do === 'bluetooth-pair') device.paired = true;
        if (body.do === 'bluetooth-remove') state.bluetooth.devices = state.bluetooth.devices.filter(d => d !== device);
      }
      json(state); return true;
    },
  });
  await f.page.addStyleTag({ content: 'html body #entry-terminal { height:100vh !important; }' });
  // Production correctly hides local hardware on a real phone, including
  // while another swipe column is visible. Expose only the synthetic status
  // in both states so its keyboard return/reopen can be tested on touch.
  if (hasTouch) await f.page.addStyleTag({ content: 'body.imperfect .code-face #entry-terminal.phone-layout > .screen-status { display:flex; visibility:visible; }' });
  const close = f.close;
  let closed = false;
  f.close = async () => { if (closed) return; closed = true; releaseScan(); releaseAction(); await close(); };
  return { ...f, state, requests, clipboard, releaseScan, releaseAction: () => releaseAction() };
}
