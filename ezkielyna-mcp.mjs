#!/usr/bin/env node
// Ezkielyna MCP: ask other AI models (a second opinion), compare answers side by side, search the web and check your
// balance through the Ezkielyna API, from Claude Desktop, Claude Code, Cursor, OpenCode or any MCP client.
// One file, no dependencies, Node >= 18. MCP over stdio (newline-delimited JSON-RPC). Logs go to stderr only; stdout
// carries protocol messages. The API key is never printed.
//
// Env:
//   EZKIELYNA_API_KEY      required for every tool except list_models (Standard or Auto group)
//   EZKIELYNA_BASE_URL     default https://api.ezkielyna.store/v1
//   EZKIELYNA_MAX_CALLS    calls to ask_model / compare_models (one per model) / web_search per session, default 50
//   EZKIELYNA_MAX_TOKENS   upper limit for max_tokens, default 4096
//   EZKIELYNA_TIMEOUT_MS   request timeout, default 120000
import readline from 'node:readline';

const VERSION = '1.0.0';
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const DEFAULT_PROTOCOL = '2025-06-18';
const UTM = '?utm_source=mcp&utm_medium=tool&utm_campaign=ezkielyna-mcp';
const BUY_URL = 'https://ezkielyna.store/beli-api-key' + UTM;
const DASHBOARD_URL = 'https://api.ezkielyna.store';

const DEFAULT_MODEL = 'deepseek-v4.1-flash';
const DEFAULT_MAX_TOKENS_WANTED = 1024;
const MAX_PROMPT_CHARS = 100000;
const MAX_ANSWER_CHARS = 60000;
const MAX_COMPARE_ANSWER_CHARS = 20000;
const MAX_LIST_LINES = 200;
const PRICING_TTL_MS = 10 * 60 * 1000;
// Never listed or returned by any tool (project rule).
const HIDDEN_MODEL = /uncensored|abliterated|nsfw/i;

const env = process.env;
const API_KEY = (env.EZKIELYNA_API_KEY || '').trim();
const BASE_URL = (env.EZKIELYNA_BASE_URL || 'https://api.ezkielyna.store/v1').trim().replace(/\/+$/, '');
const MAX_CALLS = positiveInt(env.EZKIELYNA_MAX_CALLS, 50);
const TOKEN_CAP = Math.max(1, positiveInt(env.EZKIELYNA_MAX_TOKENS, 4096));
const DEFAULT_MAX_TOKENS = Math.min(DEFAULT_MAX_TOKENS_WANTED, TOKEN_CAP);
const TIMEOUT_MS = Math.max(1000, positiveInt(env.EZKIELYNA_TIMEOUT_MS, 120000));

let used = 0; // calls sent (or possibly charged) in this session
let pricingCache = null;

