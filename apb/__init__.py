"""Advanced Posting Bot — a dependency-free Telegram bot built on Bot API 10.3.

The package speaks the raw Telegram Bot API over HTTPS (urllib only), so it
can use the newest "rich" features the moment they ship:

* Rich Messages (Bot API 10.1)  — headings, lists, tables, collapsible
  <details>, pull quotes, math, collages, slideshows, media blocks …
* Streaming drafts (10.1)       — sendRichMessageDraft with the animated
  "thinking" block for buttery-smooth live typing.
* Rich editing (10.1)           — editMessageText with rich_message.
* Blocks input + media (10.2)   — InputRichBlock*, tg://photo?id= links.
* Ephemeral messages (10.2/10.3)— replies visible to a single user.
* Colored buttons (9.4/10.3)    — InlineKeyboardButton.style and
  RichMessageButton inside rich documents.

All of the above is FREE — no Telegram Premium needed.  The only
Premium-gated feature is *custom emoji* (requires a Premium bot owner),
which this bot deliberately avoids.
"""

__version__ = "1.0.0"
API_TARGET = "Bot API 10.3 (August 24, 2026)"
