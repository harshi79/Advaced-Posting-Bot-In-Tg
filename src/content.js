/**
 * src/content.js — the words the bot says.
 *
 * Welcome / help / demo content is built with the rich builders, so the bot is
 * itself a walking showcase of free Rich Messages.
 */

import * as R from './rich.js';
import { kb } from './utils.js';

/**
 * Free private-chat message effects (Bot API 7.2 — still free in 10.3).
 *
 * Telegram never documented these ids and rotates them over time: the original
 * ❤️ id (`5044134455711629726`) now answers `400 EFFECT_ID_INVALID`; the current
 * one is `5159385139981059251`. Any entry below can go stale the same way, so
 * src/telegram.js blacklists ids Telegram rejects and re-sends the message
 * without the effect instead of failing the send.
 *
 * Overridable at runtime without a code change:
 *   APB_EFFECT_IDS='{"❤️":"5159385139981059251"}'
 * or `settings.effect_ids` in data/apb.json.
 */
export const EFFECTS = {
  '🔥': '5104841245755180586',
  '👍': '5107584321108051014',
  '❤️': '5159385139981059251',
  '🎉': '5046509860389126442',
  '👎': '5104858069142078462',
  '💩': '5046589136895476101',
};

/** Parse `APB_EFFECT_IDS` once per distinct value (tests may change the env). */
let envRaw = null;
let envCache = {};
function envEffectIds() {
  const raw = process.env.APB_EFFECT_IDS || '';
  if (raw === envRaw) return envCache;
  envRaw = raw;
  envCache = {};
  if (raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') envCache = parsed;
    } catch {
      // A malformed override must never break sending — ignore it.
    }
  }
  return envCache;
}

function cleanId(value) {
  return (typeof value === 'string' && /^\d{4,}$/.test(value.trim())) ? value.trim() : null;
}

/**
 * Resolve `emoji` to a usable effect id, or null when the table has nothing
 * valid for it. Overrides win over the built-in table; invalid overrides fall
 * back to it (a typo in a config var must not disable effects).
 */
export function effectId(emoji, overrides = null) {
  for (const source of [overrides, envEffectIds(), EFFECTS]) {
    if (!source || typeof source !== 'object') continue;
    if (!Object.prototype.hasOwnProperty.call(source, emoji)) continue;
    const id = cleanId(source[emoji]);
    if (id) return id;
  }
  return null;
}

export const STREAM_TEXT = '🚀 Breaking: this bot just learned to type.\n\n'
  + 'Every word you see appearing here is being edited into the message in real '
  + "time — no flicker, no reposts, just one smooth message. In private chats this "
  + "uses sendRichMessageDraft, Telegram's native animated draft streaming from "
  + 'Bot API 10.1. In groups it falls back to perfectly paced live edits.\n\n'
  + 'Same message. Same thread. Zero spam. That\'s smooth.';

export function welcomeBlocks() {
  return [
    R.heading([R.bold('✨ Advanced Posting Bot')], 2),
    R.paragraph([
      'Hey! I turn plain Markdown into ',
      R.marked('rich, magazine-style Telegram posts'),
      ' — headings, tables, checklists, collapsible sections, quotes, math, media and colored buttons.',
    ]),
    R.paragraph([
      R.bold('100% free.'), ' Rich Messages need ', R.code('Bot API 10.1+'),
      ' — not Telegram Premium. Try ', R.bold('/demo'), ' to see everything at once.',
    ]),
    R.divider(),
    R.checklist([
      ['Write a post in normal Markdown — /post', true],
      ['Preview it live, exactly as subscribers will see it', false],
      ['Publish now, schedule it, or broadcast to every chat', false],
      ['Watch it edit itself smoothly while you keep typing', false],
    ]),
    R.details('🧠 Wait — what exactly is a Rich Message?', [
      R.paragraph([
        'A document-style Telegram message (32,768 chars, 500 blocks max) any bot can send since Bot API 10.1. '
        + 'It renders real ', R.bold('headings'), ', ', R.bold('tables'), ', tappable ',
        R.bold('<details> sections'), ', LaTeX math, collages, slideshows and buttons inside the text.',
      ]),
      R.paragraph([
        'The only Premium-gated bit is ', R.italic('custom emoji'),
        " — and this bot simply doesn't use it. 🙂",
      ]),
    ]),
    R.footer('Running on pure Bot API 10.3 · Node.js, zero dependencies · no Premium anywhere'),
  ];
}