function positiveInt(v, dflt) {
  const n = Number.parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

function log(...args) {
  process.stderr.write('[ezkielyna-mcp] ' + args.map(a => scrub(String(a))).join(' ') + '\n');
}

// Removes the key (and anything that looks like an API key) from text shown to the user or the log.
function scrub(text) {
  let t = String(text);
  if (API_KEY) t = t.split(API_KEY).join('sk-***');
  return t.replace(/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-***');
}

class ToolError extends Error {}
class GatewayError extends ToolError {} // the gateway answered with an error: the request was refused, not charged

const NO_KEY = 'EZKIELYNA_API_KEY belum diisi di konfigurasi MCP / is not set in the MCP config. '
  + `Buat key grup Standard atau Auto di ${DASHBOARD_URL} (menu API Keys); beli saldo mulai $0.5 di ${BUY_URL}`;

// ---------- tools ----------

const PAID = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const FREE = { readOnlyHint: true, idempotentHint: true, openWorldHint: true };

const TOOLS = [
  {
    name: 'ask_model',
    title: 'Tanya model lain / Ask another AI model',
    description: 'Sends one prompt to another AI model through the Ezkielyna API and returns its answer with the tokens used, latency and '
      + `an estimated cost. Use it for a second opinion, a translation, or a task another model handles well. Default model ${DEFAULT_MODEL}. `
      + 'Paid (pay-as-you-go balance); counts toward the session cap. Run list_models to see model ids and prices.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The question or task for the model (include any code or context it needs; it cannot see this conversation).' },
        system: { type: 'string', description: 'Optional system prompt, e.g. "You are a strict code reviewer. Answer in Indonesian."' },
        model: { type: 'string', description: `Model id (default ${DEFAULT_MODEL}). See list_models.`, default: DEFAULT_MODEL },
        max_tokens: { type: 'integer', minimum: 1, maximum: TOKEN_CAP, default: DEFAULT_MAX_TOKENS, description: `Maximum answer length in tokens (default ${DEFAULT_MAX_TOKENS}, cap ${TOKEN_CAP}).` },
        temperature: { type: 'number', minimum: 0, maximum: 2, description: 'Optional sampling temperature (0-2). Leave empty for the model default.' },
      },
      required: ['prompt'],
    },
    annotations: { title: 'Ask another AI model (paid)', ...PAID },
  },
  {
    name: 'compare_models',
    title: 'Bandingkan model / Compare models',
    description: 'Sends the same prompt to 2-4 models in parallel and returns the answers side by side with tokens, latency and estimated cost '
      + 'for each. Good for a second (or third) opinion on code, a design decision or a fact. Paid: each model counts as one call toward the session cap.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The question or task (self-contained: the models cannot see this conversation).' },
        models: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 4, description: '2-4 different model ids, e.g. ["deepseek-v4.1-flash", "glm-5.3"]. See list_models.' },
        system: { type: 'string', description: 'Optional system prompt sent to every model.' },
        max_tokens: { type: 'integer', minimum: 1, maximum: TOKEN_CAP, default: DEFAULT_MAX_TOKENS, description: `Maximum answer length per model (default ${DEFAULT_MAX_TOKENS}, cap ${TOKEN_CAP}).` },
      },
      required: ['prompt', 'models'],
    },
    annotations: { title: 'Compare 2-4 models (paid)', ...PAID },
  },
  {
    name: 'list_models',
    title: 'Daftar model / List models',
    description: 'Lists the models your API key can use (GET /v1/models) with public list prices (USD per 1M tokens, or per call). '
      + 'Without a key it shows the public price list. Optional filter text, e.g. "deepseek", "claude", "image". Free.',
    inputSchema: {
      type: 'object',
      properties: {
        filter: { type: 'string', description: 'Optional text to match in the model id or type (chat, image, video, tts, stt, embedding).' },
      },
    },
    annotations: { title: 'List models and prices', ...FREE },
  },
  {
    name: 'web_search',
    title: 'Cari di web / Web search',
    description: 'Searches the web through the Ezkielyna API (POST /v1/search) and returns 1-10 results with title, URL and a snippet. '
      + 'Use it for recent facts, docs or news, then read a page with a fetch tool if needed. Counts toward the session cap.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search keywords (1-400 characters).' },
        max_results: { type: 'integer', minimum: 1, maximum: 10, default: 5, description: 'Number of results (1-10, default 5).' },
        time_range: { type: 'string', enum: ['day', 'week', 'month', 'year'], description: 'Optional: only results from the last day/week/month/year.' },
        language: { type: 'string', description: 'Optional language code, e.g. "id" or "en".' },
      },
      required: ['query'],
    },
    annotations: { title: 'Web search', readOnlyHint: true, idempotentHint: false, openWorldHint: true },
  },
  {
    name: 'check_balance',
    title: 'Cek saldo / Check balance',
    description: 'Shows the credit limit and usage the gateway reports for your key (OpenAI-compatible billing endpoints, USD), '
      + 'plus how many calls are left in this session. Free.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { title: 'Check balance', ...FREE },
  },
];

async function callTool(name, args) {
  switch (name) {
    case 'ask_model': return askModel(args);
    case 'compare_models': return compareModels(args);
    case 'list_models': return listModels(args);
    case 'web_search': return webSearch(args);
    case 'check_balance': return checkBalance();
  }
  throw Object.assign(new Error(`Unknown tool: ${name}`), { rpcCode: -32602 });
}

function chatPayload(model, prompt, system, maxTokens, temperature) {
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: prompt });
  const body = { model, messages, max_tokens: maxTokens, stream: false };
  if (temperature !== undefined) body.temperature = temperature;
  return body;
}

function readMaxTokens(v) {
  if (v === undefined || v === null || v === '') return { value: DEFAULT_MAX_TOKENS, note: '' };
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n < 1) throw new ToolError('max_tokens harus angka >= 1 / must be a number >= 1.');
  if (n > TOKEN_CAP) return { value: TOKEN_CAP, note: `max_tokens dibatasi ke / capped at ${TOKEN_CAP} (EZKIELYNA_MAX_TOKENS).` };
  return { value: n, note: '' };
}

