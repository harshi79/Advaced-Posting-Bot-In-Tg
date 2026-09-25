"""apb.utils — small parsing helpers (no dependencies)."""

from __future__ import annotations

import datetime
import re

from .rich import INLINE_STYLES

_MONTHS = ("jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec")


def parse_when(text, now=None):
    """Parse a human schedule time into a UNIX timestamp.

    Supported formats (local time):
      ``+30m``  ``+2h``  ``+1d12h``  ``+90`` (minutes)
      ``2026-10-01 10:00``  ``2026-10-01T10:00``
      ``10:00`` / ``10:00:30`` (today, or tomorrow if already past)
      ``tomorrow`` / ``tomorrow 09:30``

    Returns float epoch seconds, or None if unparseable / in the past.
    """
    s = (text or "").strip().lower()
    if not s:
        return None
    now = now or datetime.datetime.now()

    m = re.fullmatch(r"\+\s*(\d+)\s*(m|h|d)?", s)
    if m:
        n, unit = int(m.group(1)), (m.group(2) or "m")
        delta = n * {"m": 60, "h": 3600, "d": 86400}[unit]
        return (now + datetime.timedelta(seconds=delta)).timestamp()

    m = re.fullmatch(r"\+\s*(?:(\d+)\s*d)?\s*(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?", s)
    if m and any(m.groups()):
        d, h, mi = (int(x) if x else 0 for x in m.groups())
        return (now + datetime.timedelta(days=d, hours=h, minutes=mi)).timestamp()

    m = re.fullmatch(r"(\d{1,2}):(\d{2})(?::(\d{2}))?", s)
    if m:
        h, mi, se = int(m.group(1)), int(m.group(2)), int(m.group(3) or 0)
        when = now.replace(hour=h, minute=mi, second=se, microsecond=0)
        if when <= now:
            when += datetime.timedelta(days=1)
        return when.timestamp()

    m = re.fullmatch(r"(?:tomorrow|tmr)", s)
    if m:
        return (now + datetime.timedelta(days=1)).replace(
            hour=9, minute=0, second=0, microsecond=0).timestamp()

    m = re.fullmatch(r"(?:tomorrow|tmr)\s+(\d{1,2}):(\d{2})", s)
    if m:
        when = (now + datetime.timedelta(days=1)).replace(
            hour=int(m.group(1)), minute=int(m.group(2)), second=0, microsecond=0)
        return when.timestamp()

    m = re.fullmatch(r"(\d{4})-(\d{1,2})-(\d{1,2})[ t](\d{1,2}):(\d{2})(?::(\d{2}))?", s)
    if m:
        y, mo, d, h, mi, se = (int(x) if x else 0 for x in m.groups())
        try:
            when = datetime.datetime(y, mo, d, h, mi, se)
        except ValueError:
            return None
        if when <= now:
            return None
        return when.timestamp()

    return None


def fmt_when(epoch):
    return datetime.datetime.fromtimestamp(epoch).strftime("%a %d %b %Y, %H:%M")


def parse_interval(text):
    """Parse a repeat/spacing interval into seconds.

    Accepts ``6h``, ``every 6h``, ``90m``, ``2d``, ``30s``, ``45`` (minutes).
    Returns int seconds or None.
    """
    s = (text or "").strip().lower().removeprefix("every").strip()
    if s.isdigit():                       # bare number = minutes
        total = int(s) * 60
        return total if total >= 60 else None
    m = re.fullmatch(r"(?:(\d+)\s*d)?\s*(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+)\s*s)?", s)
    if m and any(m.groups()):
        d, h, mi, se = (int(x) if x else 0 for x in m.groups())
        total = d * 86400 + h * 3600 + mi * 60 + se
        return total if total >= 60 else None  # one minute minimum
    return None


def parse_button_rows(text):
    """Parse the /buttons mini-language into reply-markup rows.

    Each non-empty line is ONE row.  Buttons on the same row are separated
    by ``;;``.  Each button::

        Label | https://example.com | primary
        Label | cb:callback_data    | danger

    Style is optional ("primary" blue, "success" green, "danger" red).
    Returns (rows, errors) — rows is a list of lists of button dicts.
    """
    rows, errors = [], []
    for line_no, line in enumerate((text or "").splitlines(), 1):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        row = []
        for part in line.split(";;"):
            part = part.strip()
            if not part:
                continue
            segs = [seg.strip() for seg in part.split("|")]
            if len(segs) < 2:
                errors.append("line {}: use `Label | url-or-cb:data | color` — got {!r}".format(
                    line_no, part))
                continue
            label, action = segs[0], segs[1]
            style = segs[2] if len(segs) > 2 else None
            if style and style not in INLINE_STYLES:
                errors.append("line {}: style must be one of {} (got {!r})".format(
                    line_no, "/".join(INLINE_STYLES), style))
                style = None
            if not label:
                errors.append("line {}: empty button label".format(line_no))
                continue
            btn = {"text": label[:64]}
            if action.startswith("cb:"):
                data = action[3:]
                if not 1 <= len(data.encode()) <= 64:
                    errors.append("line {}: callback_data must be 1-64 bytes".format(line_no))
                    continue
                btn["callback_data"] = data
            elif action.startswith("http://") or action.startswith("https://"):
                btn["url"] = action
            else:
                errors.append("line {}: action must be a https:// URL or cb:data — got {!r}".format(
                    line_no, action))
                continue
            if style:
                btn["style"] = style
            row.append(btn)
        if row:
            rows.append(row)
    return rows, errors


def kb(rows):
    """Build an InlineKeyboardMarkup from rows of button dicts."""
    return {"inline_keyboard": rows}
