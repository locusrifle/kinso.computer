import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, readdir, stat, writeFile, mkdir, chmod, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import { createGueyServer } from "../../../system/server.mjs";
import {
	resolvePromptUploads, openUpload, uploadReference, readAttachmentJson,
	receiveHttpUpload,
	sanitizeUploadName,
	uniqueUploadName,
	filenameFromHeader,
	MAX_UPLOAD_BYTES,
	UPLOAD_TIMEOUT_MS,
} from "../native/uploads.mjs";
import { noisePNG, tinyBMP } from '../native/test/attachment-fixture.mjs';
import { uploadPercent } from "../native/public/js/uploads.js";

// A tab host with one tab, the session an upload names (X-Session-Id).
function stubRuntime(cwd) {
	const events = new EventEmitter();
	const data = { cwd, sessionId: "up", busy: false, messages: [], failed: null, tabs: [{ id: "up", sessionId: "up", focused: true }] };
	return {
		events,
		data,
		snapshot: () => data,
		async command() { return {}; },
		async close() {},
	};
}

async function withApp(options, fn) {
	const root = await mkdtemp(join(tmpdir(), "guey-uploads-http-"));
	const runtime = stubRuntime(options.cwd ?? root);
	const app = await createGueyServer({
		port: 0,
		host: "127.0.0.1",
		stateDir: join(root, "state"),
		runtime,
		product: "imperfect",
		...options,
	});
	try {
		const address = await app.listen();
		const base = `http://127.0.0.1:${address.port}`;
		await fn({ app, runtime, root, base, port: address.port, origin: base });
	} finally {
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
}

function rawUpload({ port, origin, filename, body, contentLength, extraHeaders = {}, pauseBeforeBody, abortAfter }) {
	return new Promise((resolve, reject) => {
		const payload = Buffer.isBuffer(body) ? body : Buffer.from(body ?? "");
		const length = contentLength ?? payload.length;
		const sock = createConnection({ port, host: "127.0.0.1" }, () => {
			sock.write(
				`POST /upload HTTP/1.1\r\n` +
				`Host: 127.0.0.1:${port}\r\n` +
				`Origin: ${origin}\r\n` +
				`X-Session-Id: up\r\n` +
				`X-Filename: ${filename ?? "file"}\r\n` +
				`Content-Length: ${length}\r\n` +
				Object.entries(extraHeaders).map(([k, v]) => `${k}: ${v}\r\n`).join("") +
				`\r\n`,
			);
			const sendBody = () => {
				if (payload.length) sock.write(payload);
			};
			if (pauseBeforeBody) setTimeout(sendBody, pauseBeforeBody);
			else sendBody();
			if (abortAfter != null) setTimeout(() => sock.destroy(), abortAfter);
		});
		let data = Buffer.alloc(0);
		sock.on("data", chunk => {
			data = Buffer.concat([data, chunk]);
			if (data.includes("\r\n\r\n")) sock.end();
		});
		sock.on("error", () => resolve({ status: 0, raw: data.toString("utf8") }));
		sock.on("close", () => {
			const raw = data.toString("utf8");
			const status = Number((raw.match(/^HTTP\/1\.\d (\d+)/) || [])[1] || 0);
			const split = raw.indexOf("\r\n\r\n");
			resolve({ status, raw, body: split >= 0 ? raw.slice(split + 4) : "" });
		});
		sock.setTimeout(3000, () => sock.destroy());
	});
}

describe("scoped attachment references", () => {
  it("uses original paths for files, model image blocks for photos, and never overwrites originals", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "upload-ref-"));
    try {
      const target = { cwd, referenceKey: 'unit-test-only', tabId: 't1', sessionId: 's1', instanceId: 'host' };
      const save = async (bytes, filename) => {
        const req = Readable.from([bytes]); req.headers = {};
        return receiveHttpUpload(req, { cwd, filename });
      };
      const file = await save(Buffer.from('hello'), 'notes.txt');
      const png = noisePNG();
      const image = await save(png, 'misleading.txt');
      const command = { text: 'look', attachments: [
        { kind: 'file', reference: await uploadReference(file, target) },
        { kind: 'image', reference: await uploadReference(image, target) },
      ] };
      assert.ok(JSON.stringify(command).length < 1200, 'no image bytes in the command');
      const result = await resolvePromptUploads(command, target);
      assert.match(result.text, /uploaded file:.*notes-/);
      assert.match(result.text, /uploaded image original:.*misleading-/);
      assert.equal(result.images.length, 1);
      assert.equal(result.images[0].type, 'image');
      assert.ok(['image/png','image/jpeg'].includes(result.images[0].mimeType));
      assert.ok(result.images[0].data.length > 0 && result.images[0].data.length <= 1024 * 1024);
      assert.deepEqual(await readFile(image.path), png);
      const bomb = Buffer.from(png); bomb.writeUInt32BE(100000, 16); bomb.writeUInt32BE(100000, 20);
      const huge = await save(bomb, 'bomb.png');
      await assert.rejects(resolvePromptUploads({ attachments: [{ kind: 'image', reference: await uploadReference(huge, target) }] }, target), /megapixel/);
      const empty = await resolvePromptUploads({ text: 'plain' }, target);
      assert.deepEqual(empty, { text: 'plain', images: [] });
      await assert.rejects(resolvePromptUploads({ attachments: [null] }, target), /invalid attachment kind/);
      await assert.rejects(resolvePromptUploads({ attachments: Array(9).fill(command.attachments[0]) }, target), /at most 8/);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it("rejects arbitrary paths, forged identities, foreign sessions/computers, symlinks and oversized operations", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "upload-guard-"));
    try {
      const target = { cwd, referenceKey: 'unit-test-only', tabId: 't1', sessionId: 's1', instanceId: 'host' };
      const req = Readable.from([Buffer.from('secret')]); req.headers = {};
      const saved = await receiveHttpUpload(req, { cwd, filename: '../../secret.txt' });
      const reference = await uploadReference(saved, target);
      for (const name of ['../secret.txt', '/etc/passwd', '.upload-x.part'])
        await assert.rejects(openUpload({ ...reference, name }, target), /invalid attachment reference/);
      await assert.rejects(openUpload({ ...reference, sessionId: 's2' }, { ...target, sessionId: 's2' }), /seal does not match/);
      await assert.rejects(openUpload(reference, { ...target, sessionId: 's2' }), /another session/);
      await assert.rejects(openUpload(reference, { ...target, cwd: join(cwd, 'other') }), /seal does not match/);
      await assert.rejects(openUpload(reference, target, 5), /too large/);
      await rm(saved.path); await symlink('/etc/passwd', saved.path);
      await assert.rejects(openUpload(reference, target), { code: 'ELOOP' });
      await rm(join(cwd, 'uploads'), { recursive: true });
      await mkdir(join(cwd, 'elsewhere')); await symlink(join(cwd, 'elsewhere'), join(cwd, 'uploads'));
      await assert.rejects(openUpload(reference, target), /invalid uploads directory/);
      const again = Readable.from([Buffer.from('no')]); again.headers = {};
      await assert.rejects(receiveHttpUpload(again, { cwd }), /not a symlink/);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it("allows a lazy tab's own identity upgrade, never a reused host/tab", async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'upload-lazy-'));
    try {
      const target = { cwd, referenceKey: 'unit-test-only', tabId: 't1', sessionId: null, instanceId: 'host' };
      const req = Readable.from([Buffer.from('words')]); req.headers = {};
      const reference = await uploadReference(await receiveHttpUpload(req, { cwd }), target);
      const opened = await openUpload(reference, { ...target, sessionId: 'new' }); await opened.file.close();
      await assert.rejects(openUpload(reference, { ...target, instanceId: 'replacement' }), /another session/);
      await assert.rejects(openUpload(reference, { ...target, tabId: 't2' }), /another session/);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it("bounds chunked uploads and reference JSON without trusting Content-Length", async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'upload-chunks-'));
    try {
      const req = Readable.from([Buffer.alloc(8), Buffer.alloc(8)]); req.headers = {};
      await assert.rejects(receiveHttpUpload(req, { cwd, maxBytes: 10 }), /too large/);
      assert.deepEqual(await readdir(join(cwd, 'uploads')), []);
      await assert.rejects(readAttachmentJson(Readable.from([Buffer.alloc(1024 * 1024 + 1)])), /too large/);
      await assert.rejects(readAttachmentJson(Readable.from(['null'])), /must be JSON/);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });
});