// One chat completion. Returns { answer, usage, ms, finish } or throws ToolError/GatewayError.
async function chatOnce(body) {
  const t0 = Date.now();
  const r = await gateway('/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const v = await readJson(r);
  const ms = Date.now() - t0;
  const choice = Array.isArray(v?.choices) ? v.choices[0] : null;
  if (!choice) throw new ToolError('Jawaban gateway tidak berisi pilihan (choices) / The gateway answer has no choices. Coba lagi / Try again.');
  const msg = choice.message || {};
  let answer = typeof msg.content === 'string' ? msg.content
    : Array.isArray(msg.content) ? msg.content.map(p => (p && typeof p.text === 'string' ? p.text : '')).join('') : '';
  const finish = String(choice.finish_reason || '');
  const reasoning = typeof msg.reasoning_content === 'string' && msg.reasoning_content.trim() !== '';
  if (!answer.trim()) {
    answer = finish === 'length'
      ? `(Jawaban kosong: batas max_tokens habis${reasoning ? ' untuk proses berpikir model' : ''}. Naikkan max_tokens. / Empty answer: max_tokens ran out${reasoning ? ' during the model\'s reasoning' : ''}; raise max_tokens.)`
      : '(Jawaban kosong / Empty answer.)';
  }
  const u = v?.usage || {};
  const usage = {
    prompt: Number(u.prompt_tokens) || 0,
    completion: Number(u.completion_tokens) || 0,
    total: Number(u.total_tokens) || (Number(u.prompt_tokens) || 0) + (Number(u.completion_tokens) || 0),
    cached: Number(u.prompt_tokens_details?.cached_tokens) || 0,
  };
  return { answer, usage, ms, finish, model: typeof v?.model === 'string' ? v.model : body.model };
}

async function askModel(args) {
  const prompt = requireText(args.prompt, 'prompt');
  const system = optLongText(args.system, 'system');
  const model = optText(args.model) || DEFAULT_MODEL;
  checkModelId(model);
  const mt = readMaxTokens(args.max_tokens);
  let temperature;
  if (args.temperature !== undefined && args.temperature !== null && args.temperature !== '') {
    temperature = Number(args.temperature);
    if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) throw new ToolError('temperature harus 0-2 / must be between 0 and 2.');
  }
  requireKey();
  reserve(1);
  let res;
  try {
    res = await chatOnce(chatPayload(model, prompt, system, mt.value, temperature));
  } catch (e) {
    if (e instanceof GatewayError) used--;
    throw e;
  }
  const prices = await pricing().catch(() => null);
  const lines = [
    clip(res.answer, MAX_ANSWER_CHARS),
    '',
    '---',
    `Model: ${model} | ${fmtUsage(res.usage)} | ${(res.ms / 1000).toFixed(1)} s | ${fmtCost(prices, model, res.usage)}`
      + (res.finish === 'length' ? ' | terpotong / cut off at max_tokens' : ''),
    `Jatah sesi / Session: ${used}/${MAX_CALLS} panggilan / calls`,
  ];
  if (mt.note) lines.push(mt.note);
  return text(lines.join('\n'));
}

async function compareModels(args) {
  const prompt = requireText(args.prompt, 'prompt');
  const system = optLongText(args.system, 'system');
  const raw = Array.isArray(args.models) ? args.models : [];
  const models = [...new Set(raw.map(optText).filter(Boolean))];
  if (models.length < 2 || models.length > 4) throw new ToolError('Isi 2-4 model yang berbeda di "models" / Give 2-4 different model ids in "models".');
  models.forEach(checkModelId);
  const mt = readMaxTokens(args.max_tokens);
  requireKey();
  reserve(models.length);
  const body = m => chatPayload(m, prompt, system, mt.value);
  const results = await Promise.allSettled(models.map(m => chatOnce(body(m))));
  results.forEach(r => { if (r.status === 'rejected' && r.reason instanceof GatewayError) used--; });
  const prices = await pricing().catch(() => null);
  const sections = results.map((r, i) => {
    const m = models[i];
    if (r.status === 'rejected') {
      const msg = r.reason instanceof ToolError ? r.reason.message : 'Terjadi kesalahan / Unexpected error.';
      return `## ${i + 1}. ${m}\n\nGAGAL / FAILED: ${scrub(msg)}`;
    }
    const x = r.value;
    return `## ${i + 1}. ${m}\n${fmtUsage(x.usage)} | ${(x.ms / 1000).toFixed(1)} s | ${fmtCost(prices, m, x.usage)}`
      + (x.finish === 'length' ? ' | terpotong / cut off at max_tokens' : '') + `\n\n${clip(x.answer, MAX_COMPARE_ANSWER_CHARS)}`;
  });
  const ok = results.filter(r => r.status === 'fulfilled');
  const summary = ok.length
    ? 'Ringkasan / Summary: ' + results.map((r, i) => r.status === 'fulfilled'
      ? `${models[i]} ${(r.value.ms / 1000).toFixed(1)} s, ${r.value.usage.completion} out-tokens` : `${models[i]} failed`).join('; ')
    : 'Semua model gagal / All models failed.';
  const out = [sections.join('\n\n'), '', '---', summary, `Jatah sesi / Session: ${used}/${MAX_CALLS} panggilan / calls`];
  if (mt.note) out.push(mt.note);
  return text(out.join('\n'), ok.length === 0);
}

