/**
 * src/rich.js — builders for Bot API 10.1–10.3 Rich Messages.
 *
 * Rich Messages let ANY bot send document-style messages — headings, lists,
 * tables, collapsible sections, quotes, math, media, even buttons inside the
 * text — **for free**.  No Telegram Premium anywhere (custom emoji is the
 * only Premium-gated bit and this bot never uses it).
 *
 * Three interchangeable content modes (exactly ONE per message):
 *
 *   markdown — GitHub-Flavored-Markdown-compatible string
 *   html     — the same feature set as HTML
 *   blocks   — explicit InputRichBlock objects (needed for in-document
 *              buttons and the draft-only "thinking" block)
 */

// ------------------------------------------------------------------ limits
export const MAX_CHARS = 32768;   // UTF-8 bytes of the parsed text
export const MAX_BLOCKS = 500;
export const MAX_NESTING = 16;
export const MAX_MEDIA = 50;
export const MAX_TABLE_COLS = 20;
export const BUTTON_STYLES = ['primary', 'success', 'danger', 'link'];
export const INLINE_STYLES = ['primary', 'success', 'danger'];

// ============================================================== RichText
// RichText is: a plain string | an array of RichText | a tagged object.

function rt(x) {
  if (x === null || x === undefined) return '';
  if (typeof x === 'string' || Array.isArray(x) || typeof x === 'object') return x;
  return String(x);
}

export const bold = (t) => ({ type: 'bold', text: rt(t) });
export const italic = (t) => ({ type: 'italic', text: rt(t) });
export const underline = (t) => ({ type: 'underline', text: rt(t) });
export const strikethrough = (t) => ({ type: 'strikethrough', text: rt(t) });
export const code = (t) => ({ type: 'code', text: rt(t) });
export const marked = (t) => ({ type: 'marked', text: rt(t) });
export const spoiler = (t) => ({ type: 'spoiler', text: rt(t) });
export const subscript = (t) => ({ type: 'subscript', text: rt(t) });
export const superscript = (t) => ({ type: 'superscript', text: rt(t) });
export const link = (t, url) => ({ type: 'url', text: rt(t), url });
export const email = (t, address) => ({ type: 'email_address', text: rt(t), email_address: address });
export const phone = (t, number) => ({ type: 'phone_number', text: rt(t), phone_number: number });
export const textMention = (t, userId) => ({ type: 'text_mention', text: rt(t), user: { id: userId, is_bot: false } });
export const inlineMath = (expression) => ({ type: 'mathematical_expression', expression });
export const dateTime = (t, unixTime, fmt) => ({
  type: 'date_time', text: rt(t), unix_time: unixTime, date_time_format: fmt,
});
export const anchor = (name) => ({ type: 'anchor', name });
export const anchorLink = (t, name = '') => ({ type: 'anchor_link', text: rt(t), anchor_name: name });
export const reference = (t, name) => ({ type: 'reference', text: rt(t), name });
export const referenceLink = (t, name) => ({ type: 'reference_link', text: rt(t), reference_name: name });

// ============================================================== RichBlocks

export const paragraph = (text) => ({ type: 'paragraph', text: rt(text) });

export function heading(text, size = 3) {
  const n = Math.max(1, Math.min(6, parseInt(size, 10) || 3));
  return { type: 'heading', text: rt(text), size: n };
}

export function pre(text, language = null) {
  const blk = { type: 'pre', text: rt(text) };
  if (language) blk.language = language;
  return blk;
}

export const footer = (text) => ({ type: 'footer', text: rt(text) });
export const divider = () => ({ type: 'divider' });
export const mathBlock = (expression) => ({ type: 'mathematical_expression', expression });
export const blockAnchor = (name) => ({ type: 'anchor', name });

