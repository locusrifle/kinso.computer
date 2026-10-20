// Words in time. A part is a list of paragraphs (script.mjs); spoken, every word has a start and an end, in seconds
// from the start of the recording, and the paragraph (para) it belongs to. Until Noah records a part, speak() times
// its words as if read aloud; his recording's own word timings replace that (align()), and everything timed to a
// word (cueTime) follows him. No DOM: Node tests these.
export const PACE = Object.freeze({
  lead: 0.6,       // s of quiet before the first word
  word: 0.17,      // s a word takes, plus `letter` for each of its letters (~160 words a minute)
  letter: 0.028,
  gap: 0.04,       // between words
  comma: 0.2,      // after a comma, a semicolon or a dash
  stop: 0.45,      // after a full stop, a question or a colon
  paragraph: 1.0,  // between paragraphs (the build's beats)
  tail: 1.2,       // after the last word
});
// A word as it is compared: lower case, letters, digits and apostrophes only.
export const norm = text => String(text).toLowerCase().replace(/[‘’]/g, "'").replace(/[^a-z0-9']/g, '');
export const wordsOf = text => String(text).split(/\s+/).filter(Boolean);
const STOP = /[.!?:]["”’)]?$/, PAUSE = /[,;—–]["”’)]?$/;

// The paragraphs read aloud at PACE: { duration, words: [{ text, start, end, para }] }.
export function speak(paragraphs, pace = PACE) {
  let t = pace.lead;
  const words = [];
  paragraphs.forEach((text, para) => {
    if (para) t += pace.paragraph;
    for (const text_ of wordsOf(text)) {
      const end = t + pace.word + pace.letter * norm(text_).length;
      words.push({ text: text_, start: +t.toFixed(3), end: +end.toFixed(3), para });
      t = end + pace.gap + (STOP.test(text_) ? pace.stop : PAUSE.test(text_) ? pace.comma : 0);
    }
  });
  return { duration: +(t + pace.tail).toFixed(3), words };
}

// The script's words at the times a recording says them. recorded: { duration, words: [{ text, start, end, beat? }] }
// (beat, 1-based, pins a word to a paragraph). Each script word is matched, in order, to the same word within the
// next few heard; one the recording skips takes its place between its neighbours.
export function align(paragraphs, recorded, { look = 8 } = {}) {
  const script = [];
  paragraphs.forEach((text, para) => { for (const word of wordsOf(text)) script.push({ text: word, para, start: null, end: null }); });
  const heard = (recorded?.words ?? []).filter(w => Number.isFinite(w.start)).map(w => ({ ...w, key: norm(w.text), end: Number.isFinite(w.end) ? w.end : w.start }));
  let j = 0;
  for (const word of script) {
    const key = norm(word.text);
    for (let k = j; k < Math.min(heard.length, j + look); k++) {
      const h = heard[k];
      if (h.key !== key || (h.beat != null && h.beat !== word.para + 1)) continue;
      word.start = h.start; word.end = h.end; j = k + 1; break;
    }
  }
  const duration = Number.isFinite(recorded?.duration) ? recorded.duration : (heard.at(-1)?.end ?? 0) + 1;
  // Unmatched runs: spread evenly between the matched words around them.
  for (let i = 0; i < script.length;) {
    if (script[i].start !== null) { i++; continue; }
    let k = i; while (k < script.length && script[k].start === null) k++;
    const from = i ? script[i - 1].end : 0, to = k < script.length ? script[k].start : duration;
    const step = Math.max(0, to - from) / (k - i + 1);
    for (let m = i; m < k; m++) { script[m].start = +(from + step * (m - i + 1) - step / 2).toFixed(3); script[m].end = +(script[m].start + step * .9).toFixed(3); }
    i = k;
  }
  return { duration, words: script };
}

// The recording's own words, given the paragraph of the script word each lines up with (for captions that say what
// was said). Words before the first match take the first paragraph.
export function heardWords(recorded, aligned) {
  const starts = aligned.words.map(w => [w.start, w.para]);
  let para = 0, i = 0;
  return (recorded?.words ?? []).filter(w => Number.isFinite(w.start)).map(w => {
    while (i < starts.length && starts[i][0] <= w.start + 1e-6) para = starts[i++][1];
    return { text: String(w.text), start: w.start, end: Number.isFinite(w.end) ? w.end : w.start, para: w.beat != null ? w.beat - 1 : para };
  });
}

// Subtitles: a sentence at a time; one longer than `max` words in even parts, each cut at a comma if one is near.
export function captions(words, { max = 13 } = {}) {
  const out = [], line = ws => out.push({ text: ws.map(w => w.text).join(' '), start: ws[0].start, end: ws.at(-1).end, para: ws[0].para });
  let sentence = [];
  const flush = () => {
    if (!sentence.length) return;
    const parts = Math.ceil(sentence.length / max), size = sentence.length / parts;
    let from = 0;
    for (let p = 1; p < parts; p++) {
      const target = Math.round(size * p);
      let cut = target;
      for (let d = 0; d <= 3; d++) {
        if (PAUSE.test(sentence[target - d - 1]?.text ?? '')) { cut = target - d; break; }
        if (PAUSE.test(sentence[target + d - 1]?.text ?? '')) { cut = target + d; break; }
      }
      line(sentence.slice(from, cut)); from = cut;
    }
    line(sentence.slice(from)); sentence = [];
  };
  for (const [i, word] of words.entries()) {
    if (sentence.length && word.para !== sentence[0].para) flush();
    sentence.push(word);
    // a colon ends a line unless only a word follows it ("the part you already know: messages.")
    const next = words[i + 1];
    if (STOP.test(word.text) && !(/:$/.test(word.text) && next && STOP.test(next.text) && !/:$/.test(next.text))) flush();
  }
  flush();
  return out;
}

// The line showing at t: from its first word until the next begins, held at most `hold` s after its last.
export function captionAt(lines, t, { hold = 1.2 } = {}) {
  let lo = 0, hi = lines.length - 1, at = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (lines[mid].start <= t) { at = mid; lo = mid + 1; } else hi = mid - 1; }
  if (at < 0) return null;
  const line = lines[at];
  return t <= line.end + hold ? line : null;
}

// When a word is said: the nth time `word` is said in paragraph `para` (0-based), its start or its end. A word the
// paragraph lacks falls back to the paragraph's own start, so a reworded take still moves on.
export function cueTime(words, { para, word, n = 0, edge = 'start', offset = 0 }) {
  const own = words.filter(w => w.para === para);
  if (!own.length) return words.at(-1)?.end ?? 0;
  const found = word ? own.filter(w => norm(w.text) === norm(word))[n] : own[0];
  const w = found ?? own[0];
  return +((edge === 'end' ? w.end : w.start) + offset).toFixed(3);
}
export const paraStart = (words, para) => cueTime(words, { para });
export const paraEnd = (words, para) => { const own = words.filter(w => w.para === para); return own.at(-1)?.end ?? 0; };