async function listModels(args) {
  const filter = optText(args.filter).toLowerCase().slice(0, 100);
  const prices = await pricing();
  let ids;
  let header;
  if (API_KEY) {
    const r = await gateway('/models', { method: 'GET' });
    ids = ((await readJson(r))?.data || []).map(m => m && m.id).filter(id => typeof id === 'string');
    header = 'Model untuk key ini / Models this key can use';
  } else {
    if (!prices.byModel.size) throw new ToolError(NO_KEY);
    ids = [...prices.byModel.keys()];
    header = 'EZKIELYNA_API_KEY belum diisi: ini daftar harga publik (tidak semua grup key bisa memakai semua model). '
      + '/ No key set: this is the public price list (not every key group can use every model)';
  }
  ids = [...new Set(ids)].filter(id => !HIDDEN_MODEL.test(id));
  const rows = ids.map(id => ({ id, p: prices.byModel.get(id) }))
    .filter(({ id, p }) => !filter || id.toLowerCase().includes(filter) || (p && p.kind === filter))
    .sort((a, b) => kindRank(a.p) - kindRank(b.p) || a.id.localeCompare(b.id));
  if (!rows.length) {
    return text(filter ? `Tidak ada model yang cocok dengan "${filter}" / No model matches "${filter}".`
      : 'Key ini tidak punya model / This key has no models. Buat key grup Standard atau Auto / Create a Standard or Auto key.', !filter);
  }
  const shown = rows.slice(0, MAX_LIST_LINES).map(({ id, p }) => `- ${id} [${p ? p.kind : '?'}]: ${p ? fmtPrice(p) : 'harga / price: ' + DASHBOARD_URL + '/pricing'}`);
  const out = [`${header}${filter ? ` (filter "${filter}")` : ''}: ${rows.length}`, ...shown];
  if (rows.length > MAX_LIST_LINES) out.push(`... dan ${rows.length - MAX_LIST_LINES} lagi / and ${rows.length - MAX_LIST_LINES} more: pakai filter / use filter.`);
  out.push('', 'Harga daftar dalam USD, sudah termasuk pengali grup terendah model itu (Premium 1.5x). / List prices in USD, including the lowest group multiplier the model is in.',
    'Tagihan sebenarnya bisa lebih rendah karena cache. / Actual bills can be lower because of cache hits.');
  return text(out.join('\n'));
}

