// Pictures made with the person's ChatGPT subscription, the way the Codex CLI
// makes them (codex-rs ext/image-generation): a plain request to the Images
// API behind ChatGPT's Codex backend, gpt-image-2, generations or edits,
// answered with the picture as base64. No model turn wraps it, so every
// harness -- Pi and Claude alike -- gets the same tool from tools.mjs.
//
// The sign-in is Pi's: the `openai-codex` credential in a Pi auth.json, which
// "sign in for more models" in the model picker writes. Pi's own ModelRuntime
// reads it and refreshes it under Pi's file lock, so nothing here knows OAuth.
//
// That backend picks its own model whatever it is asked (Flare), and has been
// seen ignoring size and quality too. So the model may instead ask for
// sunburst or flare: GPT Image 2.5 through OpenAI's own Images API, paid per
// picture with the person's API key, for precise edits with a mask and exact
// sizes. The key is ~/.imperfect/credentials/openai-api-key on the computer
// the others follow (the authority, Locus's PC), and never leaves it: a
// computer without it sends the request there and gets the picture back
// (createImageBox, below).
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { ModelRuntime, getAgentDir, readStoredCredential, resizeImage } from '@earendil-works/pi-coding-agent';
import { PREVIEW_BYTES } from './request-images.mjs';

const PROVIDER = 'openai-codex';
const IMAGES = 'https://chatgpt.com/backend-api/codex/images';
const MODEL = 'gpt-image-2';
const MOST_INPUTS = 5;
const INPUTS = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
const QUALITIES = ['low', 'medium', 'high', 'auto'];
const BACKGROUNDS = ['transparent', 'opaque', 'auto'];
// OpenAI's Images API (openai-node's ImageEditParams): up to 16 png, jpg or
// webp inputs, a PNG mask under 4 MB the size of the first, quality up to max.
const API = 'https://api.openai.com/v1/images';
const SUBSCRIPTION = 'subscription';
export const API_MODELS = { sunburst: 'gpt-image-2.5-sunburst', flare: 'gpt-image-2.5-flare' };
const API_MOST_INPUTS = 16;
const API_INPUTS = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' };
const API_QUALITIES = ['low', 'medium', 'high', 'xhigh', 'max', 'auto'];
const MASK_BYTES = 4 * 1024 * 1024;
const API_WAIT = 10 * 60_000;
// What the model is shown stays in the conversation and is sent again with
// every later turn, so it sees a JPEG preview (request-images.mjs); the file
// keeps every pixel.

export const NO_SIGN_IN = 'This computer has no ChatGPT sign-in, so it cannot make pictures yet. Ask the person to sign in with ChatGPT once: in imperfect\'s model picker, "sign in for more models", then ChatGPT.';

export const keyFile = (env = process.env) => join(env.IMPERFECT_PREFIX || join(homedir(), '.imperfect'), 'credentials', 'openai-api-key');

export const NO_KEY = file => `This computer has no OpenAI API key, so it cannot make pictures with sunburst or flare. Leave model on subscription, or ask the person to save their key from platform.openai.com, on its own line, in ${file} (mode 600) on the computer the others follow (the authority in machine.json); the others make these pictures through it.`;

