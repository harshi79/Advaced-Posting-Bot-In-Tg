"""apb.content — the words the bot says.

Welcome / help / demo content is built with :mod:`apb.rich` builders so
the bot itself is a walking showcase of free Rich Messages.
"""

from __future__ import annotations

from . import rich as R

# Free private-chat message effects (Bot API 7.2; still free in 10.3).
EFFECTS = {
    "🔥": "5104841245755180586",
    "👍": "5107584321108051014",
    "❤️": "5044134455711629726",
    "🎉": "5046509860389126442",
    "👎": "5104858069142078462",
}

STREAM_TEXT = (
    "🚀 Breaking: this bot just learned to type.\n\n"
    "Every word you see appearing here is being edited into the message in "
    "real time — no flicker, no reposts, just one smooth message. In private "
    "chats this uses sendRichMessageDraft, Telegram's native animated "
    "draft streaming from Bot API 10.1. In groups it falls back to perfectly "
    "paced live edits.\n\n"
    "Same message. Same thread. Zero spam. That's smooth."
)


def welcome_blocks(username=""):
    return [
        R.heading([R.bold("✨ Advanced Posting Bot")], 2),
        R.paragraph([
            "Hey! I turn plain Markdown into ",
            R.marked("rich, magazine-style Telegram posts"),
            " — headings, tables, checklists, collapsible sections, quotes, "
            "math, media and colored buttons.",
        ]),
        R.paragraph([
            R.bold("100% free."), " Rich Messages need ",
            R.code("Bot API 10.1+"),
            " — not Telegram Premium. Try ",
            R.bold("/demo"),
            " to see everything at once.",
        ]),
        R.divider(),
        R.checklist([
            ("Write a post in normal Markdown — /post", True),
            ("Preview it live, exactly as subscribers will see it", False),
            ("Publish now, schedule it, or broadcast to every chat", False),
            ("Watch it edit itself smoothly while you keep typing", False),
        ]),
        R.details("🧠 Wait — what exactly is a Rich Message?", [
            R.paragraph([
                "A document-style Telegram message (32,768 chars, 500 blocks "
                "max) any bot can send since Bot API 10.1. It renders real ",
                R.bold("headings"), ", ", R.bold("tables"),
                ", tappable ", R.bold("<details> sections"),
                ", LaTeX math, collages, slideshows and buttons inside the text."
            ]),
            R.paragraph([
                "The only Premium-gated bit is ",
                R.italic("custom emoji"),
                " — and this bot simply doesn't use it. 🙂"
            ]),
        ]),
        R.footer("Running on pure Bot API 10.3 · zero dependencies · no Premium anywhere"),
    ]


def help_markdown():
    return """\
## 📘 Commands

| Command | What it does |
| :- | :- |
| `/demo` | full Rich Message showcase (blocks mode) |
| `/post` | ✍️ compose a new post (admins) |
| `/stream` | 🔁 live-typing / smooth-editing demo |
| `/drafts` | saved drafts |
| `/schedule` | queued posts |
| `/stats` | delivery stats table |
| `/id` | this chat's id (ephemeral in groups!) |
| `/cancel` | abort whatever is in progress |

<details>
<summary>✍️ Composing — the fun part</summary>

1. `/post` — then just send Markdown, as many messages as you like.
2. Rich Markdown is GitHub-Flavored: headings, **bold**, ==marked==, ||spoilers||,
   tables, task lists, footnotes[^1], and code blocks all work.
3. Arbitrary rich HTML also works: `<details>`, `<aside>Pull quote<cite>credit</cite></aside>`,
   `<tg-map lat="41.9" long="12.5" zoom="14"/>`, `<tg-collage>`, `<tg-slideshow>`…
4. Attach media by sending a photo/video/audio/animation while composing — the bot
   saves it and tells you the `tg://photo?id=…` link to paste.
5. `/buttons` adds a colored action bar (blue `primary`, green `success`, red `danger`).
6. `/preview` renders the post right in the chat. Keep editing — **the preview
   updates itself, smoothly.**

[^1]: Like this one. Tappable footnotes, for free.
</details>

<details>
<summary>📤 Publishing</summary>

- **Here** — publish to the current chat.
- **Channel** — give an `@username` or numeric id where the bot is admin.
- **Everyone** — broadcast to all chats that ever `/start`ed the bot, with
  progress live-edited into the status panel.
- **Schedule** — natural times: `+2h`, `21:30`, `tomorrow 09:00`, `2026-12-25 10:00`.
</details>

<details>
<summary>🛠 Under the hood</summary>

- Pure Python 3 stdlib — talks raw HTTPS to the Bot API, no frameworks.
- Rich Messages: `sendRichMessage` · `editMessageText(rich_message=…)`.
- Smooth streaming: `sendRichMessageDraft` with a stable `draft_id`
  (Telegram animates the change) + the shimmering `thinking` block.
- Ephemeral group replies via `ephemeral_message_parameters`.
- Colored buttons via `InlineKeyboardButton.style` / `RichMessageButton.style`.
</details>

---

*Made with ❤ and zero dependencies.*"""