async function webSearch(args) {
  const query = optText(args.query);
  if (query.length < 1 || query.length > 400) throw new ToolError('"query" harus 1-400 karakter / must be 1-400 characters.');
  const body = { query };
  const n = args.max_results === undefined || args.max_results === null || args.max_results === '' ? 5 : Math.floor(Number(args.max_results));
  if (!Number.isFinite(n)) throw new ToolError('max_results harus angka 1-10 / must be a number from 1 to 10.');
  body.max_results = Math.min(10, Math.max(1, n));
  const tr = optText(args.time_range);
  if (tr) {
    if (!['day', 'week', 'month', 'year'].includes(tr)) throw new ToolError('time_range: day, week, month atau/or year.');
    body.time_range = tr;
  }
  const lang = optText(args.language);
  if (lang) {
    if (!/^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8})?$/.test(lang)) throw new ToolError('language: kode bahasa seperti / a code like "id" or "en".');
    body.language = lang;
  }
  requireKey();
  reserve(1);
  let v;
  try {
    const r = await gateway('/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, 'search');
    v = await readJson(r);
  } catch (e) {
    if (e instanceof GatewayError) used--;
    throw e;
  }
  const results = (Array.isArray(v?.results) ? v.results : []).filter(x => x && typeof x.url === 'string').slice(0, body.max_results);
  if (!results.length) {
    return text('Tidak ada hasil. Coba kata kunci lain atau perluas time_range. / No results: try other keywords or a wider time_range.');
  }
  const clean = (s, max) => (typeof s === 'string' ? s : '').replace(/\s+/g, ' ').trim().slice(0, max);
  const lines = results.map((x, i) => {
    const date = x.published || x.publishedDate || x.published_date;
    const head = `${i + 1}. ${clean(x.title, 200) || clean(x.url, 200)}\n   ${clean(x.url, 500)}${date ? ` (${clean(String(date), 40)})` : ''}`;
    const snip = clean(x.snippet || x.content || x.description, 500);
    return snip ? `${head}\n   ${snip}` : head;
  });
  return text([...lines, '', `${results.length} hasil / results${v.cached ? ' (cache)' : ''}. Jatah sesi / Session: ${used}/${MAX_CALLS}.`].join('\n'));
}

async function checkBalance() {
  requireKey();
  const session = `Jatah sesi MCP / MCP session: ${used}/${MAX_CALLS} panggilan dipakai / calls used.`;
  const unclear = `Detail saldo tidak bisa dibaca dari API. Lihat dashboard: ${DASHBOARD_URL} (Wallet dan Usage Logs). `
    + `/ The balance could not be read from the API; open the dashboard: ${DASHBOARD_URL} (Wallet and Usage Logs).`;
  let sub;
  let usage = null;
  try {
    sub = await readJson(await gateway('/dashboard/billing/subscription', { method: 'GET' }));
  } catch (e) {
    if (e instanceof GatewayError && /Wrong or inactive API key/.test(e.message)) throw e;
    return text(`${unclear}\n${session}`);
  }
  const limit = Number(sub?.hard_limit_usd ?? sub?.system_hard_limit_usd);
  if (!Number.isFinite(limit)) return text(`${unclear}\n${session}`);
  try {
    const d = new Date();
    const end = new Date(d.getTime() + 86400000).toISOString().slice(0, 10);
    const start = new Date(d.getTime() - 99 * 86400000).toISOString().slice(0, 10);
    const u = await readJson(await gateway(`/dashboard/billing/usage?start_date=${start}&end_date=${end}`, { method: 'GET' }));
    const cents = Number(u?.total_usage);
    if (Number.isFinite(cents)) usage = cents / 100;
  } catch { /* usage is optional */ }
  const lines = [`Batas kredit yang dilaporkan / Reported credit limit: ${fmtMoney(limit)}`];
  if (usage !== null) {
    lines.push(`Terpakai / Used: ${fmtMoney(usage)}`);
    lines.push(`Sisa (perkiraan) / Remaining (approx.): ${fmtMoney(Math.max(0, limit - usage))}`);
  }
  lines.push('Angka dari endpoint billing gaya OpenAI; untuk key tanpa batas sendiri, gateway melaporkan saldo akun. '
    + '/ Figures come from the OpenAI-style billing endpoints; for a key without its own limit the gateway reports the account balance.',
  `Rincian per permintaan / Per-request details: ${DASHBOARD_URL} (Usage Logs). Top up: ${BUY_URL}`, session);
  return text(lines.join('\n'));
}

// ---------- session cap ----------

function requireKey() {
  if (!API_KEY) throw new ToolError(NO_KEY);
}

function reserve(n) {
  if (used + n > MAX_CALLS) {
    throw new ToolError(`Batas ${MAX_CALLS} panggilan per sesi tercapai (EZKIELYNA_MAX_CALLS; terpakai ${used}, butuh ${n}). Mulai ulang MCP untuk lanjut. `
      + `/ Session limit of ${MAX_CALLS} calls reached (${used} used, ${n} needed): restart the MCP server or raise EZKIELYNA_MAX_CALLS.`);
  }
  used += n;
}

// ---------- gateway ----------

