import { readFile } from 'node:fs/promises';

// Recorded on the laptop (Omarchy, NetworkManager 1.58, BlueZ 5.87,
// PipeWire 1.6.8, UPower 1.91) and the PC (no battery, no backlight, a
// Bluetooth controller with nothing paired). Network names and addresses
// are changed; the shapes are the tools' own.
export const fixture = (computer, name) => readFile(new URL(`./${computer}/${name}`, import.meta.url), 'utf8');
const COMMANDS = {
  'nmcli -t -f DEVICE,TYPE,STATE,CONNECTION device': 'nmcli-device.txt',
  'nmcli -t -f WIFI-HW,WIFI radio': 'nmcli-radio.txt',
  'nmcli -t -f IN-USE,SSID,SIGNAL,SECURITY device wifi list --rescan no': 'nmcli-wifi.txt',
  'nmcli -t -f NAME,UUID,TYPE,DEVICE connection show': 'nmcli-connections.txt',
  'bluetoothctl show': 'bt-show.txt',
  'bluetoothctl devices': 'bt-devices.txt',
  'bluetoothctl devices Paired': 'bt-paired.txt',
  'bluetoothctl devices Connected': 'bt-connected.txt',
  'wpctl status': 'wpctl-status.txt',
  'wpctl get-volume @DEFAULT_AUDIO_SINK@': 'wpctl-sink.txt',
  'wpctl get-volume @DEFAULT_AUDIO_SOURCE@': 'wpctl-source.txt',
  'upower -d': 'upower-d.txt',
  'brightnessctl -m -c backlight': 'brightnessctl.txt',
};
// A computer made of recordings: reads answer from the fixtures, changes are
// written down and succeed unless `fail` says otherwise.
export function recordedComputer(computer, { fail = () => null, missing = [] } = {}) {
  const ran = [];
  const run = async (command, args = [], options = {}) => {
    ran.push({ command, args, input: options.input ?? null });
    if (missing.includes(command)) return { ok: false, missing: true, stdout: '', stderr: '' };
    const failed = fail(command, args, options);
    if (failed) return { ok: false, code: 1, stdout: '', ...failed };
    const key = [command, ...args].join(' ');
    if (COMMANDS[key]) {
      const text = await fixture(computer, COMMANDS[key]).catch(() => null);
      if (text == null) return { ok: false, code: 1, stdout: '', stderr: 'not recorded' };
      // brightnessctl without a backlight says so and fails.
      if (/^Failed/.test(text)) return { ok: false, code: 1, stdout: '', stderr: text };
      return { ok: true, code: 0, stdout: text, stderr: '' };
    }
    if (command === 'systemctl' && args[0] === '--version') return { ok: true, code: 0, stdout: 'systemd 258\n', stderr: '' };
    return { ok: true, code: 0, stdout: '', stderr: '' };
  };
  return { run, ran, changes: () => ran.filter(({ command, args }) => !COMMANDS[[command, ...args].join(' ')] && args[0] !== '--version') };
}
