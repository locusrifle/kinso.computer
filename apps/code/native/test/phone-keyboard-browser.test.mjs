import test from "node:test";
import assert from "node:assert/strict";
import { launchChromium } from '../../../../tools/test-browser.mjs';
import { serve } from "../../tools/gui-preview.mjs";

// On a phone the keyboard rises for a finger on the input bar and nothing else.
test("phone: only a touch on the input bar focuses a text field", async () => {
  const { server, sockets, port } = await serve(":root { --pi-accent: #4f8cff; }");
  const browser = await launchChromium({ headless: true, args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${port}/?face=code`);
    await page.locator("#entry-output.gui-transcript").waitFor();
    const typing = () => page.evaluate(() => document.activeElement?.matches("textarea, input, [contenteditable=true]") ?? false);

    await page.locator("#entry-output").tap();
    await page.waitForTimeout(100);
    assert.equal(await typing(), false, "a tap on the transcript does not raise the keyboard");

    await page.locator("#session-rail .session-rail-item[data-tab-id=\"other\"] .session-rail-open").tap();
    await page.waitForTimeout(100);
    assert.equal(await typing(), false, "opening a session does not raise the keyboard");

    await page.evaluate(() => document.getElementById("entry-input").focus());
    assert.equal(await typing(), false, "code cannot focus the input bar for you");

    await page.locator("#entry-input").tap();
    assert.equal(await page.evaluate(() => document.activeElement?.id), "entry-input", "a finger on the input bar does");
    assert.deepEqual(errors, []);
  } finally {
    await browser.close(); for (const socket of sockets.clients) socket.terminate();
    await new Promise(resolve => sockets.close(resolve));
    await new Promise(resolve => server.close(resolve));
  }
});