export const IMAGE_TOOL = {
  name: 'generate_image',
  description: "Make a picture from a description, or change existing pictures given as input_images (add or remove things, restyle, combine, cut out the background). It takes up to a minute or two. model subscription, the default, uses the person's ChatGPT subscription at no extra cost; its backend picks its own model and may not keep to the size or quality asked. sunburst (the most precise) and flare (quicker) are GPT Image 2.5 through OpenAI's API, paid per picture from the person's key, and the person is asked once per conversation before the first: use them for precise edits with a mask, an exact size, animating frame by frame (the last frame as input_images, ideally with a mask), or when the subscription's picture came back wrong. The PNG is saved (by default in images/ in the session's folder) and both you and the person see it, so it needs no show. Write the prompt as a full description: subject, style, composition, colours, any text it must contain.",
  parameters: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'what to make, or for input_images what to change' },
      model: { type: 'string', enum: [SUBSCRIPTION, ...Object.keys(API_MODELS)], description: 'subscription (default): nothing extra to pay; sunburst or flare: paid per picture' },
      input_images: { type: 'array', items: { type: 'string' }, description: `pictures to edit or work from (png, jpg, webp), absolute or relative to the session's folder; at most ${MOST_INPUTS} (${API_MOST_INPUTS} with sunburst or flare)` },
      mask: { type: 'string', description: 'sunburst or flare only, with input_images: a PNG the size of the first input image whose fully transparent area is what may change; everything opaque stays as it is. Under 4 MB' },
      size: { type: 'string', description: 'auto (default), or WIDTHxHEIGHT: 1024x1024, 1536x1024 or 1024x1536; sunburst and flare take sides that divide by 16, 1:3 to 3:1, up to 3840x2160, and keep an edit at its first input picture\'s size' },
      quality: { type: 'string', enum: API_QUALITIES, description: 'default auto; low is quickest; xhigh and max (sunburst or flare only) take longer and cost more' },
      background: { type: 'string', enum: BACKGROUNDS, description: 'transparent for a cut-out (icons, stickers, sprites); default auto' },
      out: { type: 'string', description: "where to save the PNG, absolute or relative to the session's folder (default images/<prompt>-<time>.png)" },
    },
    required: ['prompt'],
  },
};

// Where this computer keeps Pi's sign-ins: imperfect's own Pi folder, then Pi's default.
export function authFiles(env = process.env) {
  const prefix = env.IMPERFECT_PREFIX || join(homedir(), '.imperfect');
  return [...new Set([join(prefix, 'data', 'agent', 'auth.json'), join(getAgentDir(), 'auth.json')])];
}

const runtimes = new Map();
// A fresh ChatGPT access token and its account, or null when nobody signed in.
export async function chatgptSignIn(files = authFiles()) {
  const file = files.find(f => readStoredCredential(PROVIDER, f));
  if (!file) return null;
  if (!runtimes.has(file)) {
    const made = ModelRuntime.create({ authPath: file, modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
    made.catch(() => runtimes.delete(file));
    runtimes.set(file, made);
  }
  const token = (await (await runtimes.get(file)).getAuth(PROVIDER))?.auth?.apiKey;
  return token ? { token, accountId: accountOf(token) } : null;
}

function accountOf(token) {
  try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())['https://api.openai.com/auth']?.chatgpt_account_id ?? ''; }
  catch { return ''; }
}

// The model may hand a list as a list, as JSON, or as one path.
function paths(value) {
  if (value == null || value === '') return [];
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  const text = String(value).trim();
  if (text.startsWith('[')) { try { return JSON.parse(text).map(String).filter(Boolean); } catch {} }
  return [text];
}

function slug(prompt) {
  return prompt.toLowerCase().match(/[a-z0-9]+/g)?.slice(0, 6).join('-').slice(0, 48).replace(/-+$/, '') || 'image';
}

function failure(status, text) {
  let said = text;
  try { const body = JSON.parse(text); said = body.error?.message || body.detail?.message || body.detail || body.message || text; } catch {}
  said = String(typeof said === 'string' ? said : JSON.stringify(said)).slice(0, 400);
  if (status === 401 || status === 403) return `ChatGPT refused the sign-in (${status}): ${said}. The person may need to sign in with ChatGPT again ("sign in for more models" in the model picker).`;
  if (status === 429) return `ChatGPT's limit for pictures is reached for now (429): ${said}`;
  return `Making the picture failed (${status}): ${said}`;
}

// OpenAI's words, without anything shaped like a key.
function apiFailure(status, text, file) {
  let said = text;
  try { said = JSON.parse(text).error?.message || text; } catch {}
  said = String(said).replace(/\bsk-[\w*-]+/g, '[key]').slice(0, 400);
  if (status === 401) return `OpenAI did not accept the API key in ${file} (401): ${said}`;
  if (status === 429) return `OpenAI's limit for the API key is reached, or it has no credit left (429): ${said}`;
  return `OpenAI's Images API refused the picture (${status}): ${said}`;
}