// RichText entity types that are INLINE-ONLY — they must live inside a block's
// text, never as a top-level InputRichBlock. Telegram rejects them with
//   "can't parse InputRichBlock: type \"<name>\" is unsupported"
// when they appear at block level, so asBlocks() auto-wraps them in a paragraph
// to prevent a whole class of "it worked in my head" bugs.
//
// Types deliberately NOT listed here because they are ALSO valid blocks:
//   • "anchor"                   — InputRichBlockAnchor {type,name} (same shape
//                                 as inline RichTextAnchor)
//   • "mathematical_expression"  — RichBlockMathematicalExpression and inline
//                                 RichTextMathematicalExpression share the same
//                                 {type,expression} shape
const INLINE_ONLY_TYPES = new Set([
  'bold', 'italic', 'underline', 'strikethrough', 'spoiler', 'code', 'marked',
  'subscript', 'superscript',
  'text_mention', 'custom_emoji', 'date_time', 'button',
  'url', 'email_address', 'phone_number', 'bank_card_number',
  'mention', 'hashtag', 'cashtag', 'bot_command',
  'anchor_link', 'reference', 'reference_link',
]);

function isInlineOnly(x) {
  return x && typeof x === 'object' && !Array.isArray(x)
    && typeof x.type === 'string'
    && INLINE_ONLY_TYPES.has(x.type);
}

/** Normalize string | RichText | block | array thereof into a block list. */
export function asBlocks(x) {
  if (x === null || x === undefined) return [];
  if (typeof x === 'string') return [paragraph(x)];
  if (Array.isArray(x)) {
    const out = [];
    for (const item of x) {
      if (item === null || item === undefined) continue;
      if (typeof item === 'string') {
        out.push(paragraph(item));
      } else if (isInlineOnly(item)) {
        // An inline-only RichText entity slipped in at block level (e.g. a
        // footnote reference placed outside a paragraph). Wrap it in a
        // paragraph so Telegram doesn't 400 the whole message.
        out.push(paragraph(item));
      } else {
        out.push(item);
      }
    }
    return out;
  }
  if (typeof x === 'object') {
    if (isInlineOnly(x)) return [paragraph(x)];
    return [x];
  }
  return [paragraph(String(x))];
}

export function listItem(content, { checkbox = null, checked = false, value = null, labelType = null } = {}) {
  const item = { blocks: asBlocks(content) };
  const useCheckbox = checkbox === null ? (checked || value !== null || labelType !== null) : checkbox;
  if (useCheckbox) {
    item.has_checkbox = true;
    if (checked) item.is_checked = true;
  }
  if (value !== null && value !== undefined) item.value = parseInt(value, 10);
  if (['a', 'A', 'i', 'I', '1'].includes(labelType)) item.type = labelType;
  return item;
}

const isListItem = (x) => x && typeof x === 'object' && Array.isArray(x.blocks);

export const bulletList = (items) => ({
  type: 'list',
  items: (items || []).map((i) => (isListItem(i) ? i : listItem(i))),
});

export function orderedList(items, { start = null, labelType = null } = {}) {
  const built = [];
  (items || []).forEach((item, idx) => {
    if (isListItem(item)) {
      built.push(item);
    } else {
      built.push(listItem(item, { value: start === null ? null : start + idx, labelType }));
    }
  });
  return { type: 'list', items: built };
}

export const checklist = (pairs) => bulletList(
  (pairs || []).map(([content, checked]) => listItem(content, { checkbox: true, checked: !!checked })),
);

export function blockquote(content, credit = null) {
  const blk = { type: 'blockquote', blocks: asBlocks(content) };
  if (credit !== null && credit !== undefined) blk.credit = rt(credit);
  return blk;
}

export function pullquote(text, credit = null) {
  const blk = { type: 'pullquote', text: rt(text) };
  if (credit !== null && credit !== undefined) blk.credit = rt(credit);
  return blk;
}

function captionObj(text, credit) {
  if ((text === null || text === undefined) && (credit === null || credit === undefined)) return null;
  const cap = { text: rt(text ?? '') };
  if (credit !== null && credit !== undefined) cap.credit = rt(credit);
  return cap;
}

