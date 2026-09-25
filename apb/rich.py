"""apb.rich — builders for Bot API 10.3 Rich Messages.

Rich Messages (Bot API 10.1, extended in 10.2/10.3) let ANY bot send
document-style messages — headings, lists, tables, collapsible sections,
quotes, math, media, even buttons inside the text — **for free**.  No
Telegram Premium is required (custom emoji is the only Premium-gated bit,
and this module avoids it).

Three interchangeable content modes (exactly ONE per message):

* ``markdown``  — GitHub-Flavored-Markdown-compatible string; the server
  parses headings/tables/lists/footnotes, plus rich HTML tags like
  ``<details>``, ``<tg-map>``, ``<tg-collage>`` …
* ``html``      — the same rich feature set described as HTML.
* ``blocks``    — explicit ``InputRichBlock`` objects (this module's
  builders produce them).  Needed for things markdown cannot express,
  e.g. in-document button rows and the draft-only "thinking" block.

Media referenced from markdown/html goes through
``InputRichMessage.media`` (id -> InputMedia*); inside ``blocks`` the
``InputMedia*`` object is embedded directly in the media block.
"""

from __future__ import annotations

# ---------------------------------------------------------------- limits
MAX_CHARS = 32768          # UTF-8 chars incl. alt-text & formulas
MAX_BLOCKS = 500           # incl. nested blocks, list items, table rows…
MAX_NESTING = 16
MAX_MEDIA = 50
MAX_TABLE_COLS = 20
BUTTON_STYLES = ("primary", "success", "danger", "link")
INLINE_STYLES = ("primary", "success", "danger")   # reply-markup buttons


# ============================================================ RichText
# RichText is: a plain string | a list of RichText | a tagged dict.

def _rt(x):
    """Normalize anything into a valid RichText value."""
    if x is None:
        return ""
    if isinstance(x, (str, dict, list)):
        return x
    return str(x)


def bold(t):
    return {"type": "bold", "text": _rt(t)}


def italic(t):
    return {"type": "italic", "text": _rt(t)}


def underline(t):
    return {"type": "underline", "text": _rt(t)}


def strikethrough(t):
    return {"type": "strikethrough", "text": _rt(t)}


def code(t):
    return {"type": "code", "text": _rt(t)}


def marked(t):
    """Highlighted text — ``==like this==``."""
    return {"type": "marked", "text": _rt(t)}


def spoiler(t):
    return {"type": "spoiler", "text": _rt(t)}


def subscript(t):
    return {"type": "subscript", "text": _rt(t)}


def superscript(t):
    return {"type": "superscript", "text": _rt(t)}


def link(t, url):
    return {"type": "url", "text": _rt(t), "url": url}


def email(t, address):
    return {"type": "email_address", "text": _rt(t), "email_address": address}


def phone(t, number):
    return {"type": "phone_number", "text": _rt(t), "phone_number": number}


def text_mention(t, user_id):
    return {"type": "text_mention", "text": _rt(t), "user": {"id": user_id, "is_bot": False}}


def inline_math(expression):
    return {"type": "mathematical_expression", "expression": expression}


def date_time(t, unix_time, fmt):
    return {"type": "date_time", "text": _rt(t), "unix_time": unix_time, "date_time_format": fmt}


def anchor(name):
    return {"type": "anchor", "name": name}


def anchor_link(t, name=""):
    """Link to an in-document anchor; empty name jumps back to the top."""
    return {"type": "anchor_link", "text": _rt(t), "anchor_name": name}


def reference(t, name):
    """Footnote definition — ``<tg-reference name="...">…</tg-reference>``."""
    return {"type": "reference", "text": _rt(t), "name": name}


def reference_link(t, name):
    return {"type": "reference_link", "text": _rt(t), "reference_name": name}


# ============================================================ RichBlocks

def paragraph(text):
    return {"type": "paragraph", "text": _rt(text)}


def heading(text, size=3):
    """``size`` 1..6 — 1 is the LARGEST font (like <h1>)."""
    size = max(1, min(6, int(size)))
    return {"type": "heading", "text": _rt(text), "size": size}