// A picture's own width and height (PNG, JPEG or WebP), whatever it was
// said to be: [width, height], or null for anything else.
export function pictureSize(bytes) {
  if (!bytes || bytes.length < 30) return null;
  if (bytes.readUInt32BE(0) === 0x89504e47 && bytes.toString('latin1', 12, 16) === 'IHDR') return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
  if (bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') {
    const chunk = bytes.toString('latin1', 12, 16);
    if (chunk === 'VP8 ') return [bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff];
    if (chunk === 'VP8L') {
      const [a, b, c, d] = bytes.subarray(21, 25);
      return [1 + (((b & 0x3f) << 8) | a), 1 + (((d & 0xf) << 10) | (c << 2) | ((b & 0xc0) >> 6))];
    }
    if (chunk === 'VP8X') return [1 + bytes.readUIntLE(24, 3), 1 + bytes.readUIntLE(27, 3)];
    return null;
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    // Segment by segment to the frame header (SOF0-15, but not DHT, JPG or DAC).
    for (let at = 2; at + 9 <= bytes.length;) {
      if (bytes[at] !== 0xff) return null;
      const marker = bytes[at + 1];
      if (marker === 0xff) { at++; continue; }
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return [bytes.readUInt16BE(at + 7), bytes.readUInt16BE(at + 5)];
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { at += 2; continue; }
      at += 2 + bytes.readUInt16BE(at + 2);
    }
  }
  return null;
}
const sizeOf = bytes => pictureSize(bytes)?.join('x') ?? null;

// The size the API takes nearest to width x height, keeping its shape as
// far as it can: sides that divide by 16, from 1:3 to 3:1, at most
// 3840x2160 either way round, and at least 655,360 pixels (1024x640), so a
// small picture is asked for larger rather than refused.
const LEAST_PIXELS = 655360;
export function apiSize(width, height) {
  let w = width, h = height;
  if (w > 3 * h) h = w / 3;
  if (h > 3 * w) w = h / 3;
  let scale = Math.min(1, 3840 / Math.max(w, h), 2160 / Math.min(w, h));
  if (w * h * scale * scale < LEAST_PIXELS) scale = Math.sqrt(LEAST_PIXELS / (w * h));
  const round = scale > 1 ? Math.ceil : Math.round;
  const side = (n, most) => Math.min(Math.max(16, round(n * scale / 16) * 16), most);
  const long = w >= h;
  w = side(w, long ? 3840 : 2160);
  h = side(h, long ? 2160 : 3840);
  while (w > 3 * h) h += 16;
  while (h > 3 * w) w += 16;
  return `${w}x${h}`;
}

