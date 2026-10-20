import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { crc32, deflateSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { IMAGE_TOOL, apiSize, chatgptSignIn, createImageBox, pictureSize, runGenerateImage as generate } from '../images.mjs';
const runGenerateImage = (args, deps) => generate({ session: 'said-yes', ui: { confirm: async () => true }, ...args }, deps);
import { PREVIEW_BYTES } from '../request-images.mjs';
import { resizeImage } from '@earendil-works/pi-coding-agent';

const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const login = async () => ({ token: 'tok', accountId: 'acct' });

function answering(status, body) {
  const asked = [];
  const post = async (url, init) => {
    asked.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  };
  return { asked, post };
}

async function folder(t) {
  const dir = await mkdtemp(join(tmpdir(), 'generate-image-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('generate_image asks the ChatGPT Images API the way Codex does and saves the PNG in the session folder', async t => {
  const cwd = await folder(t);
  const { asked, post } = answering(200, { data: [{ b64_json: PIXEL }], size: '1024x1024' });
  const answer = await runGenerateImage({ prompt: 'A pink bloom, flat vector!', size: '1024x1024', background: 'transparent', cwd },
    { fetch: post, signIn: login, now: new Date(2026, 9, 1, 12, 34, 56) });
  assert.equal(asked.length, 1);
  assert.equal(asked[0].url, 'https://chatgpt.com/backend-api/codex/images/generations');
  assert.equal(asked[0].headers.authorization, 'Bearer tok');
  assert.equal(asked[0].headers['chatgpt-account-id'], 'acct');
  assert.deepEqual(asked[0].body, { prompt: 'A pink bloom, flat vector!', model: 'gpt-image-2', background: 'transparent', quality: 'auto', size: '1024x1024' });
  const file = join(cwd, 'images', 'a-pink-bloom-flat-vector-20261001-123456.png');
  assert.deepEqual(await readFile(file), Buffer.from(PIXEL, 'base64'));
  assert.match(answer[0].text, new RegExp(`saved as PNG at ${file}`));
  assert.deepEqual(answer[1], { type: 'image', data: PIXEL, mimeType: 'image/png' });
});

// A PNG of noise, which no encoder shrinks: as heavy as a real picture.
function noisePNG(width, height) {
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0); out.write(type, 4, 'latin1'); data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(width, 0); head.writeUInt32BE(height, 4); head[8] = 8; head[9] = 2;
  const rows = Buffer.concat(Array.from({ length: height }, () => Buffer.concat([Buffer.from([0]), randomBytes(width * 3)])));
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', head), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

test('generate_image keeps the full PNG but shows the model a preview small enough to resend every turn', async t => {
  const cwd = await folder(t);
  const big = noisePNG(640, 640);
  const { post } = answering(200, { data: [{ b64_json: big.toString('base64') }] });
  const answer = await runGenerateImage({ prompt: 'static', out: 'static.png', cwd }, { fetch: post, signIn: login });
  assert.deepEqual(await readFile(join(cwd, 'static.png')), big);
  assert.ok(big.toString('base64').length > 1_000_000);
  assert.equal(answer[1].mimeType, 'image/jpeg');
  assert.ok(answer[1].data.length <= PREVIEW_BYTES, `preview is ${answer[1].data.length} bytes`);
  assert.match(answer[0].text, /JPEG preview; the PNG file is the full picture/);
});

test('generate_image with input_images edits them, sent inline, and saves where it is told', async t => {
  const cwd = await folder(t);
  await writeFile(join(cwd, 'cat.png'), Buffer.from(PIXEL, 'base64'));
  const { asked, post } = answering(200, { data: [{ b64_json: PIXEL }] });
  const answer = await runGenerateImage({ prompt: 'give it a hat', input_images: ['cat.png'], out: 'art/hat', cwd }, { fetch: post, signIn: login });
  assert.equal(asked[0].url, 'https://chatgpt.com/backend-api/codex/images/edits');
  assert.deepEqual(asked[0].body.images, [{ image_url: `data:image/png;base64,${PIXEL}` }]);
  assert.equal(asked[0].body.size, 'auto', 'the subscription is not told the input\'s size');
  assert.match(answer[0].text, /^Changed the picture/);
  assert.ok((await readFile(join(cwd, 'art', 'hat.png'))).length > 0);
});

test('generate_image without a ChatGPT sign-in says how to sign in, and asks nothing', async t => {
  const cwd = await folder(t);
  assert.equal(await chatgptSignIn([join(cwd, 'auth.json')]), null);
  const { asked, post } = answering(200, {});
  await assert.rejects(runGenerateImage({ prompt: 'x', cwd }, { fetch: post, signIn: async () => null }), /sign in with ChatGPT/);
  assert.equal(asked.length, 0);
});

test('generate_image reads the sign-in Pi stored', async t => {
  const cwd = await folder(t);
  const claims = { exp: Math.floor(Date.now() / 1000) + 3600, 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-1' } };
  const access = ['e30', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'sig'].join('.');
  const file = join(cwd, 'auth.json');
  await writeFile(file, JSON.stringify({ 'openai-codex': { type: 'oauth', access, refresh: 'r', expires: Date.now() + 3600_000, accountId: 'acct-1' } }), { mode: 0o600 });
  assert.deepEqual(await chatgptSignIn([join(cwd, 'missing.json'), file]), { token: access, accountId: 'acct-1' });
});

test('generate_image passes on what ChatGPT refused', async t => {
  const cwd = await folder(t);
  const { post } = answering(429, { error: { message: 'image_gen limit reached' } });
  await assert.rejects(runGenerateImage({ prompt: 'x', cwd }, { fetch: post, signIn: login }), /limit for pictures.*image_gen limit reached/);
});

for (const phase of ['before sign-in', 'during request', 'after response']) {
  test(`generate_image stopped ${phase} saves no picture`, async t => {
    const cwd = await folder(t);
    const stop = new AbortController();
    let requested = false, signedIn = false;
    if (phase === 'before sign-in') stop.abort();
    const result = runGenerateImage({ prompt: 'x', out: 'stopped.png', cwd, signal: stop.signal }, {
      signIn: async () => { signedIn = true; return login(); },
      fetch: async (_url, { signal }) => {
        requested = true;
        assert.equal(signal.aborted, false);
        stop.abort();
        if (phase === 'during request') {
          signal.throwIfAborted();
          throw new Error('The request did not receive cancellation');
        }
        return new Response(JSON.stringify({ data: [{ b64_json: PIXEL }] }));
      },
    });
    await assert.rejects(result, { name: 'AbortError' });
    assert.equal(requested, phase !== 'before sign-in');
    assert.equal(signedIn, phase !== 'before sign-in');
    await assert.rejects(readFile(join(cwd, 'stopped.png')), { code: 'ENOENT' });
  });
}

// OpenAI's Images API, faked: what it was asked, form or JSON, and a picture
// of the size given, said to be of the quality given.
function openai({ status = 200, size = [32, 16], quality = 'high', error } = {}) {
  const asked = [];
  const picture = noisePNG(...size);
  const send = async (url, init) => {
    const form = init.body instanceof FormData;
    const fields = form ? Object.fromEntries([...init.body.keys()].map(k => [k, init.body.getAll(k)])) : JSON.parse(init.body);
    asked.push({ url, headers: init.headers, form, fields });
    if (status !== 200) return new Response(JSON.stringify({ error: { message: error } }), { status });
    return new Response(JSON.stringify({ data: [{ b64_json: picture.toString('base64') }], size: size.join('x'), quality, output_format: 'png' }));
  };
  return { asked, send, picture };
}

async function withKey(dir, key = 'sk-test-123') {
  const file = join(dir, 'credentials', 'openai-api-key');
  await mkdir(join(dir, 'credentials'), { recursive: true });
  await writeFile(file, `${key}\n`);
  return file;
}

const nobody = async () => { throw new Error('the box was asked'); };

test('without a model, and with model subscription, it is the subscription, even with an API key on the computer', async t => {
  const cwd = await folder(t);
  const key = await withKey(cwd);
  for (const model of [undefined, 'subscription']) {
    const { asked, post } = answering(200, { data: [{ b64_json: PIXEL }] });
    const answer = await runGenerateImage({ prompt: 'a bloom', model, cwd }, { fetch: post, signIn: login, key, box: nobody });
    assert.equal(asked.length, 1);
    assert.equal(asked[0].url, 'https://chatgpt.com/backend-api/codex/images/generations');
    assert.deepEqual(asked[0].body, { prompt: 'a bloom', model: 'gpt-image-2', quality: 'auto', size: 'auto' });
    assert.match(answer[0].text, /^Made the picture through the ChatGPT subscription \(its backend picks the model itself\): 1x1, saved as PNG/);
  }
  assert.ok(IMAGE_TOOL.parameters.properties.model.description.startsWith('subscription (default)'));
});

test('the subscription\'s answer says what size it really came out', async t => {
  const cwd = await folder(t);
  const big = noisePNG(64, 64);
  const { post } = answering(200, { data: [{ b64_json: big.toString('base64') }], model: 'gpt-image-2.5-flare' });
  const answer = await runGenerateImage({ prompt: 'x', size: '1024x1536', quality: 'high', cwd }, { fetch: post, signIn: login });
  assert.match(answer[0].text, /\(its backend picks the model itself; it said gpt-image-2\.5-flare\): 64x64 \(asked 1024x1536\), saved/);
});

test('model sunburst asks OpenAI\'s Images API with the key here, and says the model, size and quality it made', async t => {
  const cwd = await folder(t);
  const key = await withKey(cwd);
  const api = openai({ quality: 'xhigh' });
  const answer = await runGenerateImage({ prompt: 'a painting', model: 'sunburst', size: '32x16', quality: 'xhigh', background: 'opaque', out: 'p.png', cwd },
    { fetch: api.send, signIn: async () => { throw new Error('the subscription was asked'); }, key, box: nobody });
  assert.equal(api.asked.length, 1);
  assert.equal(api.asked[0].url, 'https://api.openai.com/v1/images/generations');
  assert.equal(api.asked[0].headers.authorization, 'Bearer sk-test-123');
  assert.deepEqual(api.asked[0].fields, { model: 'gpt-image-2.5-sunburst', prompt: 'a painting', size: '32x16', quality: 'xhigh', background: 'opaque' });
  assert.deepEqual(await readFile(join(cwd, 'p.png')), api.picture);
  assert.equal(answer[0].text, `Made the picture with gpt-image-2.5-sunburst through OpenAI's Images API (the API key on this computer): 32x16, quality xhigh, saved as PNG at ${join(cwd, 'p.png')}.`);
});

test('an API answer not of the size or quality asked says so', async t => {
  const cwd = await folder(t);
  const api = openai({ size: [48, 48], quality: 'low' });
  const answer = await runGenerateImage({ prompt: 'x', model: 'flare', size: '1024x1536', quality: 'high', cwd }, { fetch: api.send, key: await withKey(cwd), box: nobody });
  assert.match(answer[0].text, /gpt-image-2\.5-flare .*: 48x48 \(asked 1024x1536\), quality low \(asked high\), saved/);
});

test('an edit on the API sends each picture as image[] and the mask beside them', async t => {
  const cwd = await folder(t);
  const frame = noisePNG(32, 16);
  const mask = noisePNG(32, 16);
  await writeFile(join(cwd, 'frame-01.png'), frame);
  await writeFile(join(cwd, 'arm.png'), mask);
  await writeFile(join(cwd, 'figure.jpg'), Buffer.from('jpeg'));
  const api = openai();
  const answer = await runGenerateImage({ prompt: 'raise the left arm a little', model: 'sunburst', input_images: ['frame-01.png', 'figure.jpg'], mask: 'arm.png', quality: 'max', cwd },
    { fetch: api.send, key: await withKey(cwd), box: nobody });
  const [call] = api.asked;
  assert.equal(call.url, 'https://api.openai.com/v1/images/edits');
  assert.equal(call.form, true);
  assert.equal(call.headers['content-type'], undefined);
  assert.deepEqual(call.fields.model, ['gpt-image-2.5-sunburst']);
  assert.deepEqual(call.fields.quality, ['max']);
  assert.deepEqual(call.fields.size, ['1152x576'], 'no size asked: the first frame\'s shape, at no fewer pixels than the API takes');
  assert.deepEqual(call.fields.prompt, ['raise the left arm a little']);
  const images = call.fields['image[]'];
  assert.deepEqual(images.map(i => i.type), ['image/png', 'image/jpeg']);
  assert.deepEqual(Buffer.from(await images[0].arrayBuffer()), frame);
  assert.equal(call.fields.mask[0].type, 'image/png');
  assert.deepEqual(Buffer.from(await call.fields.mask[0].arrayBuffer()), mask);
  assert.match(answer[0].text, /^Changed the picture with gpt-image-2\.5-sunburst through OpenAI's Images API \(the API key on this computer\), masked: 32x16, quality high/);
});

test('what only the API can do is refused on the subscription, and a wrong mask anywhere, before anything is asked', async t => {
  const cwd = await folder(t);
  await writeFile(join(cwd, 'a.png'), noisePNG(32, 16));
  await writeFile(join(cwd, 'm.png'), noisePNG(16, 16));
  await writeFile(join(cwd, 'm.webp'), Buffer.from('webp'));
  const { asked, post } = answering(200, {});
  const key = await withKey(cwd);
  const deps = { fetch: post, signIn: login, key, box: nobody };
  await assert.rejects(runGenerateImage({ prompt: 'x', input_images: ['a.png'], mask: 'm.png', cwd }, deps), /mask needs model sunburst or flare/);
  await assert.rejects(runGenerateImage({ prompt: 'x', quality: 'max', cwd }, deps), /Quality max needs model sunburst or flare/);
  await assert.rejects(runGenerateImage({ prompt: 'x', model: 'dall-e', cwd }, deps), /subscription, sunburst or flare, not dall-e/);
  await assert.rejects(runGenerateImage({ prompt: 'x', model: 'sunburst', mask: 'm.png', cwd }, deps), /mask goes with input_images/);
  await assert.rejects(runGenerateImage({ prompt: 'x', model: 'sunburst', input_images: ['a.png'], mask: 'm.png', cwd }, deps), /mask is 16x16 but .*a\.png is 32x16/);
  await assert.rejects(runGenerateImage({ prompt: 'x', model: 'flare', input_images: ['a.png'], mask: 'm.webp', cwd }, deps), /not a PNG/);
  assert.equal(asked.length, 0);
});

test('without the key here or a computer that keeps it, the API says where the key goes', async t => {
  const cwd = await folder(t);
  const api = openai();
  const key = join(cwd, 'credentials', 'openai-api-key');
  await assert.rejects(runGenerateImage({ prompt: 'x', model: 'sunburst', cwd }, { fetch: api.send, key, box: async () => null }),
    new RegExp(`no OpenAI API key.*${key.replace(/[/.]/g, '\\$&')}`));
  await assert.rejects(runGenerateImage({ prompt: 'x', model: 'sunburst', cwd }, { fetch: api.send, key, box: async () => ({ url: '', name: 'desktop' }) }),
    /kept on desktop, and this computer cannot reach it/);
  assert.equal(api.asked.length, 0);
});

test('what OpenAI refused is passed on without the key', async t => {
  const cwd = await folder(t);
  const api = openai({ status: 401, error: 'Incorrect API key provided: sk-test-123' });
  await assert.rejects(runGenerateImage({ prompt: 'x', model: 'flare', cwd }, { fetch: api.send, key: await withKey(cwd), box: nobody }), error => {
    assert.match(error.message, /did not accept the API key in .*openai-api-key \(401\): Incorrect API key provided: \[key\]/);
    assert.doesNotMatch(error.message, /sk-test/);
    return true;
  });
});

// The authority: a computer keeping the key, answering /images/make for the
// others, its OpenAI faked. `seen` is what reached it.
async function authority(t, { key = true } = {}) {
  const dir = await folder(t);
  const file = key ? await withKey(dir, 'sk-on-the-pc') : join(dir, 'none', 'openai-api-key');
  const api = openai({ quality: 'medium' });
  const seen = [];
  const handle = createImageBox({ key: file, fetch: api.send });
  const server = createServer(async (req, res) => {
    seen.push({ path: req.url, origin: req.headers.origin });
    if (!await handle(req, res, new URL(req.url, 'http://pc').pathname)) res.writeHead(404).end();
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise(done => server.close(done)));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, seen, api, where: async () => ({ url, name: 'desktop' }) };
}

test('a computer without the key has the authority make the picture, mask and all, and gets the PNG back', async t => {
  const pc = await authority(t);
  const cwd = await folder(t);
  const frame = noisePNG(32, 16), mask = noisePNG(32, 16);
  await writeFile(join(cwd, 'f.png'), frame);
  await writeFile(join(cwd, 'm.png'), mask);
  const answer = await runGenerateImage({ prompt: 'move the arm', model: 'flare', input_images: ['f.png'], mask: 'm.png', size: '32x16', quality: 'medium', out: 'f2.png', cwd },
    { key: join(cwd, 'no-key'), box: pc.where, signIn: async () => { throw new Error('the subscription was asked'); } });
  assert.deepEqual(pc.seen, [{ path: '/images/make', origin: pc.url }]);
  const [call] = pc.api.asked;
  assert.equal(call.url, 'https://api.openai.com/v1/images/edits');
  assert.equal(call.headers.authorization, 'Bearer sk-on-the-pc');
  assert.deepEqual(call.fields.model, ['gpt-image-2.5-flare']);
  assert.deepEqual(call.fields.size, ['32x16']);
  assert.deepEqual(Buffer.from(await call.fields['image[]'][0].arrayBuffer()), frame);
  assert.deepEqual(Buffer.from(await call.fields.mask[0].arrayBuffer()), mask);
  assert.deepEqual(await readFile(join(cwd, 'f2.png')), pc.api.picture);
  assert.match(answer[0].text, /^Changed the picture with gpt-image-2\.5-flare through OpenAI's Images API \(the API key on desktop\), masked: 32x16, quality medium, saved/);
});

test('the key here is used here, without asking the authority', async t => {
  const pc = await authority(t);
  const cwd = await folder(t);
  const api = openai();
  await runGenerateImage({ prompt: 'x', model: 'sunburst', cwd }, { fetch: api.send, key: await withKey(cwd), box: pc.where });
  assert.deepEqual(pc.seen, []);
  assert.equal(api.asked.length, 1);
});

test('the authority without the key says so, and answers nothing without the exact origin', async t => {
  const pc = await authority(t, { key: false });
  const cwd = await folder(t);
  await assert.rejects(runGenerateImage({ prompt: 'x', model: 'sunburst', cwd }, { key: join(cwd, 'no-key'), box: pc.where }),
    /desktop, which keeps the OpenAI API key, answered: This computer has no OpenAI API key/);
  const bare = await fetch(`${pc.url}/images/make`, { method: 'POST', body: '{}' });
  assert.equal(bare.status, 403);
  assert.equal(pc.api.asked.length, 0);
});

test('a picture\'s own size is read from PNG, JPEG and each kind of WebP', async () => {
  assert.deepEqual(pictureSize(noisePNG(70, 40)), [70, 40]);
  // A real JPEG, as Pi's resizer makes the previews.
  const preview = await resizeImage(noisePNG(640, 480), 'image/png', { maxBytes: 60_000 });
  assert.equal(preview.mimeType, 'image/jpeg');
  assert.deepEqual(pictureSize(Buffer.from(preview.data, 'base64')), [preview.width, preview.height]);
  const riff = (chunk, body) => Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP' + chunk), Buffer.alloc(4), body]);
  const lossy = Buffer.alloc(14); lossy.writeUInt16LE(1254, 6); lossy.writeUInt16LE(1254, 8);
  assert.deepEqual(pictureSize(riff('VP8 ', lossy)), [1254, 1254]);
  // VP8L: 14 bits each of width-1 and height-1 after the 0x2f signature.
  const bits = (1023 - 1) | ((768 - 1) << 14);
  const lossless = Buffer.from([0x2f, bits & 0xff, (bits >> 8) & 0xff, (bits >> 16) & 0xff, (bits >> 24) & 0xff, 0, 0, 0, 0, 0]);
  assert.deepEqual(pictureSize(riff('VP8L', lossless)), [1023, 768]);
  const extended = Buffer.alloc(10); extended.writeUIntLE(3840 - 1, 4, 3); extended.writeUIntLE(2160 - 1, 7, 3);
  assert.deepEqual(pictureSize(riff('VP8X', extended)), [3840, 2160]);
  assert.equal(pictureSize(Buffer.from('not a picture at all, not one bit of it')), null);
});

test('the size sent for an input is the nearest the API takes, keeping its shape', () => {
  assert.equal(apiSize(1024, 1024), '1024x1024');
  assert.equal(apiSize(1536, 864), '1536x864');
  assert.equal(apiSize(1023, 1000), '1024x1008');
  assert.equal(apiSize(70, 40), '1072x624', 'too few pixels for the API: asked larger, same shape');
  assert.equal(apiSize(512, 512), '816x816');
  assert.equal(apiSize(7680, 4320), '3840x2160');
  assert.equal(apiSize(2160, 3840), '2160x3840');
  assert.equal(apiSize(4000, 4000), '2160x2160');
  assert.equal(apiSize(2400, 600), '2400x800', 'wider than 3:1 becomes 3:1');
  for (const [w, h] of [[5, 5000], [9999, 7], [333, 1001], [3841, 2161]]) {
    const [x, y] = apiSize(w, h).split('x').map(Number);
    assert.ok(x % 16 === 0 && y % 16 === 0 && x <= 3 * y && y <= 3 * x && Math.max(x, y) <= 3840 && Math.min(x, y) <= 2160 && x * y >= 655360, `${w}x${h} -> ${x}x${y}`);
  }
});

test('an API edit with no size asked sends the first input\'s size, and says when the picture still came back otherwise', async t => {
  const cwd = await folder(t);
  await writeFile(join(cwd, 'frame.png'), noisePNG(1024, 640));
  await writeFile(join(cwd, 'odd.png'), noisePNG(1030, 700));
  await writeFile(join(cwd, 'tiny.png'), noisePNG(64, 64));
  const key = await withKey(cwd);

  const same = openai({ size: [1024, 640] });
  const kept = await runGenerateImage({ prompt: 'raise the arm', model: 'sunburst', input_images: ['frame.png'], size: 'auto', cwd }, { fetch: same.send, key, box: nobody });
  assert.deepEqual(same.asked[0].fields.size, ['1024x640']);
  assert.match(kept[0].text, /: 1024x640, quality high, saved/);
  assert.doesNotMatch(kept[0].text, /first input/);

  const other = openai({ size: [48, 48] });
  const wrong = await runGenerateImage({ prompt: 'raise the arm', model: 'flare', input_images: ['frame.png'], cwd }, { fetch: other.send, key, box: nobody });
  assert.match(wrong[0].text, /: 48x48 \(not the size of the first input picture, 1024x640; that size was asked\), quality high/);

  const near = openai({ size: [1024, 704] });
  const fitted = await runGenerateImage({ prompt: 'x', model: 'flare', input_images: ['odd.png', 'frame.png'], cwd }, { fetch: near.send, key, box: nobody });
  assert.deepEqual(near.asked[0].fields.size, ['1024x704']);
  assert.match(fitted[0].text, /: 1024x704 \(not the size of the first input picture, 1030x700; asked 1024x704, the nearest size the API takes to it\)/);

  const small = openai({ size: [816, 816] });
  await runGenerateImage({ prompt: 'x', model: 'flare', input_images: ['tiny.png'], cwd }, { fetch: small.send, key, box: nobody });
  assert.deepEqual(small.asked[0].fields.size, ['816x816'], 'too few pixels for the API: asked larger rather than refused');

  const told = openai({ size: [32, 16] });
  await runGenerateImage({ prompt: 'x', model: 'flare', input_images: ['frame.png'], size: '32x16', cwd }, { fetch: told.send, key, box: nobody });
  assert.deepEqual(told.asked[0].fields.size, ['32x16'], 'a size asked for is sent as asked');
});

test('a computer without the key sends the first input\'s size to the authority too', async t => {
  const pc = await authority(t);
  const cwd = await folder(t);
  await writeFile(join(cwd, 'f.png'), noisePNG(1024, 768));
  await runGenerateImage({ prompt: 'x', model: 'sunburst', input_images: ['f.png'], cwd }, { key: join(cwd, 'no-key'), box: pc.where });
  assert.deepEqual(pc.api.asked[0].fields.size, ['1024x768']);
});

test('a paid picture waits for the person, once a conversation, and with no window or a no nothing is made', async t => {
  const cwd = await folder(t);
  const key = await withKey(cwd);
  const asked = [];
  const ui = answer => ({ confirm: async title => { asked.push(title); return answer; } });
  const api = openai();
  await assert.rejects(generate({ prompt: 'x', model: 'sunburst', cwd, session: 'declined', ui: ui(false) }, { fetch: api.send, key, box: nobody }), /said no to paid pictures/);
  await assert.rejects(generate({ prompt: 'x', model: 'flare', cwd, session: 'no-window' }, { fetch: api.send, key, box: nobody }), /no window here to ask/);
  assert.equal(api.asked.length, 0);
  await generate({ prompt: 'frame one', model: 'flare', cwd, session: 'animating', ui: ui(true) }, { fetch: api.send, key, box: nobody });
  await generate({ prompt: 'frame two', model: 'sunburst', cwd, session: 'animating', ui: ui(true) }, { fetch: api.send, key, box: nobody });
  assert.deepEqual(asked, ['Make pictures with gpt-image-2.5-sunburst?', 'Make pictures with gpt-image-2.5-flare?']);
  assert.equal(api.asked.length, 2);
});

test('unnamed callers do not share paid approval, and an aborted approval makes no request', async t => {
  const cwd = await folder(t), key = await withKey(cwd), api = openai();
  let confirmations = 0;
  const ui = { confirm: async () => { confirmations++; return true; } };
  for (let i = 0; i < 2; i++) await generate({ prompt: 'x', model: 'flare', cwd, ui }, { fetch: api.send, key, box: nobody });
  assert.equal(confirmations, 2);
  const stop = new AbortController();
  await assert.rejects(generate({ prompt: 'x', model: 'flare', cwd, signal: stop.signal, ui: { confirm: async () => { stop.abort(); return true; } } }, { fetch: api.send, key, box: nobody }), /abort/i);
  assert.equal(api.asked.length, 2);
});
