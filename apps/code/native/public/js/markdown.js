// Markdown, as a page to read (workbench-open.js): headings, paragraphs,
// emphasis, code, lists (nested, numbered, tasks), quotes, rules, tables,
// links and images. Everything in the text is escaped; HTML in it is shown
// as written, never run. Links go only to http(s), mailto, places in the
// page, or files beside it, which ctx names:
//
//   renderMarkdown(text, { file(href) -> path | null, raw(path) -> url })
//
// A link to a file becomes <a data-path="/its/path">, for the viewer to open;
// an image beside the page is shown through raw(path).

const esc = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const slug = text => text.toLowerCase().replace(/<[^>]*>/g, '').replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '-');
const SCHEME = /^([a-z][a-z0-9+.-]*):/i;

// Where a link goes, as attributes; null for anything that could run.
function target(href, ctx) {
  if (href.startsWith('#')) return `href="${esc(href)}" data-anchor="${esc(slug(decodeURIComponent(href.slice(1))))}"`;
  const scheme = SCHEME.exec(href)?.[1]?.toLowerCase();
  if (scheme === 'http' || scheme === 'https' || scheme === 'mailto') return `href="${esc(href)}" target="_blank" rel="noopener noreferrer"`;
  if (scheme) return null;
  const path = ctx.file?.(href);
  return path ? `href="#" data-path="${esc(path)}"` : null;
}
function source(src, ctx) {
  const scheme = SCHEME.exec(src)?.[1]?.toLowerCase();
  if (scheme === 'http' || scheme === 'https') return src;
  if (scheme === 'data') return /^data:image\/(png|jpe?g|gif|webp|avif|bmp);/i.test(src) ? src : null;
  if (scheme) return null;
  const path = ctx.file?.(src);
  return path ? ctx.raw?.(path) ?? null : null;
}