def pre(text, language=None):
    blk = {"type": "pre", "text": _rt(text)}
    if language:
        blk["language"] = language
    return blk


def footer(text):
    return {"type": "footer", "text": _rt(text)}


def divider():
    return {"type": "divider"}


def math_block(expression):
    """Block-level LaTeX formula — ``<tg-math-block>``."""
    return {"type": "mathematical_expression", "expression": expression}


def block_anchor(name):
    return {"type": "anchor", "name": name}


def _as_blocks(x):
    """Normalize str | RichText | block | list thereof into a block list."""
    if x is None:
        return []
    if isinstance(x, str):
        return [paragraph(x)]
    if isinstance(x, dict):
        return [x]
    out = []
    for item in x:
        if item is None:
            continue
        if isinstance(item, str):
            out.append(paragraph(item))
        elif isinstance(item, (dict, list)):
            out.append(item)
    return out


def list_item(content, checkbox=None, checked=False, value=None, label_type=None):
    """One list item; ``content`` is blocks (str -> paragraph)."""
    item = {"blocks": _as_blocks(content)}
    if checkbox is None:
        checkbox = checked or value is not None or label_type is not None
    if checkbox:
        item["has_checkbox"] = True
        if checked:
            item["is_checked"] = True
    if value is not None:
        item["value"] = int(value)
    if label_type in ("a", "A", "i", "I", "1"):
        item["type"] = label_type
    return item


def bullet_list(items):
    """Unordered list; ``items`` are list_item() dicts (or content values)."""
    return {
        "type": "list",
        "items": [i if isinstance(i, dict) and "blocks" in i else list_item(i) for i in items],
    }


def ordered_list(items, start=None, label_type=None):
    items = list(items)
    built = []
    for idx, i in enumerate(items):
        if isinstance(i, dict) and "blocks" in i:
            built.append(i)
        else:
            built.append(list_item(i, value=None if start is None else start + idx,
                                   label_type=label_type))
    return {"type": "list", "items": built}


def checklist(pairs):
    """Checklist — pairs of (content, is_checked)."""
    return bullet_list([list_item(c, checkbox=True, checked=ck) for c, ck in pairs])


def blockquote(content, credit=None):
    blk = {"type": "blockquote", "blocks": _as_blocks(content)}
    if credit is not None:
        blk["credit"] = _rt(credit)
    return blk


def pullquote(text, credit=None):
    """Centered 'magazine' quote — <aside>."""
    blk = {"type": "pullquote", "text": _rt(text)}
    if credit is not None:
        blk["credit"] = _rt(credit)
    return blk


def _caption(text, credit=None):
    if text is None and credit is None:
        return None
    cap = {"text": _rt(text or "")}
    if credit is not None:
        cap["credit"] = _rt(credit)
    return cap


def _cell(text, is_header=False, align="left", valign="top", colspan=1, rowspan=1):
    """RichBlockTableCell — align/valign are required (Bot API 10.3)."""
    cell = {"text": _rt(text), "align": align, "valign": valign}
    if is_header:
        cell["is_header"] = True
    if colspan and int(colspan) > 1:
        cell["colspan"] = int(colspan)
    if rowspan and int(rowspan) > 1:
        cell["rowspan"] = int(rowspan)
    return cell


def table(rows, header=True, bordered=True, striped=True, compact=False,
          caption=None, aligns=None, valigns=None):
    """Build a RichBlockTable from plain rows of strings/RichText.

    ``rows``      — list of rows; each row is a list of cell contents.
    ``header``    — treat the first row as a header row.
    ``aligns``    — per-column alignment list ("left"|"center"|"right").
    ``valigns``   — per-column vertical alignment ("top"|"middle"|"bottom").
    """
    n = max((len(r) for r in rows), default=0)
    if n > MAX_TABLE_COLS:
        raise ValueError("table has {} columns, max is {}".format(n, MAX_TABLE_COLS))
    aligns = (aligns or ["left"] * n)
    valigns = (valigns or ["top"] * n)
    cells = []
    for r_idx, row in enumerate(rows):
        line = []
        for c_idx, content in enumerate(row):
            line.append(_cell(
                content,
                is_header=(header and r_idx == 0),
                align=aligns[min(c_idx, len(aligns) - 1)],
                valign=valigns[min(c_idx, len(valigns) - 1)],
            ))
        cells.append(line)
    blk = {"type": "table", "cells": cells}
    if bordered:
        blk["is_bordered"] = True
    if striped:
        blk["is_striped"] = True
    if compact:
        blk["is_compact"] = True
    if caption is not None:
        blk["caption"] = _rt(caption)
    return blk