async function gateway(p, init, what = 'chat') {
  requireKey();
  const headers = { Authorization: 'Bearer ' + API_KEY, 'User-Agent': 'ezkielyna-mcp/' + VERSION, ...(init.headers || {}) };
  let r;
  try {
    r = await fetch(BASE_URL + p, { ...init, headers, signal: AbortSignal.timeout(what === 'search' ? Math.min(TIMEOUT_MS, 30000) : TIMEOUT_MS) });
  } catch (e) {
    const timeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    throw new ToolError((timeout ? 'Gateway terlalu lama menjawab / Gateway timed out.' : 'Tidak bisa menghubungi gateway / Could not reach the gateway.')
      + ` (${BASE_URL}) Cek koneksi internet lalu coba lagi. / Check your connection and try again.`
      + (init.method === 'POST' && what === 'chat' ? ` Jika sudah ditagih, cek Usage Logs di ${DASHBOARD_URL}. / If it was charged, check your usage logs.` : ''));
  }
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new GatewayError(friendlyError(r.status, body, what));
  }
  return r;
}

async function readJson(r) {
  const t = await r.text();
  try { return JSON.parse(t); } catch {
    throw new ToolError('Jawaban gateway bukan JSON / The gateway answer is not JSON. Coba lagi nanti / Try again later.');
  }
}

function friendlyError(status, body, what) {
  let msg = '';
  let code = '';
  try {
    const v = JSON.parse(body);
    const e = v && typeof v.error === 'object' ? v.error : v;
    msg = String((e && (e.message || e.msg)) || (typeof v.error === 'string' ? v.error : '') || '');
    code = String((e && (e.code || e.type)) || '');
  } catch { msg = body; }
  const all = (msg + ' ' + code).toLowerCase();
  const detail = scrub(msg).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200).replace(/[.\s]+$/, '');
  // New API: a key with its own model list (API Keys > edit > model limits) answers "This token has no access to model X".
  if (/no access to model|无权访问/.test(all)) {
    return 'Key ini dibatasi ke daftar model tertentu (pengaturan key: batas model) dan model ini tidak termasuk. Pakai model yang diizinkan, ubah batas model key, atau buat key baru tanpa batas model. '
      + '/ This key is limited to a model list (key setting: model limits) that does not include this model: use an allowed model, edit the key, or create a key without model limits.' + (detail ? ` [${detail}]` : '');
  }
  if (status === 401) return 'Key API salah atau tidak aktif. Cek EZKIELYNA_API_KEY. / Wrong or inactive API key: check EZKIELYNA_API_KEY.';
  const balance = `Saldo API tidak cukup. Top up di ${BUY_URL} lalu coba lagi. / Insufficient API balance: top up and try again.`;
  if (status === 402) return balance;
  if (what === 'search') {
    if (status === 400) return `Pencarian ditolak (${detail || 'invalid'}). Perbaiki kata kunci. / Search rejected as invalid: fix the query.`;
    if (status === 429) return 'Batas pencarian tercapai. Lanjutkan dengan informasi yang ada. / Search rate limit reached: continue with what you have.';
    if (status === 404) return 'Endpoint pencarian tidak ditemukan di BASE_URL ini. / The search endpoint was not found at this EZKIELYNA_BASE_URL.';
    if (status >= 500) return 'Pencarian sedang tidak tersedia. Coba sekali lagi nanti. / Search is temporarily unavailable: retry once later.' + (detail ? ` [${detail}]` : '');
  }
  if (status === 413) return 'Prompt terlalu besar untuk gateway. Persingkat. / The prompt is too large for the gateway: shorten it.';
  // New API answers "no available channel for this model in group X" with 503: that is a wrong-group key, not a busy server.
  const groupText = /group|not allowed|forbidden|no available channel|分组|无权|权限|无可用渠道/.test(all);
  if (status === 429 || (status >= 500 && !groupText)) return 'Model sedang sibuk atau gangguan. Tunggu sebentar lalu coba lagi, atau pilih model lain. / The model is busy or failing: wait and retry, or pick another model.';
  if (/insufficient|quota|balance|额度|余额|saldo/.test(all)) return balance;
  if (status === 403 || groupText) {
    return 'Grup key ini tidak bisa memakai model ini. Jalankan list_models, atau buat key grup Auto. '
      + '/ This key\'s group cannot use this model: run list_models, or create a key in group Auto.' + (detail ? ` [${detail}]` : '');
  }
  if (status === 404 || /model_not_found|not found|不存在/.test(all)) {
    return 'Model tidak tersedia untuk key ini. Jalankan list_models untuk melihat pilihan. / Model not available for this key: run list_models.' + (detail ? ` [${detail}]` : '');
  }
  if (status === 400) return `Permintaan ditolak / Request rejected${detail ? `: ${detail}` : ''}.`;
  return `Gateway error ${status}` + (detail ? `: ${detail}` : '') + '. Coba lagi nanti / Try again later.';
}

