# Ezkielyna MCP

<!-- ezk:badges -->
[![npm](https://img.shields.io/npm/v/ezkielyna-mcp?color=c2410c)](https://www.npmjs.com/package/ezkielyna-mcp) [![CI](https://github.com/EzkielynaGroup/ezkielyna-mcp/actions/workflows/test.yml/badge.svg)](https://github.com/EzkielynaGroup/ezkielyna-mcp/actions/workflows/test.yml) [![MCP Registry](https://img.shields.io/badge/MCP_Registry-io.github.EzkielynaGroup%2Fezkielyna--mcp-1f6feb)](https://registry.modelcontextprotocol.io/v0/servers?search=io.github.EzkielynaGroup/ezkielyna-mcp) [![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
<!-- /ezk:badges -->

An [MCP](https://modelcontextprotocol.io) server that lets your AI assistant **ask other AI models for a second opinion**, compare 2-4 answers side by side, search the web and check your balance, all through the [Ezkielyna API](https://ezkielyna.store/?utm_source=github&utm_medium=readme&utm_campaign=ezkielyna-mcp). Works in Claude Code, Claude Desktop, Cursor, OpenCode and any other MCP client that runs local stdio servers.

Example (in Claude Code): *"Ask deepseek-v4.1-flash and glm-5.3 to review the SQL in `db/report.sql` for injection risks, then tell me where they disagree."*

> 🇮🇩 Bahasa Indonesia: lihat [bagian di bawah](#bahasa-indonesia).

- **One file, no dependencies**: only Node.js 18 or newer. No `npm install`.
- Answers come back with tokens used, latency and an estimated cost at list price.
- Paid calls are capped per session, `max_tokens` is capped, and the API key is never printed.

## Requirements

1. **Node.js 18+** (`node -v`). Get the LTS from [nodejs.org](https://nodejs.org).
2. An **Ezkielyna API key** in group **Standard** (DeepSeek, GLM, Kimi, MiniMax, Qwen and other text models) or **Auto** (also Claude, GPT and Grok at the Premium 1.5x multiplier). Buy API Credit at [ezkielyna.store/beli-api-key](https://ezkielyna.store/beli-api-key?utm_source=github&utm_medium=readme&utm_campaign=ezkielyna-mcp) (from $0.5, QRIS/DANA/GoPay/USDT), redeem it under **Wallet** at [api.ezkielyna.store](https://api.ezkielyna.store), then create a key under **API Keys**.
3. `list_models` works without a key (it shows the public price list), so you can look before you buy.

## Tools

| Tool | What it does | Cost |
|---|---|---|
| `ask_model` | Sends a prompt (optional `system`) to one model. `model` default `deepseek-v4.1-flash`, `max_tokens` default 1024 (cap 4096), optional `temperature`. Returns the answer, tokens, latency and estimated cost. | paid, 1 call |
| `compare_models` | Same prompt to 2-4 `models` **in parallel**; answers side by side with tokens, latency and cost each. A failing model is reported without hiding the others. | paid, 1 call per model |
| `list_models` | Models your key can use (`GET /v1/models`) joined with public prices (USD per 1M tokens, or per call). Optional `filter`, e.g. `deepseek`, `claude`, `tts`. | free |
| `web_search` | Web search through `POST /v1/search`: `query`, `max_results` 1-10 (default 5), optional `time_range` (day/week/month/year) and `language`. | counts toward the cap |
| `check_balance` | Credit limit, usage and remaining balance reported by the OpenAI-compatible billing endpoints, plus calls left this session. If the endpoint answers in an unexpected shape, it points you to the dashboard instead of guessing. | free |

The other models **cannot see your conversation**: the assistant must put the code or context into the prompt. Prices shown are list prices (USD) from the public price list and include the lowest group multiplier the model is in; actual bills can be lower thanks to cache hits. Exact charges are in **Usage Logs** on [api.ezkielyna.store](https://api.ezkielyna.store).

Price example (public price list, 11 Nov 2026): `deepseek-v4.1-flash` costs $0.04 per 1M input tokens and $0.16 per 1M output tokens, so a 2,000-token prompt with a 1,000-token answer is about $0.00024.

## Install

**With npx (recommended):** nothing to install. The configs below run `npx -y ezkielyna-mcp`, which downloads the package (one file) on first start.

**From source:**

```bash
git clone https://github.com/EzkielynaGroup/ezkielyna-mcp.git
cd ezkielyna-mcp
node --test test/        # optional: local mock server, no network, no cost
```

Then use `"command": "node"` with `"args": ["/full/path/to/ezkielyna-mcp.mjs"]` instead of `npx`.

**Windows:** if the app cannot start `npx`, use `"command": "cmd"` with `"args": ["/c", "npx", "-y", "ezkielyna-mcp"]`. Write source paths in JSON with forward slashes (`C:/Users/you/ezkielyna-mcp/ezkielyna-mcp.mjs`).

## Add it to your app

Replace `sk-...` with your key.

**Claude Code**

```bash
claude mcp add ezkielyna -e EZKIELYNA_API_KEY=sk-... -- npx -y ezkielyna-mcp
```

Add `--scope user` to make it available in every project. Check with `claude mcp list`.

**Claude Desktop**: Settings → Developer → Edit Config (`claude_desktop_config.json`), then quit and reopen Claude Desktop.

```json
{
  "mcpServers": {
    "ezkielyna": {
      "command": "npx",
      "args": ["-y", "ezkielyna-mcp"],
      "env": { "EZKIELYNA_API_KEY": "sk-..." }
    }
  }
}
```

**Cursor**: `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project), same JSON as Claude Desktop.

**OpenCode**: `opencode.json` in the project, or `~/.config/opencode/opencode.json`.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "ezkielyna": {
      "type": "local",
      "command": ["npx", "-y", "ezkielyna-mcp"],
      "enabled": true,
      "environment": { "EZKIELYNA_API_KEY": "sk-..." }
    }
  }
}
```

## Configuration (environment)

| Variable | Required | Default | Notes |
|---|---|---|---|
| `EZKIELYNA_API_KEY` | yes (except `list_models`) | | key in group **Standard** or **Auto** |
| `EZKIELYNA_BASE_URL` | no | `https://api.ezkielyna.store/v1` | API address |
| `EZKIELYNA_MAX_CALLS` | no | `50` | calls per session for `ask_model`, `compare_models` (one per model) and `web_search`. A guard against runaway agent loops; restart the app to reset. |
| `EZKIELYNA_MAX_TOKENS` | no | `4096` | upper limit for `max_tokens` (larger requests are lowered to it) |
| `EZKIELYNA_TIMEOUT_MS` | no | `120000` | request timeout (search uses at most 30 s) |

## Safety and limits

- The key is only sent in the `Authorization` header to `EZKIELYNA_BASE_URL`; it is scrubbed from every answer and log line. Logs go to stderr; stdout carries only MCP messages.
- Session cap (`EZKIELYNA_MAX_CALLS`) is checked **before** anything is sent; `compare_models` reserves one slot per model. Calls the gateway clearly refused (wrong key, no balance, busy) give their slot back.
- Prompts are limited to 100,000 characters; answers longer than 60,000 characters (20,000 per model in `compare_models`) are truncated.
- No files are read or written. Every request has a timeout.
- Model ids containing `uncensored`, `abliterated` or `nsfw` are never listed and cannot be called through this server.

## Data source

Prices come at runtime from the public endpoint `https://api.ezkielyna.store/api/pricing` (no key, cached 10 minutes). Price per 1M tokens = `model_ratio × 2 × group multiplier`, output price = input price × `completion_ratio` (the New API pricing convention), which matches the published list at `https://api.ezkielyna.store/llms-full.txt` (checked 11 Nov 2026). Nothing is bundled.

## FAQ

**How do I get a second opinion from another AI model inside Claude Code?**
Add this server (`claude mcp add ezkielyna ...`) and ask, for example, "compare deepseek-v4.1-flash and glm-5.3 on this function". Claude calls `compare_models` and shows both answers with their cost.

**Can I use DeepSeek or GLM inside Claude Desktop or Cursor?**
Yes. `ask_model` sends a prompt to any model your key can use; run `list_models` to see the ids and prices.

**How much does one question cost?**
It depends on the model and length; each answer shows the estimated cost. With `deepseek-v4.1-flash` a typical code-review question (a few thousand tokens) costs a fraction of a US cent.

**Does it send my whole conversation to the other model?**
No. Only the `prompt` and optional `system` text the assistant passes to the tool are sent.

**Can it search the web?**
Yes, `web_search` returns up to 10 results with title, URL and snippet through the Ezkielyna search endpoint.

**Is Ezkielyna affiliated with DeepSeek, Anthropic or OpenAI?**
No. Ezkielyna is an independent API gateway and is not affiliated with the model vendors or the MCP client makers.

## Development

```bash
node --test test/
```

The tests spawn the server over stdio against a local mock gateway: no internet, no cost. Issues and pull requests are welcome.

---

## Bahasa Indonesia

Server MCP agar asisten AI Anda (Claude Code, Claude Desktop, Cursor, OpenCode) bisa **bertanya ke model AI lain untuk pendapat kedua**, membandingkan 2-4 jawaban berdampingan, mencari di web, dan mengecek saldo lewat [Ezkielyna API](https://ezkielyna.store/?utm_source=github&utm_medium=readme&utm_campaign=ezkielyna-mcp).

Contoh (di Claude Code): *"Minta deepseek-v4.1-flash dan glm-5.3 me-review SQL di `db/laporan.sql` untuk risiko injection, lalu jelaskan di mana mereka berbeda pendapat."*

### Yang dibutuhkan

1. **Node.js 18+**. Cukup satu file, tanpa `npm install`.
2. **API key Ezkielyna** grup **Standard** (DeepSeek, GLM, Kimi, MiniMax, Qwen, dll.) atau **Auto** (termasuk Claude, GPT, Grok dengan pengali Premium 1.5x). Beli API Credit mulai $0.5 lewat QRIS/DANA/GoPay/USDT di [ezkielyna.store/beli-api-key](https://ezkielyna.store/beli-api-key?utm_source=github&utm_medium=readme&utm_campaign=ezkielyna-mcp), tukarkan di menu **Wallet** di [api.ezkielyna.store](https://api.ezkielyna.store), lalu buat key di menu **API Keys**.
3. `list_models` bisa dipakai tanpa key (menampilkan daftar harga publik).

### Tool

| Tool | Fungsi | Biaya |
|---|---|---|
| `ask_model` | Kirim prompt (opsional `system`) ke satu model. Default `deepseek-v4.1-flash`, `max_tokens` 1024 (maks 4096). Hasil: jawaban, token, waktu, perkiraan biaya. | berbayar, 1 panggilan |
| `compare_models` | Prompt yang sama ke 2-4 model **sekaligus (paralel)**, jawaban berdampingan dengan token, waktu, dan biaya masing-masing. | berbayar, 1 panggilan per model |
| `list_models` | Model yang bisa dipakai key Anda + harga publik. Bisa difilter, mis. `deepseek`. | gratis |
| `web_search` | Pencarian web (1-10 hasil), opsional `time_range` dan `language` (mis. `id`). | dihitung ke batas sesi |
| `check_balance` | Batas kredit, pemakaian, dan sisa saldo dari endpoint billing gaya OpenAI. Jika format jawabannya tidak dikenal, Anda diarahkan ke dashboard. | gratis |

Model lain **tidak melihat percakapan Anda**: asisten harus menyertakan kode/konteks di dalam prompt. Harga yang ditampilkan adalah harga daftar (USD); tagihan sebenarnya ada di **Usage Logs** dashboard.

### Pemasangan

Claude Code:

```bash
claude mcp add ezkielyna -e EZKIELYNA_API_KEY=sk-... -- npx -y ezkielyna-mcp
```

Claude Desktop, Cursor dan OpenCode: pakai contoh JSON di bagian Inggris di atas, cukup ganti `sk-...`. Di Windows, jika `npx` tidak jalan, pakai `"command": "cmd"` dan `"args": ["/c", "npx", "-y", "ezkielyna-mcp"]`.

### Pengaturan dan keamanan

- `EZKIELYNA_MAX_CALLS` (default 50): batas panggilan per sesi untuk `ask_model`, `compare_models` (dihitung per model) dan `web_search`, dicek **sebelum** permintaan dikirim. Mulai ulang aplikasi untuk mereset.
- `EZKIELYNA_MAX_TOKENS` (default 4096): batas atas `max_tokens`.
- Key tidak pernah ditampilkan di jawaban maupun log. Tidak ada file yang dibaca atau ditulis.
- Model dengan id berisi `uncensored`, `abliterated` atau `nsfw` tidak ditampilkan dan tidak bisa dipanggil.

### Tanya jawab

**Bagaimana cara minta pendapat kedua dari model AI lain di Claude Code?**
Pasang server ini lalu minta, misalnya, "bandingkan jawaban deepseek-v4.1-flash dan glm-5.3 untuk fungsi ini". Claude akan memanggil `compare_models`.

**Berapa biaya satu pertanyaan?**
Tergantung model dan panjang teks; setiap jawaban menampilkan perkiraan biaya. Dengan `deepseek-v4.1-flash`, satu pertanyaan review kode biasanya jauh di bawah 1 sen dolar.

**Apakah Ezkielyna berafiliasi dengan DeepSeek, Anthropic atau OpenAI?**
Tidak. Ezkielyna adalah API gateway independen.

## License

MIT, Copyright (c) 2026 Ezekiel Lieberhart (Ezkielyna). Ezkielyna is an independent API gateway and is not affiliated with the model vendors or the MCP client makers.

<!-- ezk:toolkit -->
---

### Part of the Ezkielyna developer toolkit

Open-source tools from [Ezkielyna](https://ezkielyna.store/?utm_source=github&utm_medium=readme&utm_campaign=ezkielyna-mcp), an independent OpenAI- and Anthropic-compatible AI API gateway (pay with QRIS, USDT or Binance Pay; no credit card).

| No API key needed | With an Ezkielyna key |
|---|---|
| [mcp-bmkg](https://github.com/EzkielynaGroup/mcp-bmkg) · [mcp-wilayah-indonesia](https://github.com/EzkielynaGroup/mcp-wilayah-indonesia) · [mcp-hari-libur-indonesia](https://github.com/EzkielynaGroup/mcp-hari-libur-indonesia) · [mcp-rupiah](https://github.com/EzkielynaGroup/mcp-rupiah) · [mcp-qris](https://github.com/EzkielynaGroup/mcp-qris) · [ai-model-status-mcp](https://github.com/EzkielynaGroup/ai-model-status-mcp) | [ezkielyna-mcp](https://github.com/EzkielynaGroup/ezkielyna-mcp) · [ezkielyna-image-mcp](https://github.com/EzkielynaGroup/ezkielyna-image-mcp) · [ezkielyna-audio-mcp](https://github.com/EzkielynaGroup/ezkielyna-audio-mcp) · [n8n-nodes-ezkielyna](https://github.com/EzkielynaGroup/n8n-nodes-ezkielyna) |

More: [all repositories](https://github.com/EzkielynaGroup) · [awesome-mcp-indonesia](https://github.com/EzkielynaGroup/awesome-mcp-indonesia) · [awesome-ai-indonesia](https://github.com/EzkielynaGroup/awesome-ai-indonesia)
<!-- /ezk:toolkit -->
