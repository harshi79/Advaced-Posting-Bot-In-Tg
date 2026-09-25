# 📚 Bot API Research — How a Telegram Bot Gets *Rich* for Free

Research notes for **Advanced Posting Bot**. Question: *how can a normal bot
(whose owner has **no** Telegram Premium) look premium?*

**Answer in one line:** Bot API **10.1 (June 11, 2026)** gave every bot
**Rich Messages** — real headings, tables, collapsible sections, math,
collages, in-text buttons — plus **animated streaming drafts** and **rich
editing**, all free. 10.2/10.3 rounded it out with outgoing block objects,
ephemeral (per-user) messages and buttons inside documents. The only
Premium-gated feature is **custom emoji**.

Full changelog: <https://core.telegram.org/bots/api-changelog>

---

## Version-by-version read-through

### Bot API 9.1 — July 3, 2025
- Native **checklists** (`Checklist`, `ChecklistTask`, `InputChecklist*`) — create/edit via business bots; detect progress via service messages.
- Gifts: last-sale price, transfer cooldown. Bots can check their **Telegram Stars balance**.
- **Polls: up to 12 options** (was 10). Mini Apps: `hideKeyboard()`.

### Bot API 9.2 — August 15, 2025
- **Channel Direct Messages chats** — bots can detect and operate DM chats belonging to channels they manage; topic metadata for direct messages.
- **Suggested Posts** in channels — detect, send, approve, decline, with price/date options and the full set of service messages.
- `ReplyParameters.checklist_task_id` — reply to a specific checklist task.

### Bot API 9.3 — December 31, 2025 — “AI Revolution”
- **Topics in 1-on-1 chats** — users can organize their bot chat into threads; all send/forward methods + chat actions work per topic.
- **Streaming drafts** — `sendMessageDraft` lets a bot *stream* a live response as it's generated (the plain-text ancestor of `sendRichMessageDraft`).
- Copied/forwarded messages can show **message effects** in private chats; bots can see **user ratings** (`User.rating`).

### Bot API 9.4 — February 9, 2026 — the “premium look” release
- **`style` on `KeyboardButton` / `InlineKeyboardButton`** — colored buttons: `primary` (blue), `success` (green), `danger` (red). **FREE.**
- `icon_custom_emoji_id` on buttons + custom emoji in bot messages — **requires the bot owner to have Telegram Premium.** (This is the one gate; we skip custom emoji entirely.)
- Bots can create topics in private chats, set/remove **their own profile photo**, handle `ChatOwnerLeft`, read `User.profile_audio`.