function cell(text, { isHeader = false, align = 'left', valign = 'top', colspan = 1, rowspan = 1 } = {}) {
  const c = { text: rt(text), align, valign };
  if (isHeader) c.is_header = true;
  if (colspan && parseInt(colspan, 10) > 1) c.colspan = parseInt(colspan, 10);
  if (rowspan && parseInt(rowspan, 10) > 1) c.rowspan = parseInt(rowspan, 10);
  return c;
}

/**
 * Build a RichBlockTable from plain rows.
 * rows: list of rows, each a list of cell contents.
 */
export function table(rows, {
  header = true, bordered = true, striped = true, compact = false,
  caption = null, aligns = null, valigns = null,
} = {}) {
  const n = Math.max(0, ...(rows || []).map((r) => r.length));
  if (n > MAX_TABLE_COLS) throw new Error(`table has ${n} columns, max is ${MAX_TABLE_COLS}`);
  const al = aligns && aligns.length ? aligns : new Array(n).fill('left');
  const va = valigns && valigns.length ? valigns : new Array(n).fill('top');
  const cells = (rows || []).map((row, rIdx) => row.map((content, cIdx) => cell(content, {
    isHeader: header && rIdx === 0,
    align: al[Math.min(cIdx, al.length - 1)],
    valign: va[Math.min(cIdx, va.length - 1)],
  })));
  const blk = { type: 'table', cells };
  if (bordered) blk.is_bordered = true;
  if (striped) blk.is_striped = true;
  if (compact) blk.is_compact = true;
  if (caption !== null) blk.caption = rt(caption);
  return blk;
}

export function details(summary, content, isOpen = false) {
  return { type: 'details', summary: rt(summary), blocks: asBlocks(content), is_open: !!isOpen };
}

export function mapBlock(latitude, longitude, {
  zoom = 13, width = 512, height = 320, caption = null, credit = null,
} = {}) {
  const blk = {
    type: 'map',
    location: { latitude, longitude },
    zoom: Math.max(0, Math.min(24, parseInt(zoom, 10) || 13)),
    width: parseInt(width, 10) || 512,
    height: parseInt(height, 10) || 320,
  };
  const cap = captionObj(caption, credit);
  if (cap) blk.caption = cap;
  return blk;
}

function mediaBlock(kind, mediaField, media, { caption = null, credit = null, spoiler = false, ...mediaKw } = {}) {
  const mediaObj = (media && typeof media === 'object' && !Array.isArray(media))
    ? media
    : {
      type: kind,
      media,
      ...Object.fromEntries(Object.entries(mediaKw).filter(([, v]) => v !== null && v !== undefined && v !== false)),
    };
  const blk = { type: kind, [mediaField]: mediaObj };
  const cap = captionObj(caption, credit);
  if (cap) blk.caption = cap;
  if (spoiler) blk.has_spoiler = true;
  return blk;
}

export const photoBlock = (media, opts = {}) => mediaBlock('photo', 'photo', media, opts);
export const videoBlock = (media, opts = {}) => mediaBlock('video', 'video', media, opts);
export const animationBlock = (media, opts = {}) => mediaBlock('animation', 'animation', media, opts);
export const audioBlock = (media, opts = {}) => mediaBlock('audio', 'audio', media, opts);
export const voiceNoteBlock = (media, opts = {}) => mediaBlock('voice_note', 'voice_note', media, opts);

export function collage(content, caption = null, credit = null) {
  const blk = { type: 'collage', blocks: asBlocks(content) };
  const cap = captionObj(caption, credit);
  if (cap) blk.caption = cap;
  return blk;
}

export function slideshow(content, caption = null, credit = null) {
  const blk = { type: 'slideshow', blocks: asBlocks(content) };
  const cap = captionObj(caption, credit);
  if (cap) blk.caption = cap;
  return blk;
}

// ------------------------------------------- buttons inside the document

