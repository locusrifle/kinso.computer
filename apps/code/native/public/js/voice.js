// Both mic recordings and imported audio use the shared upload transport.
// Keep a failed recording/reference for explicit retry; never upload on a new
// tab merely because selection changed while permission or hearing was pending.
import { postUpload, useUpload } from './uploads.js';

export const isVoiceFile = file => /^(audio|video)\//.test(file?.type || '') || /\.(m4a|mp3|wav|ogg|opus|aac|flac|mp4|mov|webm|mkv)$/i.test(file?.name || '');

// A waveform: speaking, not a microphone.
const MIC = '<svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M3 8.5v3M6.5 6v8M10 3v14M13.5 6v8M17 8.5v3"/></svg>';

export function mountVoice({ input, fail = () => {}, send = null, captureTarget = () => null, uploadTarget = () => null }) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'entry-voice';
  button.innerHTML = MIC;
  const clock = document.createElement('span');
  clock.className = 'entry-voice-clock';
  button.append(clock);
  const canRecord = Boolean(navigator.mediaDevices?.getUserMedia && globalThis.MediaRecorder);
  let recorder = null, started = 0, ticking = null, hearing = 0, opening = null;
  // A recording that was not sent, to try again.
  let kept = null, operation = null;

  function paint() {
    const state = recorder ? 'recording' : opening || hearing ? 'hearing' : kept ? 'kept' : 'idle';
    button.dataset.state = state;
    button.hidden = !canRecord && !hearing && !kept;
    const label = opening ? 'Waiting for microphone permission (Esc cancels)' : { recording: send ? 'Stop and send (Esc cancels)' : 'Stop and transcribe (Esc cancels)', hearing: send ? 'Sending…' : 'Transcribing…', kept: 'Not sent: press to try again (Esc lets it go)', idle: 'Speak a prompt' }[state];
    button.title = label;
    button.setAttribute('aria-label', label);
    const seconds = recorder ? Math.floor((Date.now() - started) / 1000) : 0;
    clock.textContent = recorder ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : '';
  }

  // The words go where the cursor is, set apart from what is already there.
  function place(text) {
    const words = String(text || '').trim();
    if (!words) return;
    const at = input.selectionStart ?? input.value.length, end = input.selectionEnd ?? at;
    const before = input.value.slice(0, at), after = input.value.slice(end);
    const insert = `${before && !/\s$/.test(before) ? ' ' : ''}${words}${after && !/^\s/.test(after) ? ' ' : ''}`;
    input.setRangeText(insert, at, end, 'end');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus({ preventScroll: true });
  }

  // An imported file already has a draft attachment: hear that same scoped
  // reference, rather than uploading its bytes a second time.
  async function transcribe(file, receive = place, held = null, uploaded = null) {
    if (!held && (hearing || opening || recorder || kept)) { fail(new Error('finish or cancel the current recording before importing another')); return; }
    try { held ??= { file, receive, target: uploaded?.target ?? uploadTarget(), reference: uploaded?.reference }; }
    catch (error) { fail(error); return; }
    const controller = operation = new AbortController();
    hearing += 1; paint();
    try {
      held.reference ??= (await postUpload(file, { ...held.target, signal: controller.signal })).reference;
      const answer = await useUpload('transcribe', { audio: held.reference, tab: held.target.tabId,
        session: held.target.sessionId, instanceId: held.target.instanceId }, held.target, { signal: controller.signal });
      if (!answer.text) throw new Error(`no words heard in ${file.name || 'the recording'}`);
      if (controller.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      receive(answer.text, held.target); kept = null;
    } catch (error) { kept = held; fail(error); }
    finally { if (operation === controller) operation = null; hearing -= 1; paint(); }
  }

  // The recording, sent as the prompt; kept if it was not.
  async function deliver(held) {
    const controller = operation = new AbortController();
    hearing += 1;
    paint();
    try {
      await send(held.recording, held.target, controller.signal);
      kept = null;
    } catch (error) {
      kept = held;
      fail(new Error(`Send not confirmed: ${error.message}. Press the mic to try again.`));
    } finally {
      if (operation === controller) operation = null;
      hearing -= 1;
      paint();
    }
  }

  async function start() {
    let target;
    try { target = send ? captureTarget() : null; }
    catch (error) { fail(error); return; }
    // Bind the destination before permission can suspend this window.
    const pending = opening = { cancelled: false };
    paint();
    // A fresh session is made first: its destination comes a moment later.
    if (typeof target?.then === 'function') {
      try { target = await target; }
      catch (error) { opening = null; paint(); fail(error); return; }
      if (pending.cancelled) { opening = null; paint(); return; }
    }
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch (error) { fail(new Error(error?.name === 'NotAllowedError' ? 'the microphone is not allowed for this window' : `no microphone: ${error.message}`)); return; }
    finally { opening = null; paint(); }
    if (pending.cancelled) { for (const track of stream.getTracks()) track.stop(); return; }
    const type = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'].find(kind => MediaRecorder.isTypeSupported?.(kind));
    const chunks = [];
    try { recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined); }
    catch (error) { for (const track of stream.getTracks()) track.stop(); fail(error); return; }
    recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
    recorder.onstop = () => {
      for (const track of stream.getTracks()) track.stop();
      const keep = !recorder?.cancelled;
      recorder = null;
      clearInterval(ticking);
      paint();
      if (!keep || !chunks.length) return;
      const recording = new Blob(chunks, { type: chunks[0].type || type || 'audio/webm' });
      if (send) void deliver({ recording, target }); else void transcribe(recording);
    };
    try { recorder.start(1000); }
    catch (error) { recorder = null; for (const track of stream.getTracks()) track.stop(); fail(error); paint(); return; }
    started = Date.now();
    ticking = setInterval(paint, 1000);
    paint();
  }
  function stop({ cancel = false } = {}) {
    if (!recorder) return false;
    recorder.cancelled = cancel;
    recorder.stop();
    return true;
  }

  button.onclick = () => { if (recorder) stop(); else if (opening || hearing) return; else if (kept) void (kept.file ? transcribe(kept.file, kept.receive, kept) : deliver(kept)); else void start(); };
  addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    if (opening) { opening.cancelled = true; event.preventDefault(); }
    else if (stop({ cancel: true })) event.preventDefault();
    else if (operation) { operation.abort(); event.preventDefault(); }
    else if (kept && !hearing) { kept = null; paint(); event.preventDefault(); }
  }, true);
  paint();
  return { button, transcribe: (file, receive, uploaded) => transcribe(file, receive, null, uploaded), toggle: () => button.click(), holding: () => Boolean(opening || recorder || hearing || kept) };
}
