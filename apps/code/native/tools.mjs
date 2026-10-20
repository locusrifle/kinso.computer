// imperfect's own tools, the one list every harness is handed through
// imperfect's MCP endpoint (mcp.mjs). A tool is its JSON Schema definition and
// the function that runs it; the function is given the arguments, the folder
// the session works in (cwd), the session calling, which harness it is, the
// window's dialogs for that session (ui: select/confirm) and the call's abort
// signal.
import { DEV_SERVER_TOOL, runDevServer } from './dev-servers.mjs';
import { SESSION_TOOL, SHOW_TOOL, runSessionTool, runShow } from './code-control.mjs';
import { BROWSER_TOOL, runBrowser } from './browser.mjs';
import { DEVICE_HANDS_TOOL, runDeviceHands, hasDeviceHands } from '../../../system/device-hands.mjs';
import { IMAGE_TOOL, runGenerateImage } from './images.mjs';
import { RECALL_TOOL, runRecall } from '../../../system/memory.mjs';
import { NOTIFY_TOOL, runNotify } from '../../../system/notify.mjs';
import { MESSAGES_SEARCH_TOOL, MESSAGES_READ_TOOL, MESSAGES_DRAFT_TOOL, runMessagesSearch, runMessagesRead, runMessagesDraft } from '../../../system/inbox.mjs';

export const TOOLS = [
  [DEV_SERVER_TOOL, runDevServer],
  [SESSION_TOOL, runSessionTool],
  [SHOW_TOOL, runShow],
  [BROWSER_TOOL, runBrowser],
  [IMAGE_TOOL, runGenerateImage],
  [RECALL_TOOL, runRecall],
  [NOTIFY_TOOL, runNotify],
  // Messages: search, read and draft; sending is only ever the person's Send.
  [MESSAGES_SEARCH_TOOL, runMessagesSearch],
  [MESSAGES_READ_TOOL, runMessagesRead],
  [MESSAGES_DRAFT_TOOL, runMessagesDraft],
];
export const DEVICE_HANDS = [DEVICE_HANDS_TOOL, runDeviceHands];
// Evaluated per tools/list for both harnesses; default PCs stay unchanged.
export const availableTools = () => hasDeviceHands() ? [...TOOLS, DEVICE_HANDS] : TOOLS;
