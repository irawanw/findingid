# AiMin API Reference

## Services & Ports

| Service | Port | Visibility |
|---|---|---|
| vLLM (AI model) | 8001 | internal |
| logic-service.js | 8002 | internal only (127.0.0.1) |
| web/workerServer.js | 3005 | public |
| web/kbFormatterServer.js | 3007 | public |

---

## 1. WebChat API — port 3005

Used by the WebChat frontend widget. Config management proxied from 3060 backend.

### POST /api/chat

Main chat endpoint. Fetches store config by folder, delegates to logic-service.

**Request**
```json
{
  "message":     "halo ada yang bisa dibantu?",   // required — user message text
  "sessionId":   "uuid-or-any-unique-string",     // required — unique per browser session
  "storeFolder": "toko_abc",                       // required — store folder name from DB
  "lang":        "id"                              // optional — "id" or "en" (overrides store default)
}
```

**Response 200**
```json
{
  "messages": [
    { "text": "Halo! Ada yang bisa kami bantu?", "typingDelay": 1200 }
  ],
  "replyText": "Halo! Ada yang bisa kami bantu?",
  "images": ["https://example.com/img1.jpg"],
  "files": [
    { "url": "https://example.com/img1.jpg", "type": "image", "filename": "produk.jpg" }
  ],
  "metadata": {
    "adminNotifications": []
  }
}
```

- `messages` — array of message objects with `text` and `typingDelay` (ms). Frontend should render them sequentially with delay.
- `replyText` — all message texts joined by `\n\n` (backward-compat, single string).
- `images` — image URLs only (backward-compat).
- `files` — all media objects including non-image types.
- `typingDelay` — if message has a delay value, it's a follow-up; browser handles timing.

**Errors**
```json
{ "error": "message, sessionId, and storeFolder are required" }   // 400
{ "error": "Store not found or expired" }                          // 404
{ "error": "Terjadi kesalahan pada AI kami" }                      // 500
```

---

### GET /api/detect-language

Detects language from client IP using GeoIP. Returns `"id"` for Indonesia, `"en"` otherwise. Local/private IPs default to `"id"`.

**Response**
```json
{ "lang": "id", "country": "ID" }
```

---

### POST /config/update

Push full updated store config into logic-service cache. Call this from 3060 whenever a store record is saved. Requires API key header.

**Header:** `x-api-key: aimin_sk_7f8d9e2a1b4c6d8e0f2a4b6c8d0e2f4a`

**Request**
```json
{
  "pelangganId": "628123456789",
  "config": {
    "store_name": "Toko ABC",
    "store_type": "store",
    "store_knowledge_base": "...",
    "store_products": "[...]",
    "store_images": "[...]",
    "store_fulfillment": "[\"pickup\",\"delivery\"]",
    "store_checkout_fields": null,
    "store_bot_always_on": true,
    "store_whatsapp_bot": true,
    "store_language": "id",
    "store_whitelabel": false,
    "store_folder": "toko_abc",
    "store_admin": "Admin Name",
    "store_admin_number": "628111222333"
  }
}
```

- JSON array fields (`store_products`, `store_images`, `store_fulfillment`, `store_checkout_fields`) can be sent as raw JSON strings or parsed arrays — logic-service normalizes both.
- Boolean fields (`store_bot_always_on`, `store_whatsapp_bot`, `store_whitelabel`) accept `1`/`true`/`false`/`0`.

**Response**
```json
{ "ok": true, "pelangganId": "628123456789" }
```

---

### POST /config/invalidate

Drop config cache entry. Logic-service re-fetches from 3060 on next message. Lighter alternative to `/config/update`.

**Header:** `x-api-key: aimin_sk_7f8d9e2a1b4c6d8e0f2a4b6c8d0e2f4a`

**Request**
```json
{ "pelangganId": "628123456789" }
```

**Response**
```json
{ "ok": true, "pelangganId": "628123456789" }
```

---

### GET /api/health

**Response**
```json
{
  "status": "ok",
  "service": "aimin-worker-web",
  "logic_service": "ok"
}
```

---

## 2. Logic Service — port 8002 (internal only, 127.0.0.1)

Never call this from outside the server. Only `transport-wa.js` and `web/workerServer.js` call it.

### POST /process

