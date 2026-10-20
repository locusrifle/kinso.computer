// Machine discovery shared by imperfect and Workbench. Tailscale names the allowed
// destinations; callers never supply an arbitrary host or URL.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { hostname } from 'node:os';

const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const NODE_ID = /^[A-Za-z0-9_-]{1,128}$/;
export const MACHINE_PROTOCOL = 1;
export const MACHINE_CAPABILITIES = Object.freeze(['code', 'files', 'preferences']);

// Tailscale's command: on a Mac, the app's own binary answers as it, where
// the app was installed from the App Store or tailscale.com and put nothing
// on the PATH.
const MAC_TAILSCALE = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
export const tailscaleCommand = (platform = process.platform, exists = existsSync) => (platform === 'darwin' && exists(MAC_TAILSCALE) ? MAC_TAILSCALE : 'tailscale');
const tailscaleJson = args => new Promise(resolve => {
  execFile(tailscaleCommand(), args, { timeout: 4000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
    if (error) return resolve(null);
    try { resolve(JSON.parse(stdout)); } catch { resolve(null); }
  });
});
export const tailnetStatus = () => tailscaleJson(['status', '--json']);
// What `tailscale serve` publishes of this computer's loopback.
const serveStatus = () => tailscaleJson(['serve', 'status', '--json']);

const dnsName = node => String(node?.DNSName ?? '').replace(/\.$/, '');
const shortName = dns => dns.split('.')[0].toLowerCase();
const stableId = (entry, fallback) => {
  const raw = String(entry?.StableID ?? entry?.ID ?? '');
  return NODE_ID.test(raw) ? raw : fallback;
};

export function readTailnet(status) {
  if (!status?.Self) return { self: null, peers: [] };
  const node = entry => {
    const dns = dnsName(entry);
    const name = shortName(dns);
    if (!NAME.test(name) || !dns) return null;
    return {
      id: stableId(entry, name),
      name,
      dns,
      url: `https://${dns}`,
      online: Boolean(entry.Online),
      os: String(entry.OS ?? '').toLowerCase(),
      // Whose it is: a device of the person's own is theirs and untagged.
      user: entry.UserID ?? null,
      tagged: Array.isArray(entry.Tags) && entry.Tags.length > 0,
      ips: Array.isArray(entry.TailscaleIPs) ? entry.TailscaleIPs.map(String) : [],
    };
  };
  const self = node(status.Self);
  const peers = Object.values(status.Peer ?? {}).map(node).filter(Boolean);
  return { self: self && { ...self, online: true }, peers };
}

function publicMachine(peer, { self = false, reachable = false, protocol = null, capabilities = [], hosted = false } = {}) {
  return {
    id: peer.id,
    name: peer.name,
    url: peer.url,
    self,
    hosted: hosted === true,
    online: self || Boolean(peer.online),
    reachable: self || Boolean(reachable),
    protocol: self ? MACHINE_PROTOCOL : protocol,
    capabilities: self ? [...MACHINE_CAPABILITIES] : capabilities,
  };
}

// The address the tailnet publishes a loopback port of this computer at,
// https://<this computer>.<tailnet>.ts.net[:port], or ''.
export function publishedAt(serve, dns, port) {
  for (const [where, site] of Object.entries(serve?.Web ?? {})) {
    const cut = where.lastIndexOf(':'), host = where.slice(0, cut), at = where.slice(cut + 1);
    if (!dns || host.toLowerCase() !== dns.toLowerCase()) continue;
    const proxy = String(site?.Handlers?.['/']?.Proxy ?? '');
    let to;
    try { to = new URL(/^\d+$/.test(proxy) ? `http://127.0.0.1:${proxy}` : proxy); } catch { continue; }
    if (['127.0.0.1', 'localhost'].includes(to.hostname) && Number(to.port) === port && to.pathname === '/') return `https://${host}${at === '443' ? '' : `:${at}`}`;
  }
  return '';
}