def demo_blocks():
    """The full free-richness showcase (blocks mode, no media needed)."""
    return [
        R.block_anchor("top"),
        R.heading([R.bold("✨ Everything below is FREE"), " — no Premium anywhere"], 1),
        R.paragraph([
            "This is one single Telegram message, built from ",
            R.marked("rich blocks"),
            " (Bot API 10.1–10.3). ",
            R.spoiler("Psst — spoilers work too. Tap me."),
        ]),
        R.divider(),

        R.heading("1 · Inline formatting", 3),
        R.paragraph([
            R.bold("bold"), " · ", R.italic("italic"), " · ",
            R.underline("underline"), " · ", R.strikethrough("strikethrough"), " · ",
            R.code("inline code"), " · ", R.marked("marked"), " · ",
            R.spoiler("spoiler"), " · ", "H", R.subscript("2"), "O · x",
            R.superscript("3"), " · ", R.inline_math("E = mc^2"), " · ",
            R.link("a link", "https://core.telegram.org/bots/api"),
        ]),

        R.heading("2 · Quotes", 3),
        R.pullquote("Bots that read like magazines, not terminals.", credit="— this bot, just now"),
        R.blockquote([
            R.paragraph([
                "“Added support for Rich Messages, allowing bots to send highly "
                "structured text and stream AI-generated replies with seamless "
                "rich formatting.”"
            ]),
        ], credit="Bot API 10.1 changelog"),

        R.heading("3 · Checklists & lists", 3),
        R.checklist([
            ("Rich Messages — Bot API 10.1", True),
            ("Block input + voice notes — 10.2", True),
            ("Buttons inside documents — 10.3", True),
            ("Custom emoji — requires Premium owner (skipped!)", False),
        ]),
        R.ordered_list([
            "write Markdown", "preview live", "publish everywhere", "sleep"
        ], label_type="1"),

        R.heading("4 · Tables", 3),
        R.table(
            [
                ["Feature", "Bot API", "Free?"],
                ["Rich blocks, tables, details", "10.1", "✅"],
                ["Animated streaming drafts", "10.1", "✅"],
                ["Ephemeral group replies", "10.2", "✅"],
                ["Buttons inside the text", "10.3", "✅"],
                ["Colored buttons", "9.4", "✅"],
                ["Custom emoji", "9.4", "⭐ Premium owner"],
            ],
            aligns=["left", "center", "center"], compact=True,
            caption="What makes a bot look rich — and what it costs",
        ),

        R.heading("5 · Math", 3),
        R.paragraph(["Inline ", R.inline_math("a^2+b^2=c^2"), " and as a display block:"]),
        R.math_block("\\int_{0}^{\\infty} e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}"),

        R.heading("6 · Collapsible details", 3),
        R.details("🔍 Tap to expand — spoiler-safe long content", [
            R.paragraph([
                "Long posts stay clean: put changelogs, footnotes or technical "
                "notes inside a ", R.code("<details>"), " block and readers "
                "only see the summary until they tap."
            ]),
            R.blockquote([R.paragraph(["Details can nest other blocks — quotes, lists…"])],
                         credit="nested, level 2"),
        ]),
        R.details("🧾 Even more nesting", [
            R.paragraph(["You can chain several details blocks in a row, each collapsed by default."]),
        ]),

        R.heading("7 · Buttons INSIDE the message", 3),
        R.paragraph([
            "Bot API 10.3 lets buttons live inside the document itself "
            "(not just as a keyboard below it) — with colors:"
        ]),
        R.buttons_row([
            R.rbutton("🔵 Primary", callback_data="apb:demo:secret", style="primary"),
            R.rbutton("🟢 Success", callback_data="apb:demo:secret", style="success"),
        ]),
        R.buttons_row([
            R.rbutton("🔴 Danger", callback_data="apb:demo:secret", style="danger"),
            R.rbutton("🔗 Link-style", callback_data="apb:demo:secret", style="link"),
        ], align="left"),

        R.heading("8 · Footnotes & anchors", 3),
        R.paragraph([
            "Claims need sources", R.superscript("[1]"), ". Or jump ",
            R.anchor_link("⬆ back to the top", ""),
            " of this message."
        ]),
        R.reference("core.telegram.org/bots/api-changelog — the official changelog, all versions", "1"),

        R.divider(),
        R.footer("One message · 500-block budget · 32K chars — sent free by Advanced Posting Bot 🤖"),
    ]


def demo_footer_keyboard():
    """Classic (below-message) keyboard — colored buttons, ephemeral demo."""
    from .utils import kb
    return kb([
        [{"text": "👀 Ephemeral secret (only you)", "callback_data": "apb:secret", "style": "primary"}],
        [
            {"text": "🎉 Effect", "callback_data": "apb:effect:🎉", "style": "success"},
            {"text": "🔥 Effect", "callback_data": "apb:effect:🔥", "style": "danger"},
        ],
        [{"text": "🔁 Watch smooth streaming", "callback_data": "apb:stream"}],
    ])


def composer_help_markdown():
    return """\
✍️ **Compose mode** — send me Markdown, one message at a time.

**Rich Markdown is GFM**: `# headings`, `**bold**`, `==marked==`, `||spoiler||`,
`> quotes`, tables, `- [ ]` task lists, footnotes[^1], code fences, math `$x^2$`,
plus rich HTML like `<details>`, `<aside>quote<cite>by</cite></aside>`,
`<tg-map lat="41.9" long="12.5" zoom="14"/>`.

[^1]: footnotes are free in rich messages!

Send **/preview** anytime to see it live — then keep typing, the preview
edits itself. **/done** when finished, **/cancel** to abort.

📎 Send a photo/video/audio/animation and I'll give you a
`tg://photo?id=m1` link to embed it in the text."""