export function helpMarkdown() {
  return `## 📘 Commands

| Command | What it does |
| :- | :- |
| \`/demo\` | full Rich Message showcase (blocks mode) |
| \`/post\` | 🖍️ compose a new post (admins) |
| \`/bulk\` | 📦 bulk posting — collect many, post all or auto-schedule |
| \`/channels\` | 🌐 manage your channels (signature + delay each) |
| \`/templates\` | 📋 reusable post formats |
| \`/turbo\` | ⚡ toggle zero-click publishing |
| \`/slideshow\` | 🎞 build a slideshow from an album |
| \`/ai <topic>\` | 🤖 NVIDIA-powered writing (free forever) |
| \`/stream\` | 🔁 live-typing / smooth-editing demo |
| \`/drafts\` \`/schedule\` | drafts · scheduled & **recurring** posts |
| \`/stats\` \`/id\` \`/ping\` | stats · ids (ephemeral in groups!) |
| \`/edit\` \`/cancel\` | re-type a message live · abort anything |

<details>
<summary>🖍️ Composing — the fun part</summary>

1. \`/post\` — then just send Markdown, as many messages as you like.
2. Rich Markdown is GitHub-Flavored: headings, **bold**, ==marked==, ||spoilers||,
   tables, task lists, footnotes[^1], and code blocks all work.
3. Rich HTML also works: \`<details>\`, \`<aside>Pull quote<cite>credit</cite></aside>\`,
   \`<tg-map lat="41.9" long="12.5" zoom="14"/>\`, \`<tg-collage>\`, \`<tg-slideshow>\`…
4. Attach media by sending a photo/video/audio/animation while composing — the bot
   saves it and gives you the \`tg://photo?id=…\` link. Send an album and toggle
   🎞 **Slideshow** to render it as one slideshow.
5. \`/buttons\` adds a colored action bar (blue \`primary\`, green \`success\`, red \`danger\`).
6. \`/preview\` renders the post right in the chat. Keep editing — **the preview
   updates itself, smoothly.**
7. 🤖 AI buttons: **write** from a topic, **rewrite**, **translate**,
   **shorten**, **expand** — output streams in live, then loads into your post.

[^1]: Like this one. Tappable footnotes, for free.
</details>

<details>
<summary>📤 Publishing</summary>

- **Here** — publish to the current chat.
- **🌐 Channels** — fan out to every saved channel, each with its own
  **signature** and **delay** (\`/channels\`).
- **📣 Channel** — a one-off \`@username\`/id where the bot is admin.
- **📤 Everyone** — broadcast to all chats that ever started the bot.
- **📅 Schedule** — natural times (\`+2h\`, \`21:30\`, \`tomorrow 09:00\`)
  plus a **repeat**: hourly / daily / weekly / custom (\`every 6h\`).
- **⭐ Paid** — sell a photo/video post for Telegram Stars (experimental).
- **⚡ Turbo** (\`/turbo\`) — \`/done\` publishes instantly, no clicks.
- **📦 Bulk** (\`/bulk\`) — send 100 posts, post them all now or
  auto-schedule them spread over time.
</details>

<details>
<summary>🤖 AI — NVIDIA NIM, free forever</summary>

One model, NVIDIA's own latest flagship generation:
\`nvidia/nemotron-3-super-120b-a12b\` on **build.nvidia.com**'s free tier —
no credit card, no expiry, ~40 requests/minute.

Setup: grab a \`nvapi-…\` key at build.nvidia.com, then set
\`APB_NVIDIA_KEY\` in your service's environment and restart the bot.
</details>

<details>
<summary>🛠 Under the hood</summary>

- Pure **Node.js** — talks raw HTTPS to the Bot API with the built-in \`fetch\`,
  no frameworks and no npm dependencies.
- The same process also serves an HTTP status page on \`$PORT\`, which is what
  keeps web-service platforms (Veroa, Render, Railway) from calling the deploy
  a crash loop.
- Rich Messages: \`sendRichMessage\` · \`editMessageText(rich_message=…)\`.
- Smooth streaming: \`sendRichMessageDraft\` with a stable \`draft_id\`
  (Telegram animates the change) + the shimmering \`thinking\` block.
- Ephemeral group replies via \`ephemeral_message_parameters\`.
- Colored buttons via \`InlineKeyboardButton.style\` / \`RichMessageButton.style\`.
- Recurring jobs survive restarts (\`data/apb.json\`).
</details>

---

*Made with ❤ on Node.js and zero dependencies.*`;
}

