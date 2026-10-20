import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { WebSocketServer } from 'ws';
import { launchChromium } from '../../../../tools/test-browser.mjs';

// Loads the complete production harness and its imports. Only HTTP/WS backend data is fake.
// Ephemeral loopback server; no running service, credentials, runtime or agent is touched.
test('GUI-only harness: windows, drafts, scroll, retry IDs and reload', async () => {
  const root = new URL('../public/', import.meta.url);
  const index = (await readFile(new URL('index.html', root), 'utf8')).replace(/<script[^>]*src="\/js\/site.js"[^>]*><\/script>/, '');
  const calls = [], prompts = [];
  let socket;
  let snap = { agent: 'pi', sessionId: 'thread-a', cwd: '/fixture', messages: Array.from({length:60}, (_, i) => ({role:'user', content:`message ${i}`})),
    model: {provider:'fixture',id:'fixture'}, queue:{items:[{id:'image-q',lane:'steering',text:'image draft',images:[{type:'image',mimeType:'image/png',data:'aW1hZ2U='}]}]},
    stats:{}, ui:{}, tabs:[{id:'tab-a',sessionId:'thread-a',focused:true,agent:'pi',name:'A'}] };
  const send = data => socket.send(JSON.stringify(data));
  const snapshot = () => send({type:'snapshot',data:snap});
  const reply = (c, data, error) => send({type:'response',id:c.id,success:!error,data,error});
  const server = createServer(async (req,res) => {
    try {
      const path = new URL(req.url, 'http://fixture').pathname;
      if (path === '/') { res.setHeader('Content-Type','text/html'); res.end(index + '<style>#entry-terminal{height:650px!important}.entry-screen{height:450px;min-height:0}#entry-output[hidden]{display:none}</style>'); return; }
      if (path.endsWith('.json')) { res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({machines:[]})); return; }
      res.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : 'text/css');
      res.end(await readFile(new URL(path.slice(1), root)));
    } catch { res.statusCode=404; res.end(); }
  });
  const wss = new WebSocketServer({server});
  wss.on('connection', ws => { socket=ws; snapshot(); ws.on('message', raw => {
    const c=JSON.parse(raw); calls.push(c);
    if(c.type==='prompt') prompts.push(c);
    else if(c.type==='queue-take') { reply(c,{item:snap.queue.items[0]}); snap={...snap,queue:{items:[]}}; snapshot(); }
    else if(c.type==='abort') { reply(c,snap.queue); snap={...snap,busy:false,streaming:false,queue:{items:[]}}; snapshot(); }
    else if(c.type==='snapshot') reply(c,snap);
    else reply(c, {});
  }); });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await launchChromium({headless:true,args:['--no-sandbox']});
  try {
    const page=await browser.newPage({viewport:{width:1200,height:900}});
    const errors=[]; page.on('pageerror',e=>errors.push(e.message));
    // This original scroll/queue/Escape regression assumes a collapsed tab
    // rail. Select scrolling explicitly now that browsers default to focus.
    await page.addInitScript(() => localStorage.setItem('imperfect.layout-choice.v2', 'scrolling'));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const mount = async()=>{
      const {mountGueyPi}=await import('/js/harness.js');
      window.harness=mountGueyPi({hooks:{canFocus:()=>true}});
      window.composer=document.getElementById('entry-input');
    };
    await page.evaluate(mount);
    await page.waitForFunction(()=>harness.guiSnapshot().sessionId==='thread-a');
    await page.waitForTimeout(150);
    assert.equal(await page.getByLabel('Rendering mode').count(),0);
    assert.equal(await page.locator('.harness-native-host').count(),0);
    assert.equal(await page.locator('#entry-output.gui-transcript').isVisible(),true);
    await page.locator('#entry-input').fill('original draft');
    await page.locator('[data-queue-id="image-q"]').click();
    const draft=await page.locator('#entry-input').inputValue();
    assert.equal(await page.evaluate(()=>harness.composerStatus().attachments),1);
    assert.equal(await page.evaluate(()=>composer===document.querySelector('#entry-input')),true);
    assert.equal(await page.locator('#entry-input').inputValue(),draft);
    // Ordinary snapshots preserve the reader's position.
    await page.locator('#entry-output').evaluate(n=>{n.dispatchEvent(new WheelEvent('wheel',{deltaY:-100}));n.scrollTop=120;});
    await page.waitForTimeout(50);
    snapshot(); await page.waitForTimeout(250);
    assert.equal(await page.locator('#entry-output').evaluate(n=>n.scrollTop),120);
    {
      await page.evaluate(()=>{window.savedOutput=document.querySelector('#entry-output').firstChild;});
      await page.locator('.workbench').waitFor();
      // Workbench is always a window beside the conversation, which stays in sight and usable.
      assert.equal(await page.locator('#entry-input').evaluate(n=>n.closest('[inert]')!==null),false);
      assert.equal(await page.locator('#entry-output').isVisible(),true);
      assert.equal(await page.locator('.wm-files .workbench').count(),1);
      assert.equal(await page.getByRole('button',{name:'Workbench',exact:true}).count(),0,'no button for it in the dock');
      snapshot(); await page.waitForTimeout(350);
      assert.equal(await page.locator('.workbench [data-close]').count(),0,'no close button: it is never closed');
      await page.locator('#entry-output').hover({position:{x:20,y:20}});
      await page.locator('#entry-input').focus();
      await page.keyboard.press('Alt+w');
      assert.equal(await page.locator('.workbench').isVisible(),true,'over the conversation, with the keys there, Alt+W leaves Workbench be');
      await page.locator('.workbench').hover();
      await page.keyboard.press('Alt+w');
      assert.equal(await page.locator('.workbench').isVisible(),true,'over it, too');
      assert.equal(await page.evaluate(()=>savedOutput===document.querySelector('#entry-output').firstChild),true);
      assert.equal(await page.locator('#entry-input').inputValue(),draft);
      assert.equal(await page.evaluate(()=>harness.composerStatus().attachments),1);
    }
    assert.equal(calls.filter(c=>['tab-new','new','resume','tab-focus','tab-open','prompt','create','runtime','session'].includes(c.type)).length,0);
    await page.evaluate(()=>{window.submission=harness.submit();}); await page.waitForTimeout(100);
    assert.equal(prompts.at(-1).images[0].data,'aW1hZ2U=');
    reply(prompts.at(-1),{accepted:true}); await page.evaluate(()=>submission);
    snap={...snap,sessionId:'thread-b',tabs:[{id:'tab-b',sessionId:'thread-b',focused:true,agent:'pi',name:'B'}]}; snapshot();
    await page.waitForFunction(()=>harness.guiSnapshot().sessionId==='thread-b');
    // Acceptance is not completion. A failed ambiguous send keeps its crypto ID in this page.
    await page.locator('#entry-input').fill('retry same submission');
    await page.evaluate(()=>{window.submission=harness.submit();});
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(()=>harness.surfaceReloadSafe()),false);
    const first=prompts.at(-1); assert.match(first.requestId,/^[0-9a-f-]{36}$/);
    snap={...snap,busy:true}; snapshot();
    reply(first,null,'connection lost after possible acceptance');
    await page.evaluate(()=>submission);
    await page.evaluate(()=>{window.submission=harness.submit();}); await page.waitForTimeout(100);
    assert.equal(prompts.at(-1).requestId,first.requestId);
    assert.equal(prompts.at(-1).behavior,undefined,'submission has no delivery choice');
    reply(prompts.at(-1),{accepted:true,pending:true}); await page.evaluate(()=>submission);
    assert.equal(await page.evaluate(()=>harness.surfaceReloadSafe()),true);
    snap={...snap,busy:false};
    await page.reload(); await page.evaluate(mount);
    await page.waitForFunction(()=>harness.guiSnapshot().sessionId==='thread-b');
    await page.waitForTimeout(150);
    assert.ok(await page.locator('#entry-output').evaluate(n=>n.scrollHeight-n.clientHeight-n.scrollTop<5),'reload latest');
    assert.equal(calls.some(c=>c.type==='tui-render'),false);
    // An update with only the new messages is appended; one that does not fit
    // what the window holds makes it ask for the whole session once.
    const {messages:_all,...rest}=snap;
    send({type:'snapshot',data:{...rest,messagesBase:60,messagesTail:[{role:'user',content:'message 60'}]}});
    await page.waitForFunction(()=>harness.guiSnapshot().messages.length===61);
    assert.equal(await page.locator('.gui-prompt').count(),61);
    const before=calls.filter(c=>c.type==='snapshot').length;
    send({type:'snapshot',data:{...rest,messagesBase:7,messagesTail:[{role:'user','content':'stray'}]}});
    await page.waitForFunction(()=>harness.guiSnapshot().messages.length===60);
    assert.equal(calls.filter(c=>c.type==='snapshot').length,before+1);
    assert.equal(await page.locator('.gui-prompt').count(),60);
    // While the agent works, Enter and Alt+Enter both steer;
    // with nothing running, both just send.
    const sendWith = async (key, text) => {
      const count = prompts.length;
      await page.locator('#entry-input').fill(text);
      await page.locator('#entry-input').focus();
      await page.keyboard.press(key);
      for (let i=0; i<40 && prompts.length===count; i++) await page.waitForTimeout(25);
      const sent = prompts.at(-1);
      reply(sent,{accepted:true}); await page.waitForTimeout(50);
      return sent;
    };
    snap={...snap,busy:true,streaming:true}; snapshot(); await page.waitForTimeout(150);
    assert.equal((await sendWith('Enter','go this way instead')).behavior,undefined);
    assert.equal((await sendWith('Alt+Enter','and then this')).behavior,undefined);
    await page.locator('#entry-input').fill('line one');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('line two');
    assert.equal(await page.locator('#entry-input').inputValue(), 'line one\nline two');
    snap={...snap,queue:{steering:['returned'],items:[{id:'back',lane:'steering',text:'returned',images:[{type:'image',mimeType:'image/png',data:'aW1hZ2U='}]}]}};
    snapshot(); await page.waitForTimeout(150);
    await page.keyboard.press('Escape');
    await page.waitForFunction(()=>document.querySelector('#entry-input').value.startsWith('returned'));
    const recovered = await sendWith('Enter',await page.locator('#entry-input').inputValue());
    assert.equal(recovered.images[0].data,'aW1hZ2U=');
    snap={...snap,busy:false,streaming:false}; snapshot(); await page.waitForTimeout(150);
    assert.equal((await sendWith('Enter','plain')).behavior,undefined);
    assert.equal((await sendWith('Alt+Enter','plain too')).behavior,undefined);
    assert.deepEqual(errors,[]);
  } finally { await browser.close(); for(const ws of wss.clients) ws.terminate(); await new Promise(r=>wss.close(r)); await new Promise(r=>server.close(r)); }
});
