/**
 * src/mdblocks.js — a small Markdown → InputRichBlock converter.
 *
 * Used when a post must be sent in *blocks* mode (e.g. slideshows built from
 * an uploaded album, where every photo is embedded by file_id inside an
 * InputRichBlockPhoto instead of a `tg://photo?id=` reference).
 *
 * Supported (a pragmatic subset of Rich Markdown):
 *   # .. ###### headings           > blockquote lines
 *   - / * bullet lists             1. ordered lists
 *   ```` ``` fenced code ``` ````  --- divider
 *   **bold** *italic* `code` ==marked== ||spoiler|| [text](url) ![alt](url)
 * Anything else becomes a paragraph.
 */

import * as R from './rich.js';

const INLINE = [
  ['code', /`([^`\n]+)`/g],
  ['bold', /\*\*([^*\n]+)\*\*/g],
  ['italic', /(?<!\*)\*([^*\n]+)\*(?!\*)/g],
  ['marked', /==([^=\n]+)==/g],
  ['spoiler', /\|\|([^|\n]+)\|\|/g],
  ['url', /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g],
];

const IMG = /!\[[^\]]*\]\(([^)\s]+)\)/g;

/** Convert one line of inline markdown into a RichText value. */
export function inline(text) {
  let s = String(text ?? '').replace(IMG, '');
  if (!s) return '';
  const tokens = [];
  for (const [kind, pattern] of INLINE) {
    pattern.lastIndex = 0;
    let m;
    while ((m = pattern.exec(s)) !== null) {
      tokens.push({ start: m.index, end: m.index + m[0].length, kind, groups: m.slice(1) });
    }
  }
  tokens.sort((a, b) => a.start - b.start);
  const out = [];
  let last = 0;
  for (const tok of tokens) {
    if (tok.start < last) continue;           // overlapping — skip
    if (tok.start > last) out.push(s.slice(last, tok.start));
    const [g1, g2] = tok.groups;
    if (tok.kind === 'code') out.push(R.code(g1));
    else if (tok.kind === 'bold') out.push(R.bold(g1));
    else if (tok.kind === 'italic') out.push(R.italic(g1));
    else if (tok.kind === 'marked') out.push(R.marked(g1));
    else if (tok.kind === 'spoiler') out.push(R.spoiler(g1));
    else if (tok.kind === 'url') out.push(R.link(g1, g2));
    last = tok.end;
  }
  if (last < s.length) out.push(s.slice(last));
  if (!out.length) return '';
  if (out.length === 1 && typeof out[0] === 'string') return out[0];
  return out;
}

/** Convert Rich Markdown text into an array of InputRichBlock dicts. */
export function mdToBlocks(markdown) {
  const blocks = [];
  const lines = String(markdown ?? '').replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  let paragraph = [];

  const flushParagraph = () => {
    if (paragraph.length) {
      const text = paragraph.filter(Boolean).join(' ');
      if (text.trim()) blocks.push(R.paragraph(inline(text)));
      paragraph = [];
    }
  };

  while (i < lines.length) {
    const line = lines[i];
    const stripped = line.trim();

    if (!stripped) { flushParagraph(); i += 1; continue; }

    if (stripped.startsWith('```')) {
      flushParagraph();
      const language = stripped.slice(3).trim() || null;
      const codeLines = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith('```')) { codeLines.push(lines[i]); i += 1; }
      i += 1; // closing fence
      blocks.push(R.pre(codeLines.join('\n'), language));
      continue;
    }

    let m = stripped.match(/^(#{1,6})\s+(.*)$/);
    if (m) { flushParagraph(); blocks.push(R.heading(inline(m[2]), m[1].length)); i += 1; continue; }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(stripped)) { flushParagraph(); blocks.push(R.divider()); i += 1; continue; }

    if (stripped.startsWith('>')) {
      flushParagraph();
      const quote = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        quote.push(lines[i].trim().replace(/^>/, '').trim());
        i += 1;
      }
      const body = quote.filter(Boolean).join(' ');
      blocks.push(R.blockquote(body ? [R.paragraph(inline(body))] : []));
      continue;
    }

    m = stripped.match(/^[-*+]\s+(.*)$/);
    if (m) {
      flushParagraph();
      const items = [];
      while (i < lines.length) {
        const mm = lines[i].trim().match(/^[-*+]\s+(.*)$/);
        if (!mm) break;
        let itemText = mm[1];
        let checked = null;
        const cm = itemText.match(/^\[([ xX])\]\s+(.*)$/);
        if (cm) { checked = cm[1].toLowerCase() === 'x'; itemText = cm[2]; }
        items.push(R.listItem(inline(itemText), { checkbox: checked !== null, checked: !!checked }));
        i += 1;
      }
      blocks.push(R.bulletList(items));
      continue;
    }

    m = stripped.match(/^(\d+)[.)]\s+(.*)$/);
    if (m) {
      flushParagraph();
      const items = [];
      while (i < lines.length) {
        const mm = lines[i].trim().match(/^(\d+)[.)]\s+(.*)$/);
        if (!mm) break;
        items.push(R.listItem(inline(mm[2])));
        i += 1;
      }
      blocks.push(R.orderedList(items));
      continue;
    }

    // table?
    if (stripped.startsWith('|') && stripped.endsWith('|')
        && i + 1 < lines.length && /^\|?[\s:|-]+\|?$/.test(lines[i + 1].trim())) {
      flushParagraph();
      const splitRow = (row) => row.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const header = splitRow(lines[i]);
      const sep = splitRow(lines[i + 1]);
      i += 2;
      const aligns = header.map((_, idx) => {
        const cellTxt = sep[idx] || '';
        if (cellTxt.startsWith(':') && cellTxt.endsWith(':')) return 'center';
        if (cellTxt.endsWith(':')) return 'right';
        return 'left';
      });
      const body = [header];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        body.push(splitRow(lines[i].trim()));
        i += 1;
      }
      blocks.push(R.table(body, { header: true, aligns }));
      continue;
    }

    paragraph.push(stripped);
    i += 1;
  }

  flushParagraph();
  return blocks;
}

export default mdToBlocks;
