"""apb.watermark — optional photo watermarking (Posto-style).

True watermarking needs image processing, so this module uses Pillow
**if the user installed it** (``pip install Pillow``).  Without Pillow the
bot degrades gracefully to a text *signature* appended under the post —
no crash, no mandatory dependency.
"""

from __future__ import annotations

import io
import logging

log = logging.getLogger(__name__)

try:
    from PIL import Image, ImageDraw, ImageFont  # type: ignore
    _PIL = True
except ImportError:  # pragma: no cover - depends on host
    _PIL = False


def available():
    return _PIL


def watermark_bytes(blob, text, opacity=170):
    """Return watermarked JPEG bytes for a photo blob, or None on failure."""
    if not _PIL or not text:
        return None
    try:
        img = Image.open(io.BytesIO(blob)).convert("RGBA")
        width, height = img.size
        font_size = max(14, int(min(width, height) * 0.045))
        try:
            font = ImageFont.truetype(
                "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", font_size)
        except OSError:
            font = ImageFont.load_default()
        overlay = Image.new("RGBA", img.size, (0, 0, 0, 0))
        draw = ImageDraw.Draw(overlay)
        try:
            bbox = draw.textbbox((0, 0), text, font=font)
            tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
        except AttributeError:  # very old Pillow
            tw, th = draw.textsize(text, font=font)
        pad = max(6, font_size // 3)
        x, y = width - tw - 3 * pad, height - th - 3 * pad
        draw.rectangle([x - pad, y - pad, x + tw + pad, y + th + pad],
                       fill=(0, 0, 0, int(opacity * 0.55)))
        draw.text((x, y), text, font=font, fill=(255, 255, 255, opacity))
        out = Image.alpha_composite(img, overlay).convert("RGB")
        buf = io.BytesIO()
        out.save(buf, format="JPEG", quality=90)
        return buf.getvalue()
    except Exception as exc:
        log.warning("watermark failed: %s", exc)
        return None