const LINK = /^\[((?:\[[^\]]*\]|\\.|[^\[\]\\])*)\]\(\s*(<[^>]*>|(?:[^\s()]|\([^\s()]*\))*)(?:\s+(?:"([^"]*)"|'([^']*)'))?\s*\)/;
const IMAGE = /^!\[((?:\\.|[^\]\\])*)\]\(\s*(<[^>]*>|(?:[^\s()]|\([^\s()]*\))*)(?:\s+(?:"([^"]*)"|'([^']*)'))?\s*\)/;
const bare = href => href.replace(/^<|>$/g, '');

export function inline(src, ctx = {}) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const rest = src.slice(i), before = src[i - 1] ?? ' ';
    let m;
    if (src[i] === '\\' && /[!-/:-@[-`{-~]/.test(src[i + 1] ?? '')) { out += esc(src[i + 1]); i += 2; continue; }
    if (src[i] === '\\' && src[i + 1] === '\n') { out += '<br>'; i += 2; continue; }
    if ((m = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/.exec(rest))) {
      out += `<code>${esc(m[2].replace(/\n/g, ' ').replace(/^ (.*) $/, '$1'))}</code>`;
      i += m[0].length; continue;
    }
    if ((m = IMAGE.exec(rest))) {
      const url = source(bare(m[2]), ctx), title = m[3] ?? m[4];
      out += url ? `<img src="${esc(url)}" alt="${esc(m[1])}"${title ? ` title="${esc(title)}"` : ''} loading="lazy">` : esc(m[1]);
      i += m[0].length; continue;
    }
    if ((m = LINK.exec(rest))) {
      const to = target(bare(m[2]), ctx), title = m[3] ?? m[4];
      const text = inline(m[1], ctx);
      out += to ? `<a ${to}${title ? ` title="${esc(title)}"` : ''}>${text}</a>` : text;
      i += m[0].length; continue;
    }
    if ((m = /^<((?:https?:\/\/|mailto:)[^\s<>]+)>/i.exec(rest))) {
      out += `<a href="${esc(m[1])}" target="_blank" rel="noopener noreferrer">${esc(m[1])}</a>`;
      i += m[0].length; continue;
    }
    if (!/[\p{L}\p{N}]/u.test(before) && (m = /^https?:\/\/[^\s<>"]*[^\s<>".,:;!?'")\]]/i.exec(rest))) {
      out += `<a href="${esc(m[0])}" target="_blank" rel="noopener noreferrer">${esc(m[0])}</a>`;
      i += m[0].length; continue;
    }
    if ((m = /^(\*\*|__)(?=\S)([\s\S]*?\S)\1/.exec(rest)) && (m[1] === '**' || !/[\p{L}\p{N}]/u.test(before))) {
      out += `<strong>${inline(m[2], ctx)}</strong>`;
      i += m[0].length; continue;
    }
    if ((m = /^(\*|_)(?=[^\s*_])([\s\S]*?[^\s\\])\1(?![*_\p{L}\p{N}])/u.exec(rest)) && (m[1] === '*' || !/[\p{L}\p{N}]/u.test(before))) {
      out += `<em>${inline(m[2], ctx)}</em>`;
      i += m[0].length; continue;
    }
    if ((m = /^~~(?=\S)([\s\S]*?\S)~~/.exec(rest))) {
      out += `<del>${inline(m[1], ctx)}</del>`;
      i += m[0].length; continue;
    }
    if ((m = /^ {2,}\n/.exec(rest))) { out += '<br>'; i += m[0].length; continue; }
    out += esc(src[i]);
    i += 1;
  }
  return out;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}> ?/;
const ITEM = /^( {0,3})([-*+]|\d{1,9}[.)])([ \t]+|$)(.*)$/;
const DIVIDER = /^ *\|? *:?-+:? *(\| *:?-+:? *)*\|? *$/;
const blank = line => !line.trim();
const cells = line => line.trim().replace(/^\|/, '').replace(/(^|[^\\])\|$/, '$1').split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, '|'));

function list(lines, start, ctx) {
  const first = ITEM.exec(lines[start]);
  const ordered = /\d/.test(first[2]);
  const kind = ordered ? first[2].slice(-1) : first[2];
  const items = [];
  let i = start, loose = false;
  while (i < lines.length) {
    const m = ITEM.exec(lines[i]);
    if (!m || m[1].length !== first[1].length || (ordered ? !/\d/.test(m[2]) || m[2].slice(-1) !== kind : m[2] !== kind)) break;
    const indent = m[1].length + m[2].length + Math.min(Math.max(m[3].length, 1), 4);
    const body = [m[4]];
    i += 1;
    while (i < lines.length) {
      const line = lines[i];
      if (blank(line)) { body.push(''); i += 1; continue; }
      const lead = line.match(/^ */)[0].length;
      if (lead >= indent) { body.push(line.slice(indent)); i += 1; continue; }
      // A line not indented under the item ends it, unless it carries on the
      // item's last paragraph.
      if (!blank(body.at(-1)) && !ITEM.exec(line) && !FENCE.test(line) && !HEADING.test(line) && !QUOTE.test(line) && !RULE.test(line)) { body.push(line.trim()); i += 1; continue; }
      break;
    }
    while (body.length && blank(body.at(-1))) body.pop();
    if (body.some((line, n) => blank(line) && n < body.length - 1 && !blank(body[n + 1] ?? '') && !/^ /.test(body[n + 1]))) loose = true;
    items.push(body);
    if (i < lines.length && blank(lines[i - 1] ?? '') && ITEM.exec(lines[i])) loose = true;
  }
  const html = items.map(body => {
    let task = '';
    const check = /^\[([ xX])\][ \t]+/.exec(body[0]);
    if (check) { task = `<input type="checkbox" disabled${check[1] === ' ' ? '' : ' checked'}> `; body[0] = body[0].slice(check[0].length); }
    let inner = blocks(body, ctx);
    if (!loose) inner = inner.replace(/<p>([\s\S]*?)<\/p>/g, '$1');
    return `<li${task ? ' class="task"' : ''}>${task}${inner}</li>`;
  }).join('');
  const number = ordered ? Number.parseInt(first[2], 10) : 1;
  return { html: ordered ? `<ol${number !== 1 ? ` start="${number}"` : ''}>${html}</ol>` : `<ul>${html}</ul>`, end: i };
}

function blocks(lines, ctx) {
  let out = '', para = [];
  const flush = () => { if (para.length) out += `<p>${inline(para.join('\n').trim(), ctx)}</p>`; para = []; };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    let m;
    if (blank(line)) { flush(); i += 1; continue; }
    if ((m = FENCE.exec(line))) {
      flush();
      const close = new RegExp(`^ {0,3}${m[1][0] === '`' ? '`' : '~'}{${m[1].length},}\\s*$`);
      const code = [];
      i += 1;
      while (i < lines.length && !close.test(lines[i])) code.push(lines[i++]);
      i += 1;
      out += `<pre><code${m[2] ? ` class="language-${esc(m[2])}"` : ''}>${esc(code.join('\n'))}</code></pre>`;
      continue;
    }
    if (para.length && (m = /^ {0,3}(=+|-+)[ \t]*$/.exec(line))) {
      const text = para.join('\n').trim(); para = [];
      const level = m[1][0] === '=' ? 1 : 2;
      out += `<h${level} id="${esc(slug(text))}">${inline(text, ctx)}</h${level}>`;
      i += 1; continue;
    }
    if ((m = HEADING.exec(line))) {
      flush();
      const text = m[2] ?? '';
      out += `<h${m[1].length} id="${esc(slug(text))}">${inline(text, ctx)}</h${m[1].length}>`;
      i += 1; continue;
    }
    if (RULE.test(line)) { flush(); out += '<hr>'; i += 1; continue; }
    if (QUOTE.test(line)) {
      flush();
      const quoted = [];
      while (i < lines.length && !blank(lines[i]) && (QUOTE.test(lines[i]) || quoted.length)) {
        if (!QUOTE.test(lines[i]) && (ITEM.test(lines[i]) || FENCE.test(lines[i]) || HEADING.test(lines[i]))) break;
        quoted.push(lines[i].replace(QUOTE, '')); i += 1;
      }
      out += `<blockquote>${blocks(quoted, ctx)}</blockquote>`;
      continue;
    }
    if (ITEM.test(line) && (!para.length || !/^\d/.test(line.trim()) || /^ {0,3}1[.)]/.test(line))) {
      flush();
      const found = list(lines, i, ctx);
      out += found.html; i = found.end;
      continue;
    }
    if (line.includes('|') && DIVIDER.test(lines[i + 1] ?? '') && lines[i + 1].includes('-')) {
      flush();
      const head = cells(line);
      const align = cells(lines[i + 1]).map(cell => (cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : cell.startsWith(':') ? 'left' : ''));
      const cell = (tag, text, n) => `<${tag}${align[n] ? ` style="text-align:${align[n]}"` : ''}>${inline(text, ctx)}</${tag}>`;
      let table = `<table><thead><tr>${head.map((text, n) => cell('th', text, n)).join('')}</tr></thead><tbody>`;
      i += 2;
      while (i < lines.length && !blank(lines[i]) && lines[i].includes('|')) {
        const row = cells(lines[i]);
        table += `<tr>${head.map((_, n) => cell('td', row[n] ?? '', n)).join('')}</tr>`;
        i += 1;
      }
      out += `${table}</tbody></table>`;
      continue;
    }
    if (!para.length && /^ {4}/.test(line)) {
      const code = [];
      while (i < lines.length && (/^ {4}/.test(lines[i]) || blank(lines[i]))) code.push(lines[i++].slice(4));
      while (code.length && blank(code.at(-1))) code.pop();
      out += `<pre><code>${esc(code.join('\n'))}</code></pre>`;
      continue;
    }
    para.push(line);
    i += 1;
  }
  flush();
  return out;
}

export function renderMarkdown(text, ctx = {}) {
  const lines = String(text).replace(/^﻿/, '').replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n');
  return blocks(lines, ctx);
}