// One request to OpenAI's Images API with the key: generations as JSON,
// edits as a form with each picture as image[] and the mask beside them.
// inputs: [{ type, bytes }]; mask: PNG bytes or null.
export async function apiImage({ key, file, model, prompt, inputs = [], mask = null, size, quality, background }, { send = fetch, signal } = {}) {
  const fields = {
    model: API_MODELS[model], prompt,
    ...(size ? { size } : {}),
    ...(quality ? { quality } : {}),
    ...(background ? { background } : {}),
  };
  let body = JSON.stringify(fields);
  if (inputs.length) {
    body = new FormData();
    for (const [name, value] of Object.entries(fields)) body.append(name, value);
    inputs.forEach((input, n) => body.append('image[]', new Blob([input.bytes], { type: input.type }), `image-${n + 1}${API_INPUTS[input.type]}`));
    if (mask) body.append('mask', new Blob([mask], { type: 'image/png' }), 'mask.png');
  }
  const response = await send(`${API}/${inputs.length ? 'edits' : 'generations'}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, ...(inputs.length ? {} : { 'content-type': 'application/json' }) },
    body,
    signal: AbortSignal.any([AbortSignal.timeout(API_WAIT), ...(signal ? [signal] : [])]),
  });
  const text = await response.text();
  signal?.throwIfAborted();
  if (!response.ok) throw Object.assign(new Error(apiFailure(response.status, text, file)), { status: 502 });
  let made;
  try { made = JSON.parse(text); } catch { throw Object.assign(new Error('OpenAI answered with something that is not a picture'), { status: 502 }); }
  const data = made.data?.[0]?.b64_json;
  if (!data) throw Object.assign(new Error('OpenAI answered without a picture'), { status: 502 });
  return { b64_json: data, size: made.size, quality: made.quality, background: made.background, output_format: made.output_format };
}

async function readKey(file) {
  try { return (await readFile(file, 'utf8')).trim() || null; }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// Where the key box is, as the server finds it (provideKeyBox).
// null on the authority itself and on a computer of its own, else
// { url, name }, the url '' while it cannot be reached.
const BOX = Symbol.for('imperfect.key.box');
export function provideKeyBox(find) { globalThis[BOX] = find; }
const keyBox = async () => (await globalThis[BOX]?.()) ?? null;

// The picture from the API: with the key here, or made by the computer that
// keeps it. `by` says where, for the answer.
async function fromApi(request, { send, signal, key: file, box }) {
  const key = await readKey(file);
  if (key) return { ...await apiImage({ ...request, key, file }, { send, signal }), by: 'this computer' };
  const there = await box();
  if (!there) throw new Error(NO_KEY(file));
  if (!there.url) throw new Error(`The OpenAI API key is kept on ${there.name}, and this computer cannot reach it right now, so no picture was made. Try again once ${there.name} is on, or leave model on subscription.`);
  const wire = {
    ...request,
    inputs: request.inputs.map(input => ({ type: input.type, data: input.bytes.toString('base64') })),
    mask: request.mask ? request.mask.toString('base64') : null,
  };
  let response;
  try {
    response = await send(`${there.url}/images/make`, {
      method: 'POST', headers: { origin: there.url, 'content-type': 'application/json' }, body: JSON.stringify(wire), redirect: 'error',
      signal: AbortSignal.any([AbortSignal.timeout(API_WAIT + 60_000), ...(signal ? [signal] : [])]),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(`${there.name}, which keeps the OpenAI API key, could not be reached (${error.message})`);
  }
  const answer = await response.json().catch(() => ({}));
  signal?.throwIfAborted();
  if (!response.ok) throw new Error(`${there.name}, which keeps the OpenAI API key, answered: ${answer.error || response.status}`);
  if (!answer.b64_json) throw new Error(`${there.name}, which keeps the OpenAI API key, answered without a picture`);
  return { ...answer, by: there.name };
}

async function picture(file, kinds, what) {
  const type = kinds[extname(file).toLowerCase()];
  if (!type) throw new Error(`${file} is not a ${what} picture`);
  return { file, type, bytes: await readFile(file) };
}

// sunburst and flare are paid from the person's own API key: the first in a
// conversation waits for them to say yes, and a conversation they said yes to
// is not asked again (frames of an animation are many pictures). With no
// window to ask in, nothing paid is made.
const paying = new Set();
async function mayPay({ model, session, ui, signal }) {
  const who = session;
  if (!ui?.confirm) throw new Error(`There is no window here to ask the person before a paid picture, so nothing was made. Use model subscription.`);
  if (who && paying.has(who)) return;
  const yes = await ui.confirm(`Make pictures with ${API_MODELS[model]}?`, "It goes through OpenAI's Images API and is paid per picture from your API key. Saying yes allows sunburst and flare for the rest of this conversation.", { signal });
  if (!yes) throw new Error('The person said no to paid pictures, so nothing was made. Use model subscription, or ask them.');
  signal?.throwIfAborted();
  if (who) paying.add(who);
}

// cwd: the calling session's folder, filled in by the harness.
export async function runGenerateImage({ prompt, model, input_images, mask, size, quality, background, out, cwd, session, ui, signal } = {}, { fetch: post = fetch, signIn = chatgptSignIn, now = new Date(), key = keyFile(), box = keyBox } = {}) {
  signal?.throwIfAborted();
  const asked = String(prompt ?? '').trim();
  if (!asked) throw new Error('generate_image needs a prompt');
  const via = String(model ?? '').trim().toLowerCase() || SUBSCRIPTION;
  if (via !== SUBSCRIPTION && !API_MODELS[via]) throw new Error(`generate_image's model is subscription, sunburst or flare, not ${model}`);
  const api = via !== SUBSCRIPTION;
  const here = resolve(String(cwd || process.cwd()));
  const inputs = paths(input_images);
  const most = api ? API_MOST_INPUTS : MOST_INPUTS;
  if (inputs.length > most) throw new Error(`generate_image takes at most ${most} input_images${api ? '' : ` (${API_MOST_INPUTS} with sunburst or flare)`}`);
  const wanted = String(quality ?? '').trim();
  const masked = String(mask ?? '').trim();
  if (!api && masked) throw new Error('A mask needs model sunburst or flare (OpenAI\'s API): the subscription takes none. Nothing was made.');
  if (!api && ['xhigh', 'max'].includes(wanted)) throw new Error(`Quality ${wanted} needs model sunburst or flare (OpenAI's API); the subscription goes up to high. Nothing was made.`);
  if (masked && !inputs.length) throw new Error('A mask goes with input_images: it marks what may change in the first of them');
  const read = await Promise.all(inputs.map(path => picture(resolve(here, path), api ? Object.fromEntries(Object.entries(INPUTS).filter(([, type]) => API_INPUTS[type])) : INPUTS, api ? 'png, jpg or webp' : 'png, jpg, webp or gif')));
  const cover = masked ? await picture(resolve(here, masked), { '.png': 'image/png' }, 'PNG (the mask must be a PNG with transparency)') : null;
  if (cover) {
    if (cover.bytes.length >= MASK_BYTES) throw new Error(`${cover.file} is ${(cover.bytes.length / 1024 / 1024).toFixed(1)} MB; a mask must be under 4 MB`);
    const first = sizeOf(read[0].bytes), its = sizeOf(cover.bytes);
    if (first && its && first !== its) throw new Error(`The mask is ${its} but ${read[0].file} is ${first}: they must be the same size`);
  }
  // An edit on the API with no size asked comes back the size of the first
  // picture (as near as the API allows), not one of its own choosing: frames
  // of an animation must all be the same size.
  const askedSize = String(size || '').trim();
  const first = api && read.length && (!askedSize || askedSize === 'auto') ? sizeOf(read[0].bytes) : null;
  const fit = first ? { first, send: apiSize(...pictureSize(read[0].bytes)) } : null;
  signal?.throwIfAborted();

  let made, said;
  if (api) {
    await mayPay({ model: via, session, ui, signal });
    made = await fromApi({
      model: via, prompt: asked, inputs: read, mask: cover?.bytes ?? null,
      size: fit?.send || askedSize || undefined,
      quality: API_QUALITIES.includes(wanted) ? wanted : undefined,
      background: BACKGROUNDS.includes(background) ? background : undefined,
    }, { send: post, signal, key, box });
  } else {
    const login = await signIn();
    signal?.throwIfAborted();
    if (!login) throw new Error(NO_SIGN_IN);
    const body = {
      prompt: asked, model: MODEL,
      ...(read.length ? { images: read.map(input => ({ image_url: `data:${input.type};base64,${input.bytes.toString('base64')}` })) } : {}),
      ...(BACKGROUNDS.includes(background) ? { background } : {}),
      quality: QUALITIES.includes(wanted) ? wanted : 'auto',
      size: String(size || '').trim() || 'auto',
    };
    const response = await post(`${IMAGES}/${read.length ? 'edits' : 'generations'}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${login.token}`, 'chatgpt-account-id': login.accountId, originator: 'pi', 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.any([AbortSignal.timeout(5 * 60_000), ...(signal ? [signal] : [])]),
    });
    const text = await response.text();
    signal?.throwIfAborted();
    if (!response.ok) throw new Error(failure(response.status, text));
    try { made = JSON.parse(text); } catch { throw new Error('ChatGPT answered with something that is not a picture'); }
    made = { ...made, b64_json: made.data?.[0]?.b64_json };
    if (!made.b64_json) throw new Error('ChatGPT answered without a picture');
  }
  const two = n => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
  let file = out ? resolve(here, String(out)) : join(here, 'images', `${slug(asked)}-${stamp}.png`);
  if (!extname(file)) file += '.png';
  const bytes = Buffer.from(made.b64_json, 'base64');
  await mkdir(dirname(file), { recursive: true });
  signal?.throwIfAborted();
  await writeFile(file, bytes, { signal });

  // Which path and model made it, and what it came out as, so a picture
  // that is not what was asked for shows as such.
  const pixels = sizeOf(bytes) || made.size;
  let off = askedSize && askedSize !== 'auto' && pixels && pixels !== askedSize ? ` (asked ${askedSize})` : '';
  if (fit) off = pixels === fit.first ? '' : ` (not the size of the first input picture, ${fit.first}; ${fit.send === fit.first ? 'that size was asked' : `asked ${fit.send}, the nearest size the API takes to it`})`;
  if (api) {
    const got = made.quality || 'not said';
    const offQuality = wanted && wanted !== 'auto' && made.quality && made.quality !== wanted ? ` (asked ${wanted})` : '';
    said = `${read.length ? 'Changed' : 'Made'} the picture with ${API_MODELS[via]} through OpenAI's Images API (the API key on ${made.by})${cover ? ', masked' : ''}: ${pixels || 'size not said'}${off}, quality ${got}${offQuality}, saved as PNG at ${file}.`;
  } else {
    said = `${read.length ? 'Changed' : 'Made'} the picture through the ChatGPT subscription (its backend picks the model itself${made.model ? `; it said ${made.model}` : ''}): ${pixels || 'size not said'}${off}, saved as PNG at ${file}.`;
  }
  const preview = await resizeImage(bytes, 'image/png', { maxBytes: PREVIEW_BYTES }).catch(() => null);
  if (!preview) return `${said}\n(too big for you to see too)`;
  const note = preview.mimeType === 'image/png' ? '' : `\nYou see a ${preview.width}x${preview.height} JPEG preview${background === 'transparent' ? ' without its transparency' : ''}; the PNG file is the full picture.`;
  return [{ type: 'text', text: said + note }, { type: 'image', data: preview.data, mimeType: preview.mimeType }];
}