Main message processing. Config is retrieved from internal cache — do NOT pass config in the body.

**Request**
```json
{
  "text":        "mau pesan nasi goreng",       // required — user message
  "pelangganId": "628123456789",                 // required — store WA JID or bare number
  "sessionKey":  "628123456789_6289876543210@s.whatsapp.net",  // required — unique session identifier
  "custNumber":  "6289876543210",                // optional — customer phone number (bare)
  "jid":         "6289876543210@s.whatsapp.net", // optional — customer WhatsApp JID
  "storeFolder": "toko_abc",                     // optional — for logging
  "channel":     "whatsapp"                      // optional — "whatsapp" (default) or "web"
}
```

Session key format:
- WA: `{pelangganId}_{customerJid}` e.g. `628123456789_6289876543210@s.whatsapp.net`
- Web: `web_{storeFolder}_{sessionId}` e.g. `web_toko_abc_uuid-xxxx`

**Response 200**
```json
{
  "messages": [
    { "text": "Baik, nasi goreng 1 porsi ya!", "typingDelay": 1500 }
  ],
  "images": [
    { "url": "https://example.com/img.jpg", "type": "image", "filename": "nasi_goreng.jpg" }
  ],
  "followup": {
    "shouldSchedule": true,
    "delayMs": 18000,
    "text": "Mau tambah minuman juga kak?"
  },
  "adminNotifications": ["Order baru dari 089..."],
  "paused": false
}
```

- `paused: true` means bot is in human-takeover mode — transport should silently discard.
- `followup` — for WA: schedule a local timer; for web: append to messages with `typingDelay`.

**Errors**
```json
{ "error": "text, pelangganId, and sessionKey are required" }  // 400
{ "error": "Store not found or expired" }                       // 404
{ "error": "..." }                                              // 500
```

---

### POST /config/update

Same as WebChat `/config/update` but called directly (no API key needed — internal only).

**Request**
```json
{
  "pelangganId": "628123456789",
  "config": { ... }
}
```

---

### POST /config/invalidate

Drop cache entry (internal).

**Request**
```json
{ "pelangganId": "628123456789" }
```

---

### GET /store-enabled/:pelangganId

Check if `store_whatsapp_bot` flag is active for a store. Used by `transport-wa.js` polling loop (every 30s).

**Response**
```json
{ "enabled": true }
```

---

### POST /session/pause

Human takeover — silence bot for 10 minutes. Called by `transport-wa.js` when it detects an admin `fromMe` message.

**Request**
```json
{ "sessionKey": "628123456789_6289876543210@s.whatsapp.net" }
```

**Response**
```json
{
  "ok": true,
  "sessionKey": "628123456789_6289876543210@s.whatsapp.net",
  "pausedMs": 600000,
  "wasAlreadyPaused": false
}
```

---

### POST /session/resume

Manually resume a paused (taken-over) session before the 10-minute timeout.

**Request**
```json
{ "sessionKey": "628123456789_6289876543210@s.whatsapp.net" }
```

**Response**
```json
{ "ok": true, "sessionKey": "628123456789_6289876543210@s.whatsapp.net" }
```

---

### POST /cancel-followup

Cancel any pending follow-up timer state in logic-service for a session.

**Request**
```json
{ "sessionKey": "628123456789_6289876543210@s.whatsapp.net" }
```

**Response**
```json
{ "ok": true }
```

---

### GET /health

**Response**
```json
{
  "status": "ok",
  "service": "aimin-logic",
  "pid": 12345,
  "uptime": 3600,
  "config_cached": 5,
  "paused_sessions": 1
}
```

---

## 3. KB Formatter — port 3007

AI-powered document processing service. Converts DOCX/PDF into clean knowledge base text, extracts products, and provides a generic LLM proxy.

### POST /format

Upload a DOCX or PDF file. Extracts text page-by-page with a Python script, then uses the LLM to clean and structure each page into chapters.

**Request** — `multipart/form-data`
- Field `file`: `.docx` or `.pdf` file (max 50MB)

```bash
curl -X POST http://localhost:3007/format \
  -F "file=@company_profile.docx"
```