/** RichMessageButton — exactly one of url / callbackData. */
export function rbutton(text, { url = null, callbackData = null, style = null } = {}) {
  if (!!url === !!callbackData) throw new Error('rbutton needs exactly one of url / callbackData');
  const btn = { text: rt(text) };
  if (url) {
    btn.url = url;
  } else {
    const bytes = Buffer.byteLength(callbackData, 'utf8');
    if (bytes < 1 || bytes > 64) throw new Error('callback_data must be 1-64 bytes');
    btn.callback_data = callbackData;
  }
  if (style) {
    if (!BUTTON_STYLES.includes(style)) throw new Error(`style must be one of ${BUTTON_STYLES.join(', ')}`);
    btn.style = style;
  }
  return btn;
}

/** InputRichBlockButtons — one visual row of 1-8 buttons. */
export function buttonsRow(buttons, align = 'center') {
  if (!Array.isArray(buttons) || buttons.length < 1 || buttons.length > 8) {
    throw new Error('a button row holds 1-8 buttons');
  }
  if (!['left', 'center', 'right'].includes(align)) throw new Error('align must be left/center/right');
  return { type: 'buttons', buttons, align };
}

// ------------------------------------------------- draft-only (10.1)

/** RichBlockThinking — ONLY valid inside sendRichMessageDraft. */
export const thinking = (text = 'Thinking…') => ({ type: 'thinking', text: rt(text) });

// ============================================================== messages

const MEDIA_KINDS = ['photo', 'video', 'audio', 'animation', 'voice_note', 'document'];

/**
 * InputRichMessageMedia — binds `tg://<kind>?id=<slot>` to real media.
 * Reference it from markdown with `![](tg://photo?id=<slot>)`.
 */
export function mediaRef(slot, media, kind, kw = {}) {
  if (!MEDIA_KINDS.includes(kind)) throw new Error(`unsupported media kind: ${kind}`);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(slot)) {
    throw new Error('slot ids are 1-64 chars of A-Z a-z 0-9 _ -');
  }
  const mediaObj = (media && typeof media === 'object' && !Array.isArray(media))
    ? media
    : {
      type: kind,
      media,
      ...Object.fromEntries(Object.entries(kw).filter(([, v]) => v !== null && v !== undefined)),
    };
  return { id: slot, media: mediaObj };
}

/** Build an InputRichMessage — exactly ONE of blocks/markdown/html. */
export function richMessage({ blocks = null, markdown = null, html = null, media = null, isRtl = false, skipEntityDetection = false } = {}) {
  const given = [blocks, markdown, html].filter((x) => x !== null && x !== undefined && x !== '');
  if (given.length !== 1) throw new Error('InputRichMessage needs exactly one of blocks/markdown/html');
  const irm = {};
  if (blocks !== null && blocks !== undefined) irm.blocks = asBlocks(blocks);
  if (markdown !== null && markdown !== undefined) irm.markdown = markdown;
  if (html !== null && html !== undefined) irm.html = html;
  if (media && media.length) irm.media = media;
  if (isRtl) irm.is_rtl = true;
  if (skipEntityDetection) irm.skip_entity_detection = true;
  return irm;
}

export const markdownMessage = (text, opts = {}) => richMessage({ markdown: text, ...opts });
export const htmlMessage = (text, opts = {}) => richMessage({ html: text, ...opts });

// ============================================================== analysis

/** Count blocks the way the 500-limit counts (nested blocks included). */
export function countBlocks(blocks) {
  let total = 0;
  for (const blk of asBlocks(blocks)) {
    total += 1;
    if (!blk || typeof blk !== 'object') continue;
    if (Array.isArray(blk.blocks) && blk.type !== 'list') total += countBlocks(blk.blocks);
    if (Array.isArray(blk.items)) {
      for (const item of blk.items) {
        total += 1;
        if (item && Array.isArray(item.blocks)) total += countBlocks(item.blocks);
      }
    }
    if (Array.isArray(blk.cells)) total += blk.cells.length; // each table row counts
  }
  return total;
}