### Bot API 10.0 — April 3, 2026
- **Live photos** — `sendLivePhoto`, detect/send anywhere incl. paid media.
- **Reaction management** — `deleteMessageReaction`, `deleteAllMessageReactions`, `can_react_to_messages` permission.
- **Guest mode** — `answerGuestQuery`, `User.supports_guest_queries` (users talk to bots they're not sharing data with).
- Polls with **media** per poll/option; polls restrictable to chat members or specific countries. Access whitelist via BotFather / `getManagedBotAccessSettings`.
- **Bot-to-bot communication** enabled in groups and business mode.

### May 8, 2026 (unversioned)
- Business bots may manage user accounts **without the user needing Premium**.
- Bots can message other bots by username; business bots can reply to other bots.
- `BotAccessSettings` + `get/setManagedBotAccessSettings`.

### Bot API 10.1 — June 11, 2026 — 🎉 RICH MESSAGES
The big one. Any bot can now send **documents, not just texts**:
- **25 RichText entity types**: bold, italic, underline, strikethrough, **spoiler**, **marked/highlight**, sub/superscript, code, date-time, text-mention, math, url/email/phone/bank-card, hashtag, cashtag, bot-command, anchor, anchor-link, reference (footnotes), reference-link…
- **21 RichBlock types**: paragraph, section heading (h1–h6), preformatted, footer, divider, **LaTeX math**, anchor, **list** (checkboxes, ordered a/A/i/I/1), **blockquote** (with credit), **pull quote**, **collage**, **slideshow**, **table** (bordered/striped, colspan/rowspan, align/valign), **details** (collapsible), **map**, animation/audio/**photo**/video/**voice-note** blocks, and **thinking** (draft-only shimmer placeholder).
- `Message.rich_message`, `InputRichMessage` (exactly one of `markdown` / `html` — Rich Markdown ≈ GitHub-Flavored Markdown + rich HTML tags).
- **`sendRichMessage`** — post rich documents anywhere.
- **`sendRichMessageDraft`** — stream partial rich messages; same `draft_id` = **animated** updates; 30-second ephemeral preview; finalize with `sendRichMessage`. Private chats only.
- **`editMessageText` gained `rich_message`** — live-edit rich documents. (No separate `editRichMessage` method exists.)
- `InputRichMessageContent` — rich results in **inline, guest and Web App** queries.
- Join-request queries (`answerChatJoinRequestQuery`, `sendChatJoinRequestWebApp`), `ChatFullInfo.guard_bot`.
- **Limits**: 32,768 chars · 500 blocks (nested counted) · 16 nesting levels · 50 media · 20 table columns.

### Bot API 10.2 — July 14, 2026
- **`InputRichMessage.media` + `InputRichMessageMedia`** — reference uploads from markdown/html via `tg://photo?id=…`, `tg://video?id=…`, `tg://audio?id=…` (file_id, https URL or `attach://`).
- **`InputMediaVoiceNote`** — voice messages as rich media.
- **Outgoing block classes** (`InputRichBlock*`) — build rich messages as explicit block JSON, incl. `InputRichBlockListItem`.
- **Ephemeral messages** — group/supergroup messages visible to ONE user: `receiver_user_id` / `callback_query_id` params on 13 send methods; `Message.receiver_user`, `Message.ephemeral_message_id` (message_id reads 0); `ReplyParameters.ephemeral_message_id`; **`editEphemeralMessageText/Media/Caption/ReplyMarkup`** and **`deleteEphemeralMessage`**.
- Communities (`Community`, `CommunityChatAdded/Removed`, `ChatFullInfo.community`), `Update.subscription` (`BotSubscriptionUpdated`).
- Mini App origin enforcement (automatic since July 20, 2026; BotFather opt-out).

### Bot API 10.3 — August 24, 2026
- **Buttons inside rich documents**: `RichMessageButton` (styles `primary`/`success`/`danger`/`link`; `link` only with `callback_data`; 1–64 bytes) referenced by `RichBlockButtons` / `InputRichBlockButtons` (`align`: left/center/right, 1–8 buttons per row).
- `is_compact` on tables; **expandable block quotations** (`expandable_blockquote`); **document blocks** — `tg://document?id=…` links.
- **`EphemeralMessageParameters`** — replaced the loose `receiver_user_id`/`callback_query_id` params on 14 send methods (incl. `sendRichMessage`); **`replace_callback_query_message`** shows the ephemeral message *in place of* the tapped message.
- `editEphemeralMessageMedia` supports new uploads; `show_caption_above_media` on `editEphemeralMessageCaption`.
- Drafts: `can_stop` / `keep_on_stop`; `Update.stopped_message_generation` (`MessageGenerationStopped`) when a user hits ⏹.
- `DisabledButton` + `disabled` on inline buttons; `force_reply` on markups; `can_send_welcome_messages` admin right.

---

## Free vs Premium — the verdict

| Feature | API | Cost |
| :- | :- | :- |
| Rich Messages (all 21 block types, 32K chars) | 10.1 | ✅ free |
| Animated streaming drafts + thinking block | 10.1 | ✅ free (private chats) |
| `editMessageText` with `rich_message` | 10.1 | ✅ free |
| Rich content in inline/guest/WebApp results | 10.1 | ✅ free |
| Media inside documents (`tg://photo?id=`) | 10.2 | ✅ free |
| Ephemeral (one-user) group messages | 10.2/10.3 | ✅ free |
| Buttons inside documents | 10.3 | ✅ free |
| Colored reply-markup buttons | 9.4 | ✅ free |
| Message effects (`message_effect_id`) | 7.2 | ✅ free (private chats) |
| Reactions (`setMessageReaction`) | 6.0/10.0 | ✅ free |
| 12-option polls, checklists, suggested posts | 9.1–9.2 | ✅ free |
| **Custom emoji** in messages / on buttons | 9.4 | ⭐ **bot owner needs Telegram Premium** |
| Paid broadcast (`allow_paid_broadcast`, 0.1 ⭐/msg) | 8.0 | 💰 optional |

Client note: recipients need an up-to-date Telegram client to see rich
rendering; old clients get degraded/plain text.

## Sources
- Official changelog — core.telegram.org/bots/api-changelog (403 for bots; read via mirrors)
- Official API reference — core.telegram.org/bots/api (`EphemeralMessageParameters`, `InlineKeyboardButton.style`, rich method signatures)
- Rich-message canonical spec mirror — github.com/serejaris/telegram-skills `reference/rich-messages-spec.md`
- Library upgrade notes: python-telegram-bot #5261, go-telegram/bot CHANGELOG (v1.22.0), luzrain/telegram-bot-api PR #10 (10.3), phptg/bot-api releases, vendelieu/telegram-bot 9.6.0, yagop/node-telegram-bot-api v1.1.0
- Message effect IDs — gist.github.com/wiz0u/2a6d40c8f635687be363d72251a264da (via Stack Overflow)