describe("http upload names and progress", () => {
	it("sanitizes traversal and keeps a unique original stem", () => {
		assert.equal(sanitizeUploadName("../../etc/passwd"), "passwd");
		assert.equal(filenameFromHeader("notes%20v2.txt"), "notes v2.txt");
		assert.match(uniqueUploadName("notes.txt", "deadbeef"), /^notes-deadbeef\.txt$/);
		assert.equal(uploadPercent(0, 100), "0%");
		assert.equal(uploadPercent(42, 100), "42%");
		assert.equal(uploadPercent(100, 100), "100%");
		assert.equal(uploadPercent(5, 0), "…");
		assert.equal(MAX_UPLOAD_BYTES, 1024 * 1024 * 1024);
		assert.ok(UPLOAD_TIMEOUT_MS > 300_000);
	});
});

describe("POST /upload", () => {
	it("streams original bytes to a unique path under cwd/uploads", async () => {
		await withApp({}, async ({ base, origin, runtime }) => {
			const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
			const first = await fetch(`${base}/upload`, {
				method: "POST",
				headers: { Origin: origin, "X-Session-Id": "up", "X-Filename": "shot.png", "Content-Type": "application/octet-stream" },
				body: png,
			});
			assert.equal(first.status, 200);
			const a = await first.json();
			assert.deepEqual(await readFile(a.path), png);
			assert.match(a.name, /^shot-[0-9a-f-]+\.png$/);
			assert.equal(a.size, png.length);
			const info = await stat(a.path);
			assert.equal(info.mode & 0o777, 0o600);

			const second = await fetch(`${base}/upload`, {
				method: "POST",
				headers: { Origin: origin, "X-Session-Id": "up", "X-Filename": "shot.png" },
				body: png,
			});
			const b = await second.json();
			assert.notEqual(a.path, b.path);
			const names = await readdir(join(runtime.data.cwd, "uploads"));
			assert.equal(names.filter(n => n.endsWith(".part")).length, 0);
			assert.equal(names.length, 2);
		});
	});

	it("refuses a missing origin, a foreign origin, and a declared oversized file", async () => {
		await withApp({ uploadMaxBytes: 16 }, async ({ app, base, port, origin }) => {
			assert.equal(app.server.requestTimeout, 0);
			assert.equal(app.server.headersTimeout, 60_000);
			assert.equal((await fetch(`${base}/upload`, { method: "POST", headers: { "X-Session-Id": "up", "X-Filename": "a.txt" }, body: "hi" })).status, 403);
			assert.equal((await fetch(`${base}/upload`, { method: "POST", headers: { Origin: "https://evil.example", "X-Session-Id": "up", "X-Filename": "a.txt" }, body: "hi" })).status, 403);
			// Use the wire helper: Pi's installed Undici dispatcher rejects a
			// manually supplied fetch Content-Length before reaching the server.
			const huge = await rawUpload({
				port, origin, filename: "big.bin", contentLength: 17, body: "",
			});
			assert.equal(huge.status, 413);
			assert.deepEqual(await readdir(join(app.runtime.snapshot().cwd, "uploads")).catch(() => []), []);
		});
	});

	it("keeps a traversing filename inside uploads and does not follow it out", async () => {
		await withApp({}, async ({ base, origin, runtime }) => {
			const res = await fetch(`${base}/upload`, {
				method: "POST",
				headers: { Origin: origin, "X-Session-Id": "up", "X-Filename": encodeURIComponent("../../etc/passwd") },
				body: "secret",
			});
			assert.equal(res.status, 200);
			const saved = await res.json();
			assert.equal(saved.path.startsWith(join(runtime.data.cwd, "uploads") + "/"), true);
			assert.doesNotMatch(saved.path, /\/etc\//);
			assert.equal(await readFile(saved.path, "utf8"), "secret");
		});
	});

	it("writes to the cwd frozen at request start if the focused tab changes", async () => {
		await withApp({}, async ({ port, origin, runtime, root }) => {
			const first = runtime.data.cwd;
			const moved = join(root, "other-tab");
			const result = await new Promise((resolve, reject) => {
				const sock = createConnection({ port, host: "127.0.0.1" }, () => {
					sock.write(
						`POST /upload HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: ${origin}\r\nX-Session-Id: up\r\nX-Filename: tab.txt\r\nContent-Length: 4\r\n\r\n`,
					);
					setTimeout(() => {
						runtime.data.cwd = moved;
						sock.write("keep");
					}, 40);
				});
				let data = "";
				sock.on("data", c => {
					data += c;
					if (data.includes("\r\n\r\n")) sock.end();
				});
				sock.on("close", () => resolve(data));
				sock.on("error", reject);
				sock.setTimeout(3000, () => sock.destroy());
			});
			const split = result.indexOf("\r\n\r\n");
			const saved = JSON.parse(result.slice(split + 4));
			assert.equal(saved.path.startsWith(join(first, "uploads")), true);
			assert.equal(await readFile(saved.path, "utf8"), "keep");
			assert.equal(runtime.data.cwd, moved);
		});
	});

	it("times out a stalled body and leaves no partial", async () => {
		await withApp({ uploadTimeoutMs: 80 }, async ({ port, origin, runtime }) => {
			const result = await rawUpload({
				port,
				origin,
				filename: "slow.bin",
				body: "",
				contentLength: 64,
				pauseBeforeBody: 400,
			});
			assert.equal(result.status, 408);
			const dir = join(runtime.data.cwd, "uploads");
			const names = await readdir(dir).catch(() => []);
			assert.deepEqual(names, []);
		});
	});

	it("cleans a dropped connection's partial file", async () => {
		await withApp({}, async ({ port, origin, runtime }) => {
			await rawUpload({
				port,
				origin,
				filename: "drop.bin",
				body: "partial",
				contentLength: 64,
				abortAfter: 20,
			});
			await new Promise(r => setTimeout(r, 50));
			const names = await readdir(join(runtime.data.cwd, "uploads")).catch(() => []);
			assert.equal(names.some(n => n.endsWith(".part")), false);
			assert.equal(names.length, 0);
		});
	});

	it("does not overwrite or delete an existing dest when the preferred name collides", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "guey-upload-collide-"));
		try {
			const dir = join(cwd, "uploads");
			await mkdir(dir, { recursive: true, mode: 0o700 });
			const existing = join(dir, "notes-fixed.txt");
			await writeFile(existing, "keep me", { mode: 0o600 });
			const req = Readable.from([Buffer.from("fresh")]);
			req.headers = { "content-length": "5", "x-filename": "notes.txt" };
			const saved = await receiveHttpUpload(req, { cwd, filename: "notes.txt", uniqueName: "notes-fixed.txt" });
			assert.notEqual(saved.path, existing);
			assert.equal(await readFile(existing, "utf8"), "keep me");
			assert.equal(await readFile(saved.path, "utf8"), "fresh");
			assert.match(saved.name, /^notes-[0-9a-f-]+\.txt$/);
			const leftovers = (await readdir(dir)).filter(n => n.endsWith(".part") || n.startsWith(".upload-"));
			assert.deepEqual(leftovers, []);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("filesystem failure does not kill the server", async () => {
		await withApp({}, async ({ base, origin, runtime }) => {
			const blocked = join(runtime.data.cwd, "uploads");
			await writeFile(blocked, "not a directory");
			const blockedRes = await fetch(`${base}/upload`, {
				method: "POST",
				headers: { Origin: origin, "X-Session-Id": "up", "X-Filename": "a.txt" },
				body: "hello",
			});
			assert.equal(blockedRes.status, 500);
			assert.equal((await fetch(`${base}/health`)).status, 200);
			await rm(blocked);
			await mkdir(blocked, { mode: 0o700 });
			await chmod(blocked, 0o500);
			try {
				const denied = await fetch(`${base}/upload`, {
					method: "POST",
					headers: { Origin: origin, "X-Session-Id": "up", "X-Filename": "b.txt" },
					body: "hello",
				});
				assert.equal(denied.status, 500);
				assert.equal((await fetch(`${base}/health`)).status, 200);
				assert.equal((await readdir(blocked)).some(n => n.endsWith(".part")), false);
			} finally {
				await chmod(blocked, 0o700);
			}
		});
	});
});

it('keeps seals through a real process restart and session reopen, but not a replaced lazy host', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const root = await mkdtemp(join(tmpdir(), 'upload-restart-'));
  // Both invocations use the actual HTTP server, persisted open-tabs mapping,
  // and private default session-token convention in an isolated HOME.
  const script = `
    import assert from 'node:assert/strict';
    import { readFile, writeFile, stat } from 'node:fs/promises';
    import { join } from 'node:path';
    import { Readable } from 'node:stream';
    import { EventEmitter } from 'node:events';
    import { createGueyServer } from './system/server.mjs';
    import { createTabHost } from './apps/code/native/tabs.mjs';
    import { receiveHttpUpload, uploadReference, openUpload } from './apps/code/native/uploads.mjs';
    const root = process.env.HOME, phase = process.argv[1], calls = [];
    const host = await createTabHost({ stateDir: join(root, 'state'), firstTab: 'claude', claudeAvailable: () => true,
      createClaudeRuntime: async opts => ({ events: new EventEmitter(),
        snapshot: () => ({ cwd: root, sessionId: opts.sessionPath ?? 'stable-session', busy: false, messages: [{ role: 'user', content: 'saved' }] }),
        command: async c => { if (c.type === 'prompt') calls.push(c); return { accepted: true }; }, close: async () => {} }),
    });
    const app = await createGueyServer({ port: 0, stateDir: join(root, 'server'), runtime: host });
    try {
      const { port } = await app.listen(), origin = 'http://127.0.0.1:' + port;
      if (phase === 'save') {
        const response = await fetch(origin + '/upload', { method: 'POST', headers: { origin, 'x-tab-id': 't1', 'x-session-id': 'stable-session', 'x-filename': 'plan.txt' }, body: 'persisted original' });
        assert.equal(response.status, 200);
        const saved = await response.json();
        const req = Readable.from(['lazy original']); req.headers = {};
        const lazyTarget = { cwd: root, tabId: 't1', sessionId: null, instanceId: host.snapshot().instanceId };
        const lazy = await uploadReference(await receiveHttpUpload(req, { cwd: root }), lazyTarget);
        await writeFile(join(root, 'references.json'), JSON.stringify({ saved, lazy, lazyTarget }));
        assert.equal((await stat(join(root, '.imperfect', 'session-token'))).mode & 0o777, 0o600);
      } else {
        const { saved, lazy, lazyTarget } = JSON.parse(await readFile(join(root, 'references.json')));
        assert.notEqual(host.snapshot().instanceId, saved.reference.instanceId, 'actual new host/process');
        assert.equal(host.snapshot().sessionId, 'stable-session', 'persisted tab restored');
        const command = { type: 'prompt', text: 'read', attachments: [{ kind: 'file', reference: saved.reference }] };
        await host.command(command, 't1');
        await host.command({ type: 'tab-close', tabId: 't1' });
        const reopened = await host.command({ type: 'tab-open', path: 'stable-session', agent: 'claude' });
        assert.notEqual(reopened.id, saved.reference.tabId, 'same session in a new tab');
        await host.command(command, reopened.id);
        assert.equal(calls.length, 2);
        assert.match(calls[1].text, /uploaded file:/);
        assert.equal(await readFile(saved.path, 'utf8'), 'persisted original');
        await assert.rejects(openUpload(lazy, { ...lazyTarget, instanceId: host.snapshot().instanceId }), /another session/);
        // HTTP reference readers use the same persisted authority as prompts.
        const response = await fetch(origin + '/transcribe', { method: 'POST', headers: { origin, 'content-type': 'application/json' },
          body: JSON.stringify({ tab: reopened.id, session: 'stable-session', audio: { ...saved.reference, sessionId: 'forged' } }) });
        assert.equal(response.status, 409);
      }
    } finally { await app.close(); }
  `;
  try {
    for (const phase of ['save', 'reopen']) await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, phase], {
      cwd: process.cwd(), env: { ...process.env, HOME: root, IMPERFECT_PREFIX: join(root, '.imperfect') }, timeout: 20_000,
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('rejects restamped scope, another owner sharing the same cwd/SID, and invalid seals without losing valid reopened SID references', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'upload-forgery-'));
  try {
    const target = { cwd, referenceKey: 'owner-a-private-test-token', tabId: 't1', sessionId: 's1', instanceId: 'old-host' };
    const req = Readable.from(['owner original']); req.headers = {};
    const saved = await receiveHttpUpload(req, { cwd });
    const reference = await uploadReference(saved, target);
    const reopen = { ...target, instanceId: 'new-host', tabId: 't9' };
    const opened = await openUpload(reference, reopen); await opened.file.close();
    await assert.rejects(openUpload(reference, { ...reopen, referenceKey: 'owner-b-private-test-token' }), /seal does not match/);
    for (const forged of [{ tabId: 't9' }, { instanceId: 'new-host' }, { sessionId: null }, { sessionId: 's2' },
      { seal: '' }, { seal: '0'.repeat(64) }, { seal: reference.seal + 'zz' }, { seal: reference.seal.slice(2) }]) {
      await assert.rejects(openUpload({ ...reference, ...forged }, reopen), /seal does not match/);
    }
    const other = await receiveHttpUpload(Object.assign(Readable.from(['other']), { headers: {} }), { cwd });
    await assert.rejects(openUpload({ ...reference, name: other.name }, reopen), /seal does not match/);
    await assert.rejects(openUpload(reference, { ...target, sessionId: 's2' }), /another session/);
    await assert.rejects(openUpload(reference, { ...target, cwd: join(cwd, 'other') }), /seal does not match/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});


it('converts browser-decodable BMP to model PNG without changing its original or accepting bitmap bombs', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'upload-bitmap-'));
  try {
    const target = { cwd, referenceKey: 'bitmap-test-only', tabId: 't1', sessionId: 's1', instanceId: 'host' };
    const save = bytes => receiveHttpUpload(Object.assign(Readable.from([bytes]), { headers: {} }), { cwd, filename: 'misleading.txt' });
    const bmp = tinyBMP(), saved = await save(bmp);
    const prepare = reference => resolvePromptUploads({ attachments: [{ kind: 'image', reference }] }, target);
    const result = await prepare(await uploadReference(saved, target));
    assert.equal(result.images[0].mimeType, 'image/png');
    assert.equal(Buffer.from(result.images[0].data, 'base64').subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.deepEqual(await readFile(saved.path), bmp);
    const bomb = Buffer.from(bmp); bomb.writeInt32LE(100000, 18); bomb.writeInt32LE(100000, 22);
    await assert.rejects(prepare(await uploadReference(await save(bomb), target)), /megapixel/);
    const truncated = Buffer.from('BM');
    await assert.rejects(prepare(await uploadReference(await save(truncated), target)), /bitmap header/);
    const unsupported = Buffer.from('00000018667479706865696300000000686569636d696631', 'hex');
    await assert.rejects(prepare(await uploadReference(await save(unsupported), target)), /unsupported picture; original saved/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
