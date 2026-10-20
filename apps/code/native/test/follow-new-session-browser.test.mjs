import test from "node:test";
import assert from "node:assert/strict";
import { launchChromium } from '../../../../tools/test-browser.mjs';
import { fixture, serve } from "../../tools/gui-preview.mjs";

// A session started on one screen is where every screen goes, whether it was
// showing a session or asking which device to start one on.
for (const choosingFirst of [true, false]) test(`a screen ${choosingFirst ? "picking a device" : "showing a session"} follows a session started on another screen`, async () => {
  const { server, sockets, port } = await serve(":root { --pi-accent: #4f8cff; }");
  const calls = [];
  sockets.on("connection", socket => socket.on("message", raw => calls.push(JSON.parse(raw))));
  const browser = await launchChromium({ headless: true, args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    await page.goto(`http://127.0.0.1:${port}/?face=code`);
    await page.locator("#entry-output.gui-transcript").waitFor();
    if (choosingFirst) {
      await page.locator("#session-rail .session-rail-new .session-rail-open").click();
      await page.locator("#entry-terminal.choosing").waitFor();
    }
    await page.waitForTimeout(200);
    assert.equal(calls.some(c => c.type === "tab-focus"), false, "sessions that were already there are not followed");

    const started = fixture();
    // Selection is per connection, so on this screen the new session arrives
    // unfocused; the screen that made it is the one that has it selected.
    started.tabs = [...started.tabs,
      { id: "fresh", sessionId: "fresh", focused: false, status: "idle", agent: "claude", model: "opus", name: "", prompt: "" }];
    for (const socket of sockets.clients) socket.send(JSON.stringify({ type: "snapshot", data: started }));

    await page.locator("#entry-terminal:not(.choosing)").waitFor();
    await page.waitForTimeout(200);
    assert.ok(calls.some(c => c.type === "tab-focus" && c.tabId === "fresh"), JSON.stringify(calls.map(c => c.type)));
  } finally {
    await browser.close(); for (const socket of sockets.clients) socket.terminate();
    await new Promise(resolve => sockets.close(resolve));
    await new Promise(resolve => server.close(resolve));
  }
});
