"""apb.mdblocks — a small Markdown -> InputRichBlock converter.

Used when a post must be sent in *blocks* mode (e.g. slideshows built from
uploaded albums, where photos are embedded by file_id directly in
``InputRichBlockPhoto`` objects instead of ``tg://photo?id=`` references).

Supported (a pragmatic subset of Rich Markdown):
  # .. ###### headings        > blockquote lines
  - / * bullet lists          1. ordered lists
  ``` fenced code blocks ```  --- divider
  **bold** *italic* `code` ==marked== ||spoiler||
  [text](url) ![alt](url)
Everything else becomes a paragraph.
"""

from __future__ import annotations

import re

from . import rich as R

_INLINE = [
    ("code", re.compile(r"`([^`\n]+)`")),
    ("bold", re.compile(r"\*\*([^*\n]+)\*\*")),
    ("italic", re.compile(r"(?<!\*)\*([^*\n]+)\*(?!\*)")),
    ("marked", re.compile(r"==([^=\n]+)==")),
    ("spoiler", re.compile(r"\|\|([^|\n]+)\|\|")),
    ("url", re.compile(r"\[([^\]\n]+)\]\((https?://[^)\s]+)\)")),
]

_IMG = re.compile(r"!\[[^\]]*\]\(([^)\s]+)\)")


def _inline(text):
    """Convert one line of inline markdown into a RichText value."""
    # images inside text are dropped in blocks mode (media handled separately)
    for pat, repl in ((re.compile(r"!\[[^\]]*\]\([^)]*\)"), ""),
                      (re.compile(r"\[([^\]]+)\]\(([^)]+)\)"), r"\1")):
        pass  # links handled by _INLINE; images removed below
    text = _IMG.sub("", text)
    if not text:
        return ""
    out = []
    pos = 0
    tokens = []  # (start, end, kind, payload)
    for kind, pattern in _INLINE:
        for m in pattern.finditer(text):
            tokens.append((m.start(), m.end(), kind, m.groups()))
    tokens.sort(key=lambda t: t[0])
    last = 0
    for start, end, kind, groups in tokens:
        if start < last:      # overlapping — skip
            continue
        if start > last:
            out.append(text[last:start])
        if kind == "code":
            out.append(R.code(groups[0]))
        elif kind == "bold":
            out.append(R.bold(groups[0]))
        elif kind == "italic":
            out.append(R.italic(groups[0]))
        elif kind == "marked":
            out.append(R.marked(groups[0]))
        elif kind == "spoiler":
            out.append(R.spoiler(groups[0]))
        elif kind == "url":
            out.append(R.link(groups[0], groups[1]))
        last = end
    if last < len(text):
        out.append(text[last:])
    if not out:
        return ""
    if len(out) == 1 and isinstance(out[0], str):
        return out[0]
    return out


def md_to_blocks(markdown):
    """Convert Rich Markdown text into a list of InputRichBlock dicts."""
    blocks = []
    lines = (markdown or "").replace("\r\n", "\n").split("\n")
    i = 0
    paragraph = []

    def flush_paragraph():
        if paragraph:
            text = " ".join(p for p in paragraph if p)
            if text.strip():
                blocks.append(R.paragraph(_inline(text)))
            paragraph.clear()

    while i < len(lines):
        line = lines[i]
        stripped = line.strip()

        if not stripped:
            flush_paragraph()
            i += 1
            continue

        if stripped.startswith("```"):
            flush_paragraph()
            code_lines = []
            i += 1
            language = stripped[3:].strip() or None
            while i < len(lines) and not lines[i].strip().startswith("```"):
                code_lines.append(lines[i])
                i += 1
            i += 1  # closing fence
            blocks.append(R.pre("\n".join(code_lines), language))
            continue

        m = re.match(r"^(#{1,6})\s+(.*)$", stripped)
        if m:
            flush_paragraph()
            blocks.append(R.heading(_inline(m.group(2)), len(m.group(1))))
            i += 1
            continue

        if re.match(r"^(-{3,}|\*{3,}|_{3,})$", stripped):
            flush_paragraph()
            blocks.append(R.divider())
            i += 1
            continue

        if stripped.startswith(">"):
            flush_paragraph()
            quote = []
            while i < len(lines) and lines[i].strip().startswith(">"):
                quote.append(lines[i].strip().lstrip(">").strip())
                i += 1
            blocks.append(R.blockquote(
                [R.paragraph(_inline(" ".join(q for q in quote if q)))] if quote else []))
            continue

        m = re.match(r"^[-*+]\s+(.*)$", stripped)
        if m:
            flush_paragraph()
            items = []
            while i < len(lines):
                mm = re.match(r"^[-*+]\s+(.*)$", lines[i].strip())
                if not mm:
                    break
                item_text = mm.group(1)
                checked = None
                cm = re.match(r"^\[([ xX])\]\s+(.*)$", item_text)
                if cm:
                    checked = cm.group(1).lower() == "x"
                    item_text = cm.group(2)
                items.append(R.list_item(_inline(item_text), checkbox=checked is not None,
                                         checked=bool(checked)))
                i += 1
            blocks.append(R.bullet_list(items))
            continue

        m = re.match(r"^(\d+)[.)]\s+(.*)$", stripped)
        if m:
            flush_paragraph()
            items = []
            while i < len(lines):
                mm = re.match(r"^(\d+)[.)]\s+(.*)$", lines[i].strip())
                if not mm:
                    break
                items.append(R.list_item(_inline(mm.group(2))))
                i += 1
            blocks.append(R.ordered_list(items))
            continue

        # table row?
        if stripped.startswith("|") and stripped.endswith("|") and i + 1 < len(lines) \
                and re.match(r"^\|?[\s:|-]+\|?$", lines[i + 1].strip()):
            flush_paragraph()
            rows = []

            def split_row(row):
                cells = [c.strip() for c in row.strip().strip("|").split("|")]
                return cells

            header = split_row(lines[i])
            sep = split_row(lines[i + 1].strip())
            i += 2  # skip separator
            aligns = []
            for idx in range(len(header)):
                cell = sep[idx] if idx < len(sep) else ""
                if cell.startswith(":") and cell.endswith(":"):
                    aligns.append("center")
                elif cell.endswith(":"):
                    aligns.append("right")
                else:
                    aligns.append("left")
            body = [header]
            while i < len(lines) and lines[i].strip().startswith("|"):
                body.append(split_row(lines[i].strip()))
                i += 1
            blocks.append(R.table(body, header=True, aligns=aligns))
            continue

        paragraph.append(stripped)
        i += 1

    flush_paragraph()
    return blocks
