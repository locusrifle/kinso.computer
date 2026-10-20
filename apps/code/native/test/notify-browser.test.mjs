import test from "node:test";
import assert from "node:assert/strict";
import { launchChromium } from '../../../../tools/test-browser.mjs';
import { serve } from "../../tools/gui-preview.mjs";

// Nothing is ever drawn above the input bar for notifications (Noah, 15 Oct):
// the browser's own question comes once, when the person first sends a prompt;
// what arrives while they are off shows no line of ours; a tapped
// notification's address opens its session.
test("notifications never draw above the input; the browser asks once, on the first prompt sent; ?session= opens that session", async () => {
  const { server, sockets, port } = await serve(":root { --pi-accent: #4f8cff; }");
  const calls = [];
  sockets.on("connection", socket => socket.on("message", raw => calls.push(JSON.parse(raw))));
  const browser = await launchChromium({ headless: true, args: ["--no-sandbox"] });
  try {
    const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
    await context.addInitScript(() => {
      window.__asked = 0;
      Notification.requestPermission = async () => { window.__asked++; return "denied"; };
    });
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${port}/?face=code`);
    await page.locator("#entry-output.gui-transcript").waitFor();
    await page.waitForTimeout(800);
    assert.equal(await page.locator("#entry-notify").count(), 0, "no notification offer element");
    assert.equal(await page.evaluate(() => window.__asked), 0, "nothing asked on load");
    await page.mouse.click(600, 300);
    assert.equal(await page.evaluate(() => window.__asked), 0, "nor on a tap that sends nothing");

    const input = page.locator("#entry-input");
    await input.fill("hello");
    await input.press("Enter");
    await page.waitForFunction(() => window.__asked === 1);
    await input.fill("again");
    await input.press("Enter");
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => window.__asked), 1, "asked once only");
    await page.reload();
    await page.locator("#entry-output.gui-transcript").waitFor();
    await input.fill("after reload");
    await input.press("Enter");
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => window.__asked), 0, "remembered across visits");

    for (const socket of sockets.clients) socket.send(JSON.stringify({ type: "notify", title: "New website enquiry", body: "Ada asked for a quote.", tag: "e1", session: "other", url: "/?session=other" }));
    await page.waitForTimeout(500);
    const above = await page.evaluate(() => [...document.querySelectorAll("#entry-terminal .entry-screen > :not(#entry-output)")].filter(node => !node.hidden).map(node => node.innerText).join(" "));
    assert.doesNotMatch(above, /enquiry|Notifications/, `nothing drawn above the input: ${above}`);

    calls.length = 0;
    await page.goto(`http://127.0.0.1:${port}/?session=other`);
    await page.waitForFunction(() => !location.search.includes("session="));
    await page.waitForTimeout(500);
    assert.ok(calls.some(c => c.type === "tab-focus" && c.tabId === "other"), JSON.stringify(calls.map(c => c.type)));
    await context.close();
  } finally {
    await browser.close(); for (const socket of sockets.clients) socket.terminate();
    await new Promise(resolve => sockets.close(resolve));
    await new Promise(resolve => server.close(resolve));
  }
});
