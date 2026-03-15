'use strict';
const cfg = require('../config/config');

// ================================================================
// vLLM Client — OpenAI-compatible API at 127.0.0.1:8001/v1 (llama.cpp)
//
// Streaming:  POST /v1/chat/completions  stream:true
//             SSE: data: {"choices":[{"delta":{"content":"token"}}]}
// Sync:       POST /v1/chat/completions  stream:false
//             Response: { choices:[{ message:{ content:"..." } }] }
//
// Circuit breaker: CLOSED → OPEN → HALF_OPEN
// ================================================================

// ── Circuit Breaker ───────────────────────────────────────────
const CB = {
  failures:     0,
  threshold:    3,
  resetAfterMs: 20000,
  openedAt:     null,
  state:        'CLOSED',
};

function withTimeout(ms, promise, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms)
    ),
  ]);
}

function cbCheck() {
  if (CB.state === 'CLOSED')   return true;
  if (CB.state === 'OPEN') {
    if (Date.now() - CB.openedAt > CB.resetAfterMs) {
      CB.state = 'HALF_OPEN';
      console.log('[vllm] circuit HALF_OPEN — probing');
      return true;
    }
    return false;
  }
  return true; // HALF_OPEN: allow probe
}

function cbSuccess() { CB.failures = 0; CB.state = 'CLOSED'; }
function cbFailure() {
  CB.failures++;
  if (CB.failures >= CB.threshold) {
    CB.state    = 'OPEN';
    CB.openedAt = Date.now();
    console.warn(`[vllm] circuit OPEN after ${CB.failures} failures`);
  }
}

// ── Think-block filter (state machine) ───────────────────────
// Tracks <think>...</think> across chunks and suppresses those tokens.
// With /no_think the block is nearly empty, but we still filter it.
class ThinkFilter {
  constructor() {
    this.inside = false;
    this.buf    = '';   // partial tag accumulation
  }

  // Returns the portion of `chunk` that should be emitted to the client.
  process(chunk) {
    let out = '';
    for (const ch of chunk) {
      if (this.inside) {
        // Looking for </think>
        this.buf += ch;
        if ('</think>'.startsWith(this.buf)) {
          if (this.buf === '</think>') { this.inside = false; this.buf = ''; }
        } else {
          this.buf = '';
        }
      } else {
        // Looking for <think>
        this.buf += ch;
        if ('<think>'.startsWith(this.buf)) {
          if (this.buf === '<think>') { this.inside = true; this.buf = ''; }
        } else {
          // buf didn't match — flush buffered chars as real output
          out += this.buf;
          this.buf = '';
        }
      }
    }
    // If we have a partial non-think buffer, hold it (might complete a tag)
    // Only flush partial buffer if we're not inside a tag candidate
    if (!this.inside && this.buf && !'<think>'.startsWith(this.buf)) {
      out += this.buf;
      this.buf = '';
    }
    return out;
  }

  // Flush anything remaining in the buffer
  flush() {
    const out = this.inside ? '' : this.buf;
    this.buf = '';
    return out;
  }
}

/**
 * Stream tokens from vLLM to `onToken` as they arrive.
 * Returns the full assembled text (think blocks stripped).
 *
 * @param {object[]} messages  [{role:'system',...},{role:'user',...}]
 * @param {function} onToken   Called with each string chunk
 * @param {AbortSignal} signal Cancellation
 * @returns {Promise<string>}  Full text (no think blocks)
 */
async function generateStream(messages, onToken, signal) {
  if (!cbCheck()) {
    const fallback = 'Layanan AI sementara tidak tersedia. Silakan coba lagi dalam beberapa saat.';
    onToken(fallback);
    return fallback;
  }

  const controller = new AbortController();
  signal?.addEventListener('abort', () => controller.abort(), { once: true });

  let fullText = '';
  const filter = new ThinkFilter();

  try {
    const res = await withTimeout(30_000, fetch(`${cfg.VLLM.BASE_URL}/chat/completions`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        model:       cfg.VLLM.MODEL,
        messages,
        max_tokens:  cfg.VLLM.MAX_TOKENS,
        temperature: cfg.VLLM.TEMPERATURE,
        stream:      true,
        chat_template_kwargs: { enable_thinking: false },
      }),
      signal: controller.signal,
    }), 'vLLM stream');

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`vLLM stream error ${res.status}: ${errText.slice(0, 100)}`);
    }

    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let lineBuf   = '';

    while (true) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;

      lineBuf += decoder.decode(value, { stream: true });
      const lines = lineBuf.split('\n');
      lineBuf = lines.pop();

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6).trim();
        if (raw === '[DONE]') break;

        let chunk;
        try { chunk = JSON.parse(raw); } catch { continue; }

        const content = chunk.choices?.[0]?.delta?.content;
        if (!content) continue;

        const visible = filter.process(content);
        if (visible) {
          fullText += visible;
          onToken(visible);
        }
      }
    }

    const tail = filter.flush();
    if (tail) { fullText += tail; onToken(tail); }

    cbSuccess();
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    cbFailure();
    throw err;
  }

  return fullText.trim();
}

/**
 * Collect full LLM response without a streaming callback.
 * Internally uses generateStream for faster first-byte from vLLM.
 */
async function generate(messages, signal) {
  if (!cbCheck()) {
    return 'Layanan AI sementara tidak tersedia. Silakan coba lagi dalam beberapa saat.';
  }
  try {
    return await generateStream(messages, () => {}, signal);
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw err;
  }
}

/**
 * One-shot non-streaming call (for utility/short prompts).
 */
async function complete(system, prompt, maxTokens = 256) {
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: prompt });

  const res = await withTimeout(
    15_000,
    fetch(`${cfg.VLLM.BASE_URL}/chat/completions`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model:       cfg.VLLM.MODEL,
        messages,
        max_tokens:  maxTokens,
        temperature: 0.1,
        stream:      false,
        chat_template_kwargs: { enable_thinking: false },
      }),
    }),
    'vLLM complete'
  );
  if (!res.ok) throw new Error(`vLLM complete error ${res.status}`);
  const data = await res.json();
  return (data.choices?.[0]?.message?.content || '')
    .replace(/<think>[\s\S]*?<\/think>\s*/gi, '')
    .replace(/<think>[\s\S]*/gi, '')
    .trim();
}

/**
 * Legacy streaming via callback (kept for compatibility).
 * Now delegates to generateStream.
 */
async function streamChat(messages, onToken, signal) {
  return generateStream(messages, onToken, signal);
}

module.exports = { streamChat, generateStream, generate, complete, CB };