def details(summary, content, is_open=False):
    """Collapsible section — <details>/<summary>."""
    return {
        "type": "details",
        "summary": _rt(summary),
        "blocks": _as_blocks(content),
        "is_open": bool(is_open),
    }


def map_block(latitude, longitude, zoom=13, width=512, height=320, caption=None, credit=None):
    blk = {
        "type": "map",
        "location": {"latitude": latitude, "longitude": longitude},
        "zoom": max(0, min(24, int(zoom))),
        "width": int(width),
        "height": int(height),
    }
    cap = _caption(caption, credit)
    if cap:
        blk["caption"] = cap
    return blk


def _media_block(kind, media_field, media, caption=None, credit=None, spoiler=False, **media_kw):
    if not isinstance(media, dict):
        media_obj = {"type": kind, "media": media}
        media_obj.update({k: v for k, v in media_kw.items() if v is not None})
    else:
        media_obj = media
    blk = {"type": kind, media_field: media_obj}
    cap = _caption(caption, credit)
    if cap:
        blk["caption"] = cap
    if spoiler:
        blk["has_spoiler"] = True
    return blk


def photo_block(media, caption=None, credit=None, spoiler=False, **kw):
    """``media`` — file_id, https:// URL or an InputMediaPhoto dict."""
    return _media_block("photo", "photo", media, caption, credit, spoiler, **kw)


def video_block(media, caption=None, credit=None, spoiler=False, width=None,
                height=None, duration=None, supports_streaming=True):
    return _media_block(
        "video", "video", media, caption, credit, spoiler,
        width=width, height=height, duration=duration,
        supports_streaming=True if supports_streaming else None,
    )


def animation_block(media, caption=None, credit=None, spoiler=False, width=None,
                    height=None, duration=None):
    return _media_block("animation", "animation", media, caption, credit, spoiler,
                        width=width, height=height, duration=duration)


def audio_block(media, caption=None, credit=None, duration=None, performer=None, title=None):
    return _media_block("audio", "audio", media, caption, credit, False,
                        duration=duration, performer=performer, title=title)


def voice_note_block(media, caption=None, credit=None, duration=None):
    return _media_block("voice_note", "voice_note", media, caption, credit, False,
                        duration=duration)


def collage(content, caption=None, credit=None):
    """Grid of media blocks — <tg-collage>."""
    blk = {"type": "collage", "blocks": _as_blocks(content)}
    cap = _caption(caption, credit)
    if cap:
        blk["caption"] = cap
    return blk


def slideshow(content, caption=None, credit=None):
    blk = {"type": "slideshow", "blocks": _as_blocks(content)}
    cap = _caption(caption, credit)
    if cap:
        blk["caption"] = cap
    return blk


# ------------------------------------------------ buttons (Bot API 10.3)

def rbutton(text, url=None, callback_data=None, style=None):
    """RichMessageButton — a button INSIDE the rich document.

    Exactly one action: ``url`` or ``callback_data`` (1-64 bytes).
    ``style``: "primary" (blue), "success" (green), "danger" (red) or
    "link" (looks like a hyperlink; callback_data only).
    """
    if bool(url) == bool(callback_data):
        raise ValueError("rbutton needs exactly one of url / callback_data")
    btn = {"text": _rt(text)}
    if url:
        btn["url"] = url
    else:
        data = callback_data.encode("utf-8")
        if not 1 <= len(data) <= 64:
            raise ValueError("callback_data must be 1-64 bytes")
        btn["callback_data"] = callback_data
    if style:
        if style not in BUTTON_STYLES:
            raise ValueError("style must be one of {}".format(BUTTON_STYLES))
        btn["style"] = style
    return btn