// ---------- prices (public, no key) ----------

function kindOf(m) {
  const tags = String(m.tags || '').toLowerCase();
  const eps = Array.isArray(m.supported_endpoint_types) ? m.supported_endpoint_types : [];
  if (tags === 'tts') return 'tts';
  if (tags === 'stt') return 'stt';
  if (eps.includes('embeddings') || tags === 'embedding') return 'embedding';
  if (eps.includes('openai-video') || tags === 'video') return 'video';
  if (eps.includes('image-generation') || tags === 'image') return 'image';
  return 'chat';
}

function kindRank(p) {
  return ['chat', 'embedding', 'image', 'video', 'tts', 'stt'].indexOf(p ? p.kind : 'zzz') + 1 || 99;
}

async function pricing() {
  if (pricingCache && Date.now() - pricingCache.at < PRICING_TTL_MS) return pricingCache;
  const byModel = new Map();
  try {
    const r = await fetch(new URL(BASE_URL).origin + '/api/pricing', { signal: AbortSignal.timeout(Math.min(TIMEOUT_MS, 20000)), headers: { 'User-Agent': 'ezkielyna-mcp/' + VERSION } });
    const v = r.ok ? await r.json() : null;
    const ratios = v && typeof v.group_ratio === 'object' && v.group_ratio ? v.group_ratio : {};
    for (const m of Array.isArray(v?.data) ? v.data : []) {
      if (!m || typeof m.model_name !== 'string' || HIDDEN_MODEL.test(m.model_name)) continue;
      const mults = (Array.isArray(m.enable_groups) ? m.enable_groups : []).map(g => Number(ratios[g])).filter(x => Number.isFinite(x) && x > 0);
      const mult = mults.length ? Math.min(...mults) : 1;
      const p = { kind: kindOf(m), mult };
      if (m.quota_type === 1) p.call = Number(m.model_price) * mult;
      else {
        p.in = Number(m.model_ratio) * 2 * mult; // New API: ratio 1 = $2 per 1M input tokens
        p.out = p.in * (Number.isFinite(Number(m.completion_ratio)) ? Number(m.completion_ratio) : 1);
      }
      byModel.set(m.model_name, p);
    }
    if (!byModel.size) throw new Error('empty pricing');
    pricingCache = { at: Date.now(), byModel };
  } catch (e) {
    log('pricing unavailable:', e && e.message);
    return pricingCache || { at: 0, byModel };
  }
  return pricingCache;
}

function fmtUsd(n) {
  if (!Number.isFinite(n)) return '?';
  if (n === 0) return '$0';
  if (n < 0.000001) return '< $0.000001';
  return '$' + Number(n.toPrecision(n < 0.01 ? 3 : 4)).toString();
}

function fmtMoney(n) {
  return '$' + (Math.round(n * 10000) / 10000).toString();
}

function fmtPrice(p) {
  if (p.call !== undefined) return `${fmtUsd(p.call)} per call`;
  if (p.kind === 'tts') return `${fmtUsd(p.in)} per 1M input characters`;
  if (p.kind === 'stt') return `${fmtUsd(p.in)} per 1M audio tokens (billed by audio length)`;
  return `in ${fmtUsd(p.in)} / out ${fmtUsd(p.out)} per 1M tokens`;
}

function fmtUsage(u) {
  return `tokens: ${u.prompt} in + ${u.completion} out = ${u.total}` + (u.cached ? ` (${u.cached} cached)` : '');
}

function fmtCost(prices, model, u) {
  const p = prices && prices.byModel.get(model);
  if (!p || p.in === undefined) return p && p.call !== undefined ? `≈ ${fmtUsd(p.call)} per call` : 'biaya / cost: lihat / see Usage Logs';
  const cost = (u.prompt * p.in + u.completion * p.out) / 1e6;
  return `≈ ${fmtUsd(cost)} (list price, before cache discounts)`;
}

// ---------- argument helpers ----------

function optText(v) {
  return typeof v === 'string' ? v.trim() : '';
}