**Response**
```json
{
  "chapters": [
    { "title": "Paket Wisata Bali 3H2M", "content": "Paket Bali 3H2M meliputi...\nHarga: Rp1.200.000/orang" }
  ],
  "formatted_text": "## Paket Wisata Bali 3H2M\n\nPaket Bali 3H2M meliputi...",
  "pages_count": 12,
  "chapters_count": 10,
  "raw_length": 18500,
  "formatted_length": 9200
}
```

---

### POST /format-text

Format plain text directly (no file upload). Splits into 3000-char chunks and processes each through the LLM.

**Request** — `application/json`
```json
{ "text": "Nama Toko: Warung Sate Pak Ali\nMenu:\n- Sate Ayam Rp25.000\n- Sate Kambing Rp35.000" }
```

**Response** — same structure as `/format`.

---

### POST /parse-products

Extract a structured product/service list from KB text. Returns `store_products` JSON format.

**Request** — `application/json`
```json
{ "text": "Menu kami:\n- Nasi Goreng Rp25.000\n- Mie Goreng Rp22.000\n- Es Teh Rp5.000-Rp8.000" }
```

**Response**
```json
{
  "products": [
    {
      "name": "Nasi Goreng",
      "price_min": 25000,
      "price_max": 25000,
      "unit": "porsi",
      "variations": {},
      "folder": "nasi_goreng"
    },
    {
      "name": "Es Teh",
      "price_min": 5000,
      "price_max": 8000,
      "unit": "gelas",
      "variations": {},
      "folder": "es_teh"
    }
  ],
  "count": 2
}
```

---

### POST /chat

Generic LLM proxy. Sends a prompt to the configured model and returns the response.

**Request** — `application/json`
```json
{
  "prompt":      "Tulis deskripsi singkat untuk toko saya",  // required
  "system":      "Kamu adalah copywriter profesional",       // optional
  "max_tokens":  2048,                                       // optional, default 2048
  "temperature": 0.1                                         // optional, default 0.1
}
```

**Response**
```json
{ "text": "Toko kami menawarkan produk berkualitas tinggi..." }
```

---

### GET /chat/stream  &  POST /chat/stream

SSE streaming version of `/chat`. Streams tokens as they're generated. `<think>` blocks are filtered out in real-time.

**GET** — params via query string:
```
GET /chat/stream?prompt=Tulis+deskripsi&system=Kamu+copywriter&max_tokens=1024
```

**POST** — params via JSON body (same fields as `/chat`).

**Response** — `text/event-stream`
```
data: {"text":"Toko"}
data: {"text":" kami"}
data: {"text":" menawarkan"}
...
data: [DONE]
```

On error:
```
data: {"error":"vLLM unreachable"}
data: [DONE]
```

---

### GET /health

```json
{
  "status": "ok",
  "port": 3007,
  "llm": "http://127.0.0.1:8001/v1/chat/completions",
  "model": "/data/www/llm/.hf_home/hub/models--Qwen--Qwen3-14B-AWQ/snapshots/31c69efc..."
}
```

---

## Quick Reference — curl examples

```bash
# Chat (WebChat)
curl -X POST http://localhost:3005/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message":"halo","sessionId":"abc123","storeFolder":"toko_abc"}'

# Push config update (from 3060)
curl -X POST http://localhost:3005/config/update \
  -H "Content-Type: application/json" \
  -H "x-api-key: aimin_sk_7f8d9e2a1b4c6d8e0f2a4b6c8d0e2f4a" \
  -d '{"pelangganId":"628123456789","config":{...}}'

# Pause bot (human takeover)
curl -X POST http://localhost:8002/session/pause \
  -H "Content-Type: application/json" \
  -d '{"sessionKey":"628123456789_6289876543210@s.whatsapp.net"}'

# Resume bot
curl -X POST http://localhost:8002/session/resume \
  -H "Content-Type: application/json" \
  -d '{"sessionKey":"628123456789_6289876543210@s.whatsapp.net"}'

# Format DOCX
curl -X POST http://localhost:3007/format \
  -F "file=@document.docx"

# Parse products from KB text
curl -X POST http://localhost:3007/parse-products \
  -H "Content-Type: application/json" \
  -d '{"text":"Nasi Goreng Rp25.000, Mie Goreng Rp22.000"}'

# Health checks
curl http://localhost:3005/api/health
curl http://localhost:8002/health
curl http://localhost:3007/health
```