def buttons_row(buttons, align="center"):
    """InputRichBlockButtons — one visual row of 1-8 RichMessageButtons."""
    if not 1 <= len(buttons) <= 8:
        raise ValueError("a button row holds 1-8 buttons")
    if align not in ("left", "center", "right"):
        raise ValueError("align must be left/center/right")
    return {"type": "buttons", "buttons": buttons, "align": align}


# ------------------------------------------------- draft-only (10.1)

def thinking(text="Thinking…"):
    """RichBlockThinking — ONLY valid inside sendRichMessageDraft."""
    return {"type": "thinking", "text": _rt(text)}


# ============================================================ messages

def media_ref(slot, media, kind, **kw):
    """InputRichMessageMedia — binds ``tg://<kind>?id=<slot>`` to real media.

    Use inside the ``media`` array of an InputRichMessage that carries
    markdown/html content; reference it from the text with
    ``![](tg://photo?id=<slot>)`` (markdown) or ``<img src="tg://photo?id=…"/>``.
    """
    if kind not in ("photo", "video", "audio", "animation", "voice_note", "document"):
        raise ValueError("unsupported media kind: " + kind)
    if not 1 <= len(slot) <= 64 or not all(c.isalnum() or c in "_-" for c in slot):
        raise ValueError("slot ids are 1-64 chars of A-Z a-z 0-9 _ -")
    if not isinstance(media, dict):
        media_obj = {"type": kind, "media": media}
        media_obj.update({k: v for k, v in kw.items() if v is not None})
    else:
        media_obj = media
    return {"id": slot, "media": media_obj}


def rich_message(blocks=None, markdown=None, html=None, media=None,
                 is_rtl=None, skip_entity_detection=None):
    """Build an InputRichMessage — exactly ONE of blocks/markdown/html."""
    given = [x for x in (blocks, markdown, html) if x]
    if len(given) != 1:
        raise ValueError("InputRichMessage needs exactly one of blocks/markdown/html")
    irm = {}
    if blocks is not None:
        irm["blocks"] = _as_blocks(blocks)
    if markdown is not None:
        irm["markdown"] = markdown
    if html is not None:
        irm["html"] = html
    if media:
        irm["media"] = media
    if is_rtl:
        irm["is_rtl"] = True
    if skip_entity_detection:
        irm["skip_entity_detection"] = True
    return irm


def markdown_message(text, media=None, **kw):
    return rich_message(markdown=text, media=media, **kw)


def html_message(text, media=None, **kw):
    return rich_message(html=text, media=media, **kw)


# ============================================================ analysis

def count_blocks(blocks):
    """Count blocks the way the 500-limit counts: nested blocks, list
    items, table rows, quotation and details blocks included."""
    total = 0
    for blk in _as_blocks(blocks):
        total += 1
        if not isinstance(blk, dict):
            continue
        if isinstance(blk.get("blocks"), list):
            total += count_blocks(blk["blocks"])
        if isinstance(blk.get("items"), list):
            for item in blk["items"]:
                total += 1  # the list item itself
                if isinstance(item, dict) and isinstance(item.get("blocks"), list):
                    total += count_blocks(item["blocks"])
        cells = blk.get("cells")
        if isinstance(cells, list):
            total += len(cells)  # each table row counts
    return total


def nesting_depth(blocks):
    depth = 0
    for blk in _as_blocks(blocks):
        inner = 0
        if isinstance(blk, dict):
            if isinstance(blk.get("blocks"), list):
                inner = 1 + nesting_depth(blk["blocks"])
            elif isinstance(blk.get("items"), list):
                item_depth = 0
                for item in blk["items"]:
                    if isinstance(item, dict) and isinstance(item.get("blocks"), list):
                        item_depth = max(item_depth, 1 + nesting_depth(item["blocks"]))
                inner = 1 + item_depth
        depth = max(depth, inner)
    return depth