export function nestingDepth(blocks) {
  let depth = 0;
  for (const blk of asBlocks(blocks)) {
    let inner = 0;
    if (blk && typeof blk === 'object') {
      if (Array.isArray(blk.blocks)) {
        inner = 1 + nestingDepth(blk.blocks);
      } else if (Array.isArray(blk.items)) {
        let itemDepth = 0;
        for (const item of blk.items) {
          if (item && Array.isArray(item.blocks)) itemDepth = Math.max(itemDepth, 1 + nestingDepth(item.blocks));
        }
        inner = 1 + itemDepth;
      }
    }
    depth = Math.max(depth, inner);
  }
  return depth;
}

function rtPlain(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(rtPlain).join('');
  if (typeof value === 'object') {
    if ('text' in value) return rtPlain(value.text);
    if ('expression' in value) return value.expression;
    return '';
  }
  return String(value);
}

/** Best-effort plain-text extraction from blocks (logs/previews). */
export function plainText(content) {
  const out = [];
  for (const blk of asBlocks(content)) {
    const t = blk.type;
    if (['paragraph', 'heading', 'pre', 'footer'].includes(t)) {
      out.push(rtPlain(blk.text));
    } else if (['blockquote', 'collage', 'slideshow', 'details'].includes(t)) {
      if (t === 'details') out.push(`${rtPlain(blk.summary)}:`);
      out.push(plainText(blk.blocks));
    } else if (t === 'list') {
      for (const item of blk.items || []) out.push(`• ${plainText(item.blocks)}`);
    } else if (t === 'table') {
      for (const row of blk.cells || []) out.push(row.map((c) => rtPlain(c.text)).join(' | '));
    } else if (t === 'pullquote') {
      out.push(`«${rtPlain(blk.text)}»`);
    } else if (t === 'mathematical_expression') {
      out.push(blk.expression || '');
    } else if (t === 'buttons') {
      out.push((blk.buttons || []).map((b) => rtPlain(b.text)).join(' '));
    }
  }
  return out.filter(Boolean).join('\n');
}

const MD_PATTERNS = [
  [/```[a-zA-Z0-9+-]*\n?([\s\S]*?)```/gm, '$1'],
  [/!\[[^\]]*\]\([^)]*\)/g, ''],
  [/\[([^\]]*)\]\([^)]*\)/g, '$1'],
  [/^[>#\-*+]+ ?/gm, ''],
  [/(\*\*|__|~~|==|\|\||`|!)/g, ''],
];

/** Rough markdown → plain text (summaries and classic fallbacks only). */
export function stripMarkdown(text) {
  let out = String(text ?? '');
  for (const [pattern, repl] of MD_PATTERNS) out = out.replace(pattern, repl);
  return out;
}

/** Plain text of any InputRichMessage. */
export function irmPlainText(irm) {
  if (irm.markdown !== undefined) return stripMarkdown(irm.markdown);
  if (irm.html !== undefined) return stripMarkdown(irm.html);
  return plainText(irm.blocks || []);
}

/** Validate an InputRichMessage against Bot API limits → array of problems. */
export function checkLimits(irm) {
  const problems = [];
  if (!irm || typeof irm !== 'object') return ['rich message must be an object'];
  const modes = ['blocks', 'markdown', 'html'].filter((m) => irm[m]);
  if (modes.length !== 1) {
    problems.push(`exactly one of blocks/markdown/html is required (got: ${modes.join(', ')})`);
    return problems;
  }
  if (irm.media && irm.media.length > MAX_MEDIA) {
    problems.push(`too many media attachments (${irm.media.length} > ${MAX_MEDIA})`);
  }
  let textLen;
  if (modes[0] === 'blocks') {
    const n = countBlocks(irm.blocks);
    if (n > MAX_BLOCKS) problems.push(`too many blocks (${n} > ${MAX_BLOCKS})`);
    const d = nestingDepth(irm.blocks);
    if (d > MAX_NESTING) problems.push(`nesting too deep (${d} > ${MAX_NESTING})`);
    textLen = Buffer.byteLength(plainText(irm.blocks), 'utf8');
  } else {
    textLen = Buffer.byteLength(String(irm[modes[0]]), 'utf8');
  }
  if (textLen > MAX_CHARS) problems.push(`text too long (${textLen} > ${MAX_CHARS} bytes)`);
  return problems;
}