function requireText(v, name) {
  const t = optText(v);
  if (!t) throw new ToolError(`"${name}" wajib diisi / is required.`);
  if (t.length > MAX_PROMPT_CHARS) throw new ToolError(`"${name}" terlalu panjang (maks ${MAX_PROMPT_CHARS} karakter) / is too long (max ${MAX_PROMPT_CHARS} characters).`);
  return t;
}

function optLongText(v, name) {
  const t = optText(v);
  if (t.length > MAX_PROMPT_CHARS) throw new ToolError(`"${name}" terlalu panjang / is too long (max ${MAX_PROMPT_CHARS} characters).`);
  return t;
}

function checkModelId(m) {
  if (typeof m !== 'string' || !/^[A-Za-z0-9._:/-]{1,100}$/.test(m)) throw new ToolError('Nama model tidak valid / Invalid model id. Run list_models.');
  if (HIDDEN_MODEL.test(m)) throw new ToolError('Model ini tidak tersedia lewat MCP ini / This model is not available through this MCP server.');
}

function clip(t, max) {
  return t.length > max ? t.slice(0, max) + `\n\n[... dipotong / truncated at ${max} characters]` : t;
}

function text(t, isError = false) {
  return isError ? { content: [{ type: 'text', text: t }], isError: true } : { content: [{ type: 'text', text: t }] };
}

// ---------- JSON-RPC over stdio ----------

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

async function handle(msg) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;
  if (typeof method !== 'string') {
    if (isRequest) send({ jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid request' } });
    return;
  }
  if (!isRequest) return; // notifications (notifications/initialized, cancelled, ...) need no answer
  try {
    let result;
    switch (method) {
      case 'initialize': {
        const asked = params && params.protocolVersion;
        result = {
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : DEFAULT_PROTOCOL,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'ezkielyna', title: 'Ezkielyna', version: VERSION },
          instructions: 'Ask other AI models through the Ezkielyna API: ask_model for one answer, compare_models for 2-4 answers side by side, '
            + 'web_search for recent information, list_models for ids and prices, check_balance for credit. Prompts must be self-contained: '
            + 'the other models cannot see this conversation. ask_model, compare_models and web_search count toward a per-session cap.',
        };
        break;
      }
      case 'ping': result = {}; break;
      case 'tools/list': result = { tools: TOOLS }; break;
      case 'resources/list': result = { resources: [] }; break;
      case 'resources/templates/list': result = { resourceTemplates: [] }; break;
      case 'prompts/list': result = { prompts: [] }; break;
      case 'tools/call': {
        const name = params && params.name;
        if (!TOOLS.some(t => t.name === name)) {
          send({ jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${scrub(String(name))}` } });
          return;
        }
        // Long answers take a while; progress notifications keep clients that reset their timeout on progress waiting.
        const token = params && params._meta && params._meta.progressToken;
        let tick = 0;
        const timer = token !== undefined && token !== null
          ? setInterval(() => send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: token, progress: ++tick, message: 'Menunggu jawaban... / Waiting for the answer...' } }), 10000)
          : null;
        try {
          result = await callTool(name, (params && typeof params.arguments === 'object' && params.arguments) || {});
        } catch (e) {
          if (!(e instanceof ToolError)) log('tool failed:', e && e.stack || e);
          result = text(scrub(e instanceof ToolError ? e.message : 'Terjadi kesalahan / Unexpected error: ' + (e && e.message)), true);
        } finally {
          if (timer) clearInterval(timer);
        }
        break;
      }
      default:
        send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
        return;
    }
    send({ jsonrpc: '2.0', id, result });
  } catch (e) {
    log('request failed:', e && e.stack || e);
    send({ jsonrpc: '2.0', id, error: { code: e.rpcCode || -32603, message: scrub(e.message || 'Internal error') } });
  }
}

function main() {
  if (!API_KEY) log('warning: EZKIELYNA_API_KEY is not set; paid tools will answer with setup instructions.');
  log(`v${VERSION} ready; base ${BASE_URL}; session cap ${MAX_CALLS} calls; max_tokens cap ${TOKEN_CAP}`);
  const pending = new Set();
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', line => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    const msgs = Array.isArray(msg) ? msg : [msg];
    for (const m of msgs) {
      const p = handle(m && typeof m === 'object' ? m : {}).catch(e => log('fatal handler error:', e && e.stack || e));
      pending.add(p);
      p.finally(() => pending.delete(p));
    }
  });
  rl.on('close', async () => {
    await Promise.allSettled([...pending]);
    process.exit(0);
  });
}

main();