def _rt_plain(rt):
    if rt is None:
        return ""
    if isinstance(rt, str):
        return rt
    if isinstance(rt, list):
        return "".join(_rt_plain(x) for x in rt)
    if isinstance(rt, dict):
        if "text" in rt:
            return _rt_plain(rt["text"])
        if "expression" in rt:
            return rt["expression"]
        return ""
    return str(rt)


def plain_text(content):
    """Best-effort plain-text extraction from blocks (for logs/previews)."""
    out = []
    for blk in _as_blocks(content):
        t = blk.get("type")
        if t in ("paragraph", "heading", "pre", "footer"):
            out.append(_rt_plain(blk.get("text")))
        elif t in ("blockquote", "collage", "slideshow", "details"):
            if t == "details":
                out.append(_rt_plain(blk.get("summary")) + ":")
            out.append(plain_text(blk.get("blocks")))
        elif t == "list":
            for item in blk.get("items", []):
                out.append("• " + plain_text(item.get("blocks")))
        elif t == "table":
            for row in blk.get("cells", []):
                out.append(" | ".join(_rt_plain(c.get("text")) for c in row))
        elif t == "pullquote":
            out.append("«" + _rt_plain(blk.get("text")) + "»")
        elif t == "mathematical_expression":
            out.append(blk.get("expression", ""))
        elif t == "buttons":
            out.append(" ".join(_rt_plain(b.get("text")) for b in blk.get("buttons", [])))
        # dividers, anchors, media blocks -> no text
    return "\n".join(x for x in out if x)


def irm_plain_text(irm):
    """Plain text of any InputRichMessage (markdown/html/blocks)."""
    if "markdown" in irm:
        return strip_markdown(irm["markdown"])
    if "html" in irm:
        return strip_markdown(irm["html"])
    return plain_text(irm.get("blocks", []))


_MD_PATTERNS = None


def strip_markdown(text):
    """Rough markdown -> plain text (only used for summaries/fallbacks)."""
    import re

    global _MD_PATTERNS
    if _MD_PATTERNS is None:
        _MD_PATTERNS = [
            (re.compile(r"```[a-zA-Z0-9+-]*\n?([\s\S]*?)```", re.M), r"\1"),
            (re.compile(r"!\[[^\]]*\]\([^)]*\)"), ""),
            (re.compile(r"\[([^\]]*)\]\([^)]*\)"), r"\1"),
            (re.compile(r"^[>#\-*+]+ ?", re.M), ""),
            (re.compile(r"(\*\*|__|~~|==|\|\||`|!)"), ""),
        ]
    out = text
    for pat, repl in _MD_PATTERNS:
        out = pat.sub(repl, out)
    return out


def check_limits(irm):
    """Validate an InputRichMessage against Bot API limits.

    Returns a list of human-readable problems (empty = OK).  Character
    counts are approximations for markdown/html (server counts the parsed
    text), so a small safety margin is applied.
    """
    problems = []
    if not isinstance(irm, dict):
        return ["rich message must be an object"]
    modes = [m for m in ("blocks", "markdown", "html") if irm.get(m)]
    if len(modes) != 1:
        problems.append("exactly one of blocks/markdown/html is required (got: {})".format(modes))
        return problems
    if irm.get("media") and len(irm["media"]) > MAX_MEDIA:
        problems.append("too many media attachments ({} > {})".format(len(irm["media"]), MAX_MEDIA))
    if "blocks" in irm:
        n = count_blocks(irm["blocks"])
        if n > MAX_BLOCKS:
            problems.append("too many blocks ({} > {})".format(n, MAX_BLOCKS))
        d = nesting_depth(irm["blocks"])
        if d > MAX_NESTING:
            problems.append("nesting too deep ({} > {})".format(d, MAX_NESTING))
        text_len = len(plain_text(irm["blocks"]).encode("utf-8"))
    else:
        text_len = len(irm[modes[0]].encode("utf-8"))
    if text_len > MAX_CHARS:
        problems.append("text too long ({} > {} bytes)".format(text_len, MAX_CHARS))
    return problems
