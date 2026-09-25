/**
 * src/watermark.js — optional photo watermarking (Posto-style ©️ feature).
 *
 * Real pixel watermarking needs an image library.  Sharp is the fast,
 * prebuilt one for Node — install it only if you want the feature:
 *
 *     npm install sharp
 *
 * Without sharp the bot degrades gracefully: the watermark text becomes a
 * TEXT signature appended under the post (no crash, no mandatory dependency).
 */

import { logger } from './logger.js';

const log = logger('watermark');

let sharpModule = null;
let probed = false;

async function loadSharp() {
  if (probed) return sharpModule;
  probed = true;
  try {
    const mod = await import('sharp');
    sharpModule = mod.default || mod;
    log.info('sharp detected — real photo watermarks are available');
  } catch {
    sharpModule = null;
  }
  return sharpModule;
}

/** True when real photo watermarking is possible on this host. */
export async function available() {
  return Boolean(await loadSharp());
}

/** Synchronous best-effort check (for panels/status text). */
export function availableSync() {
  return Boolean(sharpModule);
}

function escapeXml(text) {
  return String(text).replace(/[<>&'"]/g, (c) => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;',
  }[c]));
}

/**
 * Return watermarked JPEG bytes for a photo, or null on any failure.
 * `text` is drawn bottom-right on a translucent plate, like the Python build.
 */
export async function watermarkBytes(blob, text, opacity = 0.67) {
  if (!text) return null;
  const sharp = await loadSharp();
  if (!sharp) return null;
  try {
    const image = sharp(blob, { failOn: 'none' });
    const meta = await image.metadata();
    const width = meta.width || 1024;
    const height = meta.height || 1024;
    const fontSize = Math.max(14, Math.round(Math.min(width, height) * 0.045));
    const pad = Math.max(6, Math.round(fontSize / 3));
    const label = escapeXml(text);
    const plate = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <g font-family="DejaVu Sans, Arial, Helvetica, sans-serif" font-size="${fontSize}"
         font-weight="bold" fill="rgba(255,255,255,${opacity})">
        <text x="${width - pad}" y="${height - pad}"
              text-anchor="end" dominant-baseline="text-after-edge"
              stroke="rgba(0,0,0,0.55)" stroke-width="${Math.max(1, pad / 2)}"
              paint-order="stroke">${label}</text>
      </g>
    </svg>`;
    return await image
      .composite([{ input: Buffer.from(plate), top: 0, left: 0 }])
      .jpeg({ quality: 90 })
      .toBuffer();
  } catch (err) {
    log.warn(`watermark failed: ${err?.message || err}`);
    return null;
  }
}
