// `code_session` opens separate interactive work only when the person asks for it.
// Every imperfect window follows a newly started session (public/js/harness.js).
// Delegation belongs to noninteractive subagent processes, not sessions or tabs.
// system/server.mjs provides the opener shared by the harnesses.
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { SOURCES } from './canonical.mjs';
import { OPENED, inBrowser } from './public/js/pages.js';
import { pictureForModel } from './request-images.mjs';

let opener = null;

// What each harness is called when a person is told which one opened.
const HARNESS_NAMES = { pi: 'Pi', claude: 'Claude Code', codex: 'Codex' };

// open({ cwd, agent, name, prompt }) -> { id }
export function provideSessions(open) { opener = open; }
function requireInteractive(args) {
  if (args?.headless === true || args?.headless === 'true') {
    throw new Error('code_session opens interactive sessions only. Use your own subagents to delegate; do not create a session or sidebar tab.');
  }
}
export function openSession(args) {
  requireInteractive(args);
  if (!opener) throw new Error('imperfect is not serving sessions yet');
  return opener(args);
}

export const SESSION_TOOL = {
  name: 'code_session',
  description: "Open a separate interactive session in imperfect, only when the person explicitly requests separate work in its own session. Their imperfect windows move to it straight away. Not for delegation: use your own subagents instead.",
  parameters: {
    type: 'object',
    properties: {
      computer: { type: 'string', description: 'machine name or id from the machine list (default: the serving computer); unknown or offline computers are refused' },
      cwd: { type: 'string', description: "the folder on the chosen computer the session works in (default: this session's)" },
      agent: { type: 'string', enum: [...SOURCES], description: 'which harness (default: your own)' },
      name: { type: 'string', description: 'what the session is called in the sidebar' },
      prompt: { type: 'string', description: 'a first message to send it' },
    },
  },
};

// `agent` is the harness to open; the one calling arrives as `harness` (every
// harness's bridge names itself there), so the two never overwrite each other.
export async function runSessionTool(args = {}) {
  requireInteractive(args);
  const { cwd, agent = args.harness, name, prompt, computer } = args;
  if (!opener) throw new Error('This agent is not running inside imperfect, so it cannot open sessions there');
  const harness = SOURCES.includes(agent) ? agent : 'pi';
  const { id } = await opener({ cwd, agent: harness, name, prompt, ...(computer !== undefined ? { computer } : {}) });
  return [
    `Opened a ${HARNESS_NAMES[harness]} session${name ? ` named "${name}"` : ''}${computer ? ` on ${computer}` : ''}${cwd ? ` in ${cwd}` : ''} (${id}).`,
    prompt ? 'Its first message has been sent; it is working on it.' : '',
    "The person's imperfect windows have moved to it.",
  ].filter(Boolean).join(' ');
}

// `show` opens something for the person. A page (a game, a toy, an app), a
// folder with one in it, a PDF or a local address opens as a tab in the
// browser beside the conversation (public/js/pages.js), theirs to use for as
// long as they like; a picture, a video or a sound plays in the conversation,
// in a window they can take full screen. It answers in a line the
// conversation reads (windowOf, pages.js), holding the one address this
// computer serves the thing at (system/shown.mjs), so the tab or window is
// part of the transcript from Pi or Claude, and plays on any of the
// person's screens, wherever it runs. What opens as a tab is told to every
// window as it is shown (provideShownTabs: system/server.mjs), with the
// session that showed it, and opens on that session's canvas, in view or
// not. A picture is handed to the model too, so it sees what it showed.
const PICTURES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
// The model is handed the picture too, and takes at most 5 MB once base64.
export const PICTURE_BYTES = 3_500_000;
const SHOWN = Symbol.for('imperfect.shown');
const SHAPES = ['landscape', 'portrait', 'square'];
const shapeOf = shape => (SHAPES.includes(shape) ? shape : 'landscape');
const SHAPE = { type: 'string', enum: SHAPES, description: "a picture's or video's shape in the conversation (default landscape)" };
let tellWindows = () => {};
export function provideShownTabs(tell) { tellWindows = tell; }

export const SHOW_TOOL = {
  name: 'show',
  description: "Open a local file, folder or address for the person. An HTML page or app, or a folder, opens in Workbench; a PDF or a local address (one from dev_server) opens in the browser beside the conversation, where browser tabs lists it if you need to use it; a picture, short video or sound plays in the conversation (never build a page or contact sheet to show pictures). When they ask you to open a file, show it: reading it only shows it to you. When a turn makes something they can see, play or hear, end it by showing it, and show it again after each change (its tab reloads); a turn that only talks or changes code nobody will look at shows nothing. Websites go to browser open; never xdg-open or another browser.",
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: "the file, folder or local address, absolute or relative to the session's folder" },
      shape: SHAPE,
    },
    required: ['path'],
  },
};

const LOCAL_ADDRESS = /^https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::\d{2,5})?(?:\/\S*)?$/;

// cwd and session: the calling session's folder and id, filled in by the harness.
export async function runShow({ path, shape, cwd, session } = {}) {
  if (!path) throw new Error('show needs a path');
  const said = target => {
    if (!inBrowser(target)) return `Shown in the conversation, in a ${shapeOf(shape)} window: ${target}`;
    tellWindows({ session, target });
    return `${OPENED}${target}`;
  };
  const add = globalThis[SHOWN];
  if (LOCAL_ADDRESS.test(String(path).trim())) {
    const url = new URL(String(path).trim()); url.hostname = 'localhost';
    return said((await add?.(url.href))?.url ?? url.href);
  }
  let file = resolve(String(cwd || process.cwd()), String(path)), at = file;
  if (add) {
    const shown = await add(file);
    if (shown.kind === 'folder' || (shown.kind === 'page' && !/^https?:/i.test(shown.path))) {
      tellWindows({ session, target: shown.path, kind: shown.kind });
      return `Opened in Workbench: ${shown.path}`;
    }
    ({ path: file, url: at } = shown);
  }
  else if (!PICTURES[extname(file).toLowerCase()]) throw new Error('imperfect is not serving here, so only pictures (.png, .jpg, .gif, .webp) can be shown');
  const mimeType = PICTURES[extname(file).toLowerCase()];
  if (!mimeType) return said(at);
  const text = said(at);
  const seen = await pictureForModel(await readFile(file), mimeType);
  if (!seen) return `${text}\n(too big for you to see too)`;
  return [{ type: 'text', text: seen.note ? `${text}\n${seen.note}` : text }, seen.block];
}

// A tool answers in words, or in MCP content blocks when it has a picture;
// this is the one shape every harness is handed.
export const toolContent = answer => typeof answer === 'string' ? [{ type: 'text', text: answer }] : answer;