/** The full free-richness showcase (blocks mode, no media needed). */
export function demoBlocks() {
  return [
    R.blockAnchor('top'),
    R.heading([R.bold('✨ Everything below is FREE'), ' — no Premium anywhere'], 1),
    R.paragraph([
      'This is one single Telegram message, built from ',
      R.marked('rich blocks'),
      ' (Bot API 10.1–10.3). ',
      R.spoiler('Psst — spoilers work too. Tap me.'),
    ]),
    R.divider(),

    R.heading('1 · Inline formatting', 3),
    R.paragraph([
      R.bold('bold'), ' · ', R.italic('italic'), ' · ',
      R.underline('underline'), ' · ', R.strikethrough('strikethrough'), ' · ',
      R.code('inline code'), ' · ', R.marked('marked'), ' · ',
      R.spoiler('spoiler'), ' · ', 'H', R.subscript('2'), 'O · x',
      R.superscript('3'), ' · ', R.inlineMath('E = mc^2'), ' · ',
      R.link('a link', 'https://core.telegram.org/bots/api'),
    ]),

    R.heading('2 · Quotes', 3),
    R.pullquote('Bots that read like magazines, not terminals.', '— this bot, just now'),
    R.blockquote(
      ['“Added support for Rich Messages, allowing bots to send highly structured text '
        + 'and stream AI-generated replies with seamless rich formatting.”'],
      'Bot API 10.1 changelog',
    ),

    R.heading('3 · Checklists & lists', 3),
    R.checklist([
      ['Rich Messages — Bot API 10.1', true],
      ['Block input + voice notes — 10.2', true],
      ['Buttons inside documents — 10.3', true],
      ['Custom emoji — requires Premium owner (skipped!)', false],
    ]),
    R.orderedList(['write Markdown', 'preview live', 'publish everywhere', 'sleep'], { labelType: '1' }),

    R.heading('4 · Tables', 3),
    R.table(
      [
        ['Feature', 'Bot API', 'Free?'],
        ['Rich blocks, tables, details', '10.1', '✅'],
        ['Animated streaming drafts', '10.1', '✅'],
        ['Ephemeral group replies', '10.2', '✅'],
        ['Buttons inside the text', '10.3', '✅'],
        ['Colored buttons', '9.4', '✅'],
        ['Custom emoji', '9.4', '⭐ Premium owner'],
      ],
      { aligns: ['left', 'center', 'center'], compact: true, caption: 'What makes a bot look rich — and what it costs' },
    ),

    R.heading('5 · Math', 3),
    R.paragraph(['Inline ', R.inlineMath('a^2+b^2=c^2'), ' and as a display block:']),
    R.mathBlock('\\int_{0}^{\\infty} e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}'),

    R.heading('6 · Collapsible details', 3),
    R.details('🔍 Tap to expand — spoiler-safe long content', [
      R.paragraph([
        'Long posts stay clean: put changelogs, footnotes or technical notes inside a ',
        R.code('<details>'), ' block and readers only see the summary until they tap.',
      ]),
      R.blockquote(['Details can nest other blocks — quotes, lists…'], 'nested, level 2'),
    ]),
    R.details('🧾 Even more nesting', [
      R.paragraph(['You can chain several details blocks in a row, each collapsed by default.']),
    ]),

    R.heading('7 · Buttons INSIDE the message', 3),
    R.paragraph([
      'Bot API 10.3 lets buttons live inside the document itself (not just as a keyboard '
      + 'below it) — with colors:',
    ]),
    R.buttonsRow([
      R.rbutton('🔵 Primary', { callbackData: 'apb:demo:secret', style: 'primary' }),
      R.rbutton('🟢 Success', { callbackData: 'apb:demo:secret', style: 'success' }),
    ]),
    R.buttonsRow([
      R.rbutton('🔴 Danger', { callbackData: 'apb:demo:secret', style: 'danger' }),
      R.rbutton('🔗 Link-style', { callbackData: 'apb:demo:secret', style: 'link' }),
    ], 'left'),

    R.heading('8 · Footnotes & anchors', 3),
    R.paragraph([
      'Claims need sources', R.superscript('[1]'), '. Or jump ',
      R.anchorLink('⬆ back to the top', ''),
      ' of this message.',
    ]),
    R.reference('core.telegram.org/bots/api-changelog — the official changelog, all versions', '1'),

    R.divider(),
    R.footer('One message · 500-block budget · 32K chars — sent free by Advanced Posting Bot 🤖'),
  ];
}

/** Classic (below-message) keyboard — colored buttons, ephemeral demo. */
export function demoFooterKeyboard() {
  return kb([
    [{ text: '👀 Ephemeral secret (only you)', callback_data: 'apb:secret', style: 'primary' }],
    [
      { text: '🎉 Effect', callback_data: 'apb:effect:🎉', style: 'success' },
      { text: '🔥 Effect', callback_data: 'apb:effect:🔥', style: 'danger' },
    ],
    [{ text: '🔁 Watch smooth streaming', callback_data: 'apb:stream' }],
  ]);
}

export function composerHelpMarkdown() {
  return '✍️ **Compose mode** — send me Markdown, one message at a time.\n\n'
    + '**Rich Markdown is GFM**: `# headings`, `**bold**`, `==marked==`, `||spoiler||`,\n'
    + '`> quotes`, tables, `- [ ]` task lists, footnotes[^1], code fences, math `$x^2$`,\n'
    + 'plus rich HTML like `<details>`, `<aside>quote<cite>by</cite></aside>`,\n'
    + '`<tg-map lat="41.9" long="12.5" zoom="14"/>`.\n\n'
    + '[^1]: footnotes are free in rich messages!\n\n'
    + 'Send **/preview** anytime to see it live — then keep typing, the preview '
    + 'edits itself. **/done** when finished, **/cancel** to abort.\n\n'
    + '📎 Send a photo/video/audio/animation and I\'ll give you a '
    + '`tg://photo?id=m1` link to embed it in the text.';
}
