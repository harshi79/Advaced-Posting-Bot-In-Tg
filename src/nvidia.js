/**
 * src/nvidia.js — AI helpers powered by NVIDIA NIM (build.nvidia.com).
 *
 *   * free FOREVER — no credit card, no expiring credits, ~40 requests/min
 *   * OpenAI-compatible Chat Completions at https://integrate.api.nvidia.com/v1
 *   * hosts NVIDIA's own open models
 *
 * The one model this bot uses by default:
 *   nvidia/nemotron-3-super-120b-a12b  (override with APB_AI_MODEL)
 *
 * Get a key: https://build.nvidia.com → sign in → API keys → generate
 * (`nvapi-…`) → set APB_NVIDIA_KEY.  Only NVIDIA is used: no paid providers.
 */

import { logger } from './logger.js';

const log = logger('nvidia');

export const BASE_URL = 'https://integrate.api.nvidia.com/v1';
export const DEFAULT_MODEL = 'nvidia/nemotron-3-super-120b-a12b';

export const SYSTEM_PROMPT = 'You are the in-house copywriter of a Telegram channel. '
  + 'You write posts in Telegram Rich Markdown: GitHub-Flavored Markdown (headings, '
  + '**bold**, *italic*, tables, `- [ ]` task lists, fenced code, footnotes) plus '
  + 'Telegram extras like ==marked text== and ||hidden spoilers||.\n'
  + 'Rules: output ONLY the post itself — no explanations, no surrounding code fence, '
  + "no 'Here is your post'. Keep it punchy and scannable. Use at most one H1-style "
  + 'heading, short paragraphs, and emoji where it helps. Answer in the language of '
  + 'the request.';

export class AIError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AIError';
  }
}

export class NVIDIA {
  constructor(apiKey = null, { model = null, timeout = 90 } = {}) {
    this.apiKey = apiKey || '';
    this.model = model || process.env.APB_AI_MODEL || DEFAULT_MODEL;
    this.timeout = timeout;
  }

  get enabled() {
    return Boolean(this.apiKey);
  }

  statusLine() {
    if (!this.enabled) {
      return '🤖 AI: off — set APB_NVIDIA_KEY (free key from build.nvidia.com, no card needed)';
    }
    return `🤖 AI: ${this.model} @ NVIDIA NIM (free tier)`;
  }

  async #post(payload, { stream = false } = {}) {
    if (!this.enabled) throw new AIError('no NVIDIA API key — get a free one at build.nvidia.com');
    let res;
    try {
      const signal = (typeof AbortSignal !== 'undefined' && AbortSignal.timeout)
        ? AbortSignal.timeout(this.timeout * 1000)
        : undefined;
      res = await fetch(`${BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
          accept: stream ? 'text/event-stream' : 'application/json',
        },
        body: JSON.stringify(payload),
        signal,
      });
    } catch (err) {
      throw new AIError(`cannot reach NVIDIA NIM: ${err?.message || err}`);
    }
    if (!res.ok) {
      const raw = await res.text().catch(() => '');
      let detail = raw.slice(0, 300);
      try {
        const parsed = JSON.parse(raw);
        detail = parsed.message || parsed.detail || parsed.title || detail;
      } catch { /* keep raw */ }
      if (res.status === 401) throw new AIError('NVIDIA key rejected (401) — check APB_NVIDIA_KEY');
      if (res.status === 404 && String(detail).toLowerCase().includes('model')) {
        throw new AIError(`model not available on your NIM account: ${this.model} — try APB_AI_MODEL`);
      }
      if (res.status === 429) throw new AIError('NVIDIA free tier rate limit (40 RPM) — retry in a few seconds');
      throw new AIError(`NVIDIA API error ${res.status}: ${detail}`);
    }
    return res;
  }

  /** Blocking completion → plain text. */
  async complete(userPrompt, { system = null, maxTokens = 2048, temperature = 0.7 } = {}) {
    const res = await this.#post({
      model: this.model,
      messages: [
        { role: 'system', content: system || SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: maxTokens,
      temperature,
      stream: false,
    });
    const data = await res.json().catch(() => null);
    const text = data?.choices?.[0]?.message?.content;
    if (typeof text !== 'string') {
      throw new AIError(`unexpected NVIDIA response: ${JSON.stringify(data).slice(0, 300)}`);
    }
    return text.trim();
  }

  /** Async generator of text chunks as they arrive (SSE, zero deps). */
  async *stream(userPrompt, { system = null, maxTokens = 2048, temperature = 0.7 } = {}) {
    const res = await this.#post({
      model: this.model,
      messages: [
        { role: 'system', content: system || SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: maxTokens,
      temperature,
      stream: true,
    }, { stream: true });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx = buf.indexOf('\n');
        while (idx >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          idx = buf.indexOf('\n');
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') return;
          try {
            const obj = JSON.parse(data);
            const delta = obj?.choices?.[0]?.delta?.content;
            if (delta) yield delta;
          } catch { /* ignore partial frames */ }
        }
      }
    } finally {
      try { reader.releaseLock(); } catch { /* ignore */ }
    }
  }

  // ----------------------------------------------------------- post skills

  writePost(prompt, { tone = null, language = null } = {}) {
    let ask = `Write a Telegram channel post about: ${prompt}`;
    if (tone) ask += `\nTone: ${tone}`;
    if (language) ask += `\nLanguage: ${language}`;
    return ask;
  }

  rewritePost(text, instruction = 'make it punchier, keep the meaning') {
    return `Rewrite the following Telegram post. Instruction: ${instruction}.\n\nPost:\n${text}`;
  }

  translatePost(text, language) {
    return `Translate this Telegram post into ${language}. Keep the Rich Markdown formatting and emoji.\n\nPost:\n${text}`;
  }

  shortenPost(text) {
    return `Shorten this Telegram post to roughly half its length while keeping all key facts and the formatting.\n\nPost:\n${text}`;
  }

  expandPost(text) {
    return `Expand this Telegram post with a bit more detail and one extra section. Keep the Rich Markdown style.\n\nPost:\n${text}`;
  }
}

export default NVIDIA;
export { log };