export function createMachines({ status = tailnetStatus, serve = serveStatus, fetchImpl = fetch, ttlMs = 15_000 } = {}) {
  let seen = { at: 0, value: null };
  async function tailnet() {
    if (seen.value && Date.now() - seen.at < ttlMs) return seen.value;
    const value = readTailnet(await status());
    seen = { at: Date.now(), value };
    return value;
  }
  let served = { at: 0, value: null };
  async function serving() {
    if (served.value && Date.now() - served.at < ttlMs) return served.value;
    served = { at: Date.now(), value: await serve() ?? {} };
    return served.value;
  }

  async function probe(peer) {
    if (!peer.online) return { reachable: false, protocol: null, capabilities: [] };
    try {
      const res = await fetchImpl(`${peer.url}/health`, { signal: AbortSignal.timeout(2500), redirect: 'error' });
      if (!res.ok) return { reachable: false, protocol: null, capabilities: [] };
      const body = await res.json().catch(() => ({}));
      // A node answering with another machine's identity is not this machine.
      if (body.owner != null && body.owner !== peer.id) return { reachable: false, protocol: null, capabilities: [] };
      return {
        reachable: true,
        hosted: body.hosted === true,
        personal: body.owner === peer.id && body.hosted === false && body.protocol === MACHINE_PROTOCOL,
        protocol: Number.isInteger(body.protocol) ? body.protocol : 0,
        capabilities: Array.isArray(body.capabilities)
          ? body.capabilities.filter(item => MACHINE_CAPABILITIES.includes(item))
          : [],
      };
    } catch { return { reachable: false, protocol: null, capabilities: [] }; }
  }

  let reach = { at: 0, value: new Map() };
  async function reachable() {
    if (Date.now() - reach.at < ttlMs) return reach.value;
    const { peers } = await tailnet();
    const compute = peers.filter(peer => !['android', 'ios'].includes(peer.os));
    const answers = await Promise.all(compute.map(async peer => [peer.id, await probe(peer)]));
    reach = { at: Date.now(), value: new Map(answers) };
    return reach.value;
  }

  async function ownNode() {
    const { self } = await tailnet();
    const name = self?.name ?? shortName(hostname());
    return self ?? { id: name, name, dns: '', url: '', online: true };
  }

  return {
    async self() { return (await ownNode()).name; },
    async selfId() { return (await ownNode()).id; },
    async origins() {
      const self = await ownNode();
      return self.url ? [self.url] : [];
    },
    async published(port) {
      const self = await ownNode();
      return self.dns ? publishedAt(await serving(), self.dns, port) : '';
    },
    async list() {
      const { peers } = await tailnet();
      const me = await ownNode();
      const health = await reachable();
      // Offline machines remain in the inventory. Their resources are not
      // silently reassigned and their stale data is never presented as live.
      const compute = peers.filter(peer => !['android', 'ios'].includes(peer.os));
      const rows = compute.map(peer => publicMachine(peer, health.get(peer.id) ?? {}));
      return [publicMachine(me, { self: true }), ...rows.sort((a, b) => a.name.localeCompare(b.name))];
    },
    // Who asked through `tailscale serve`, by the address it says they came
    // from: one of the person's own devices (theirs, untagged, and not a
    // hosted computer by its own say), or null for anything else.
    async caller(ip) {
      const at = String(ip ?? '').replace(/^::ffff:/, '');
      if (!at) return null;
      const { self, peers } = await tailnet();
      if (self?.ips.includes(at)) return { id: self.id, name: self.name, self: true };
      const peer = peers.find(item => item.ips.includes(at));
      if (!peer || peer.tagged || peer.user == null || peer.user !== self?.user) return null;
      if (!['android', 'ios'].includes(peer.os)) {
        const info = (await reachable()).get(peer.id);
        // Unknown/unreachable is not evidence that a computer is personal.
        if (!info?.reachable || !info.personal) return null;
      }
      return { id: peer.id, name: peer.name, self: false };
    },
    // A destination must be a node Tailscale currently names and must have
    // answered our protocol probe. Name is retained for old links; stable id is
    // what new persisted locators use.
    async peer(identity) {
      const asked = String(identity ?? '');
      const { peers } = await tailnet();
      const peer = peers.find(item => !['android', 'ios'].includes(item.os) && (item.id === asked || item.name === asked.toLowerCase()));
      if (!peer) return null;
      // A preference notification/reconnect must not wait for every other
      // computer (or a phone with no backend) to time out. Probe only its
      // pinned destination; retain the health check, not the discovery barrier.
      const info = await probe(peer);
      return info?.reachable ? { ...peer, ...info } : null;
    },
  };
}

export function solitaryMachines(name = shortName(hostname())) {
  return {
    self: async () => name,
    selfId: async () => name,
    origins: async () => [],
    published: async () => '',
    list: async () => [{
      id: name, name, url: '', self: true, online: true, reachable: true,
      protocol: MACHINE_PROTOCOL, capabilities: [...MACHINE_CAPABILITIES],
    }],
    peer: async () => null,
    caller: async () => null,
  };
}