// The authority's side: a computer of the person's without the key sends
// what generate_image asked for here, POST /images/make { model, prompt,
// inputs: [{ type, data }], mask, size, quality, background } with the
// pictures as base64, and gets { b64_json, size, quality, ... } back. Guarded
// like /browser: the machine server answers only its own tailnet name or loopback,
// and the exact origin is required.
export function createImageBox({ key = keyFile(), fetch: send = fetch } = {}) {
  return async function handle(req, res, path) {
    if (path !== '/images/make' || req.method !== 'POST') return false;
    const json = (status, value) => {
      if (res.headersSent) return;
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...(req.complete ? {} : { connection: 'close' }) });
      res.end(JSON.stringify(value));
    };
    if (!req.headers.origin) { json(403, { error: 'exact origin required' }); return true; }
    // The asking computer's turn stopped: stop asking OpenAI too.
    const stop = new AbortController();
    res.once('close', () => { if (!res.writableFinished) stop.abort(); });
    const bad = message => Object.assign(new Error(message), { status: 400 });
    try {
      const secret = await readKey(key);
      if (!secret) throw Object.assign(new Error(NO_KEY(key)), { status: 404 });
      let asked;
      try { asked = JSON.parse((await received(req, 128 * 1024 * 1024)).toString('utf8')); } catch (error) { throw error.status ? error : bad('not JSON'); }
      if (!API_MODELS[asked?.model]) throw bad('model should be sunburst or flare');
      const prompt = String(asked.prompt ?? '').trim();
      if (!prompt) throw bad('the picture has no prompt');
      const inputs = Array.isArray(asked.inputs) ? asked.inputs : [];
      if (inputs.length > API_MOST_INPUTS || !inputs.every(input => API_INPUTS[input?.type] && typeof input.data === 'string')) throw bad(`inputs should be up to ${API_MOST_INPUTS} png, jpg or webp pictures`);
      const mask = typeof asked.mask === 'string' ? Buffer.from(asked.mask, 'base64') : null;
      if (mask && (!inputs.length || mask.length >= MASK_BYTES)) throw bad('a mask goes with inputs and is under 4 MB');
      const text = value => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
      json(200, await apiImage({
        key: secret, file: key, model: asked.model, prompt,
        inputs: inputs.map(input => ({ type: input.type, bytes: Buffer.from(input.data, 'base64') })), mask,
        size: text(asked.size),
        quality: API_QUALITIES.includes(asked.quality) ? asked.quality : undefined,
        background: BACKGROUNDS.includes(asked.background) ? asked.background : undefined,
      }, { send, signal: stop.signal }));
    } catch (error) {
      json(error.status || 502, { error: error.message });
    }
    return true;
  };
}

async function received(req, most) {
  const parts = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > most) throw Object.assign(new Error('too big'), { status: 413 });
    parts.push(chunk);
  }
  return Buffer.concat(parts);
}
