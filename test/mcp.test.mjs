// End-to-end tests: a local mock gateway (http server) and the MCP server spawned over stdio. No network, no paid calls.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ezkielyna-mcp.mjs');
// Fake keys are built at runtime so no key-shaped string sits in the source.
const GOOD_KEY = 'sk-' + 'test-good-key-0001';
const ODD_KEY = 'sk-' + 'test-odd-shape-0002';

// Trimmed copy of the public /api/pricing shape (recorded 11 Nov 2026; descriptions removed, one hidden id added for the filter test).
const PRICING = {
  success: true,
  group_ratio: { default: 1, free: 1, media: 1, premium: 1.5, pro: 3 },
  data: [
    { model_name: 'deepseek-v4.1-flash', tags: 'Vision', quota_type: 0, model_ratio: 0.02, model_price: 0, completion_ratio: 4, enable_groups: ['default', 'member'], supported_endpoint_types: ['openai', 'anthropic'] },
    { model_name: 'glm-5.3', tags: 'Vision', quota_type: 0, model_ratio: 0.11220521, model_price: 0, completion_ratio: 3.125, enable_groups: ['default'], supported_endpoint_types: ['openai'] },
    { model_name: 'claude-sonnet-5.5', quota_type: 0, model_ratio: 0.0535, model_price: 0, completion_ratio: 5, enable_groups: ['premium', 'pro'], supported_endpoint_types: ['openai', 'anthropic'] },
    { model_name: 'gpt-image-2.5', tags: 'Image', quota_type: 1, model_ratio: 0, model_price: 0.00207, enable_groups: ['media'], supported_endpoint_types: ['image-generation', 'openai'] },
    { model_name: 'edge-tts', tags: 'TTS', quota_type: 0, model_ratio: 0.5, model_price: 0, completion_ratio: 1, enable_groups: ['default', 'free'], supported_endpoint_types: ['openai', 'openai-audio'] },
    { model_name: 'demo-flash-uncensored', quota_type: 0, model_ratio: 0.1, model_price: 0, completion_ratio: 4, enable_groups: ['default'], supported_endpoint_types: ['openai'] },
  ],
};

let gw;
let base;
const seen = [];
let active = 0;
let maxActive = 0;
let tmp;
const children = [];

function json(res, status, v) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(v));
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ezk-mcp-'));
  gw = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString();
    const rec = { method: req.method, url: req.url, auth: req.headers.authorization };
    seen.push(rec);
    if (req.url === '/api/pricing') return json(res, 200, PRICING);
    const key = (req.headers.authorization || '').replace(/^Bearer /, '');
    if (key === 'sk-wrong-401') return json(res, 401, { error: { message: `invalid token ${key}`, type: 'new_api_error' } });
    if (key === 'sk-broke-402') return json(res, 402, { error: { message: 'insufficient user quota', type: 'new_api_error' } });
    if (key === 'sk-busy-429') return json(res, 429, { error: { message: 'too many requests' } });
    if (key !== GOOD_KEY && key !== ODD_KEY) return json(res, 401, { error: { message: 'bad key' } });
    if (req.url === '/v1/models') {
      return json(res, 200, { object: 'list', data: ['deepseek-v4.1-flash', 'glm-5.3', 'claude-sonnet-5.5', 'gpt-image-2.5', 'edge-tts', 'demo-flash-uncensored', 'mystery-model'].map(id => ({ id, object: 'model' })) });
    }
    if (req.url === '/v1/chat/completions') {
      rec.json = JSON.parse(body);
      const { model } = rec.json;
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise(r => setTimeout(r, 150));
      active--;
      if (model === 'limited-model') return json(res, 403, { error: { message: 'This token has no access to model limited-model', type: 'new_api_error' } });
      if (model === 'broken-model') return json(res, 503, { error: { message: 'no available channel for model broken-model under group default', type: 'new_api_error' } });
      if (model === 'empty-model') {
        return json(res, 200, { model, choices: [{ message: { role: 'assistant', content: '', reasoning_content: 'thinking...' }, finish_reason: 'length' }], usage: { prompt_tokens: 10, completion_tokens: 50, total_tokens: 60 } });
      }
      const prompt = rec.json.messages.at(-1).content;
      return json(res, 200, {
        model,
        choices: [{ message: { role: 'assistant', content: `Answer from ${model}: ${prompt.slice(0, 30)}` }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500, prompt_tokens_details: { cached_tokens: 200 } },
      });
    }
    if (req.url === '/v1/search') {
      rec.json = JSON.parse(body);
      if (rec.json.query === 'nothing') return json(res, 200, { results: [], cached: false });
      if (rec.json.query === 'limit') return json(res, 429, { error: { message: 'rate limited' } });
      const results = Array.from({ length: rec.json.max_results ?? 5 }, (_, i) => (i === 1
        ? { title: `Result ${i + 1}`, url: `https://example.com/${i + 1}`, content: 'content field   snippet', publishedDate: '2026-11-01' }
        : { title: `Result ${i + 1}`, url: `https://example.com/${i + 1}`, snippet: 'snippet text' }));
      return json(res, 200, { results: [...results, { title: 'no url' }], cached: true });
    }
    if (req.url === '/v1/dashboard/billing/subscription') {
      if (key === ODD_KEY) return json(res, 200, { message: 'something else' });
      return json(res, 200, { object: 'billing_subscription', has_payment_method: true, soft_limit_usd: 12.5, hard_limit_usd: 12.5, system_hard_limit_usd: 12.5, access_until: 0 });
    }
    if (req.url.startsWith('/v1/dashboard/billing/usage?')) return json(res, 200, { object: 'list', total_usage: 325.5 });
    json(res, 404, { error: { message: 'not found' } });
  });
  await new Promise(r => gw.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${gw.address().port}`;
});

after(() => {
  for (const c of children) if (c.exitCode === null) c.kill();
  gw.closeAllConnections();
  gw.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// Spawns the MCP server and talks to it line by line.
function startMcp(extraEnv = {}) {
  const child = spawn(process.execPath, [SERVER], {
    env: { PATH: process.env.PATH, HOME: tmp, EZKIELYNA_API_KEY: GOOD_KEY, EZKIELYNA_BASE_URL: `${base}/v1`, ...extraEnv },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.push(child);
  let buf = '';
  let stdout = '';
  let stderr = '';
  let nextId = 1;
  const waiting = new Map();
  child.stdout.on('data', d => {
    stdout += d;
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      const msg = JSON.parse(line); // every stdout line must be JSON-RPC
      waiting.get(msg.id)?.(msg);
      waiting.delete(msg.id);
    }
  });
  child.stderr.on('data', d => { stderr += d; });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 10000);
    waiting.set(id, m => { clearTimeout(t); resolve(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const notify = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  const call = async (name, args) => (await request('tools/call', { name, arguments: args })).result;
  const stop = () => new Promise(r => { child.on('exit', r); child.stdin.end(); });
  return { child, request, notify, call, stop, logs: () => stdout + stderr };
}

async function initialized(env) {
  const mcp = startMcp(env);
  await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  mcp.notify('notifications/initialized');
  return mcp;
}

const textOf = r => r.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
const lastChat = () => seen.filter(s => s.url === '/v1/chat/completions').at(-1);

test('handshake, ping, tools/list with schemas and annotations', async () => {
  const mcp = startMcp();
  const init = await mcp.request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.result.protocolVersion, '2025-03-26');
  assert.equal(init.result.serverInfo.name, 'ezkielyna');
  assert.ok(init.result.capabilities.tools);
  mcp.notify('notifications/initialized');
  assert.deepEqual((await mcp.request('ping')).result, {});
  assert.equal((await mcp.request('initialize', { protocolVersion: '1999-01-01' })).result.protocolVersion, '2025-06-18');
  const { tools } = (await mcp.request('tools/list', {})).result;
  assert.deepEqual(tools.map(t => t.name).sort(), ['ask_model', 'check_balance', 'compare_models', 'list_models', 'web_search']);
  for (const t of tools) {
    assert.equal(t.inputSchema.type, 'object');
    assert.equal(typeof t.annotations.readOnlyHint, 'boolean', t.name);
    assert.equal(t.annotations.openWorldHint, true, t.name);
  }
  assert.equal(tools.find(t => t.name === 'ask_model').annotations.destructiveHint, false);
  assert.equal(tools.find(t => t.name === 'ask_model').inputSchema.properties.max_tokens.maximum, 4096);
  assert.equal((await mcp.request('no/such')).error.code, -32601);
  assert.equal((await mcp.request('tools/call', { name: 'nope', arguments: {} })).error.code, -32602);
  await mcp.stop();
});

test('ask_model sends the default model, system prompt and max_tokens; returns answer, tokens and cost', async () => {
  const mcp = await initialized();
  const r = await mcp.call('ask_model', { prompt: 'Review this function', system: 'Be strict.' });
  assert.ok(!r.isError, textOf(r));
  const t = textOf(r);
  assert.match(t, /^Answer from deepseek-v4\.1-flash: Review this function/);
  assert.match(t, /tokens: 1000 in \+ 500 out = 1500 \(200 cached\)/);
  // 1000 x $0.04/M + 500 x $0.16/M = $0.00012
  assert.match(t, /≈ \$0\.00012 \(list price/);
  assert.match(t, /Session: 1\/50/);
  const req = lastChat();
  assert.equal(req.auth, `Bearer ${GOOD_KEY}`);
  assert.deepEqual(req.json, { model: 'deepseek-v4.1-flash', messages: [{ role: 'system', content: 'Be strict.' }, { role: 'user', content: 'Review this function' }], max_tokens: 1024, stream: false });
  const r2 = await mcp.call('ask_model', { prompt: 'hi', model: 'glm-5.3', max_tokens: 200, temperature: 0.2 });
  assert.ok(!r2.isError, textOf(r2));
  assert.deepEqual([lastChat().json.model, lastChat().json.max_tokens, lastChat().json.temperature], ['glm-5.3', 200, 0.2]);
  assert.equal(lastChat().json.messages.length, 1);
  await mcp.stop();
  assert.ok(!mcp.logs().includes(GOOD_KEY));
});

test('max_tokens is capped (default cap 4096, env EZKIELYNA_MAX_TOKENS lowers it)', async () => {
  const mcp = await initialized();
  const r = await mcp.call('ask_model', { prompt: 'long', max_tokens: 99999 });
  assert.equal(lastChat().json.max_tokens, 4096);
  assert.match(textOf(r), /capped at 4096/);
  const bad = await mcp.call('ask_model', { prompt: 'x', max_tokens: 0 });
  assert.ok(bad.isError);
  await mcp.stop();
  const low = await initialized({ EZKIELYNA_MAX_TOKENS: '100' });
  await low.call('ask_model', { prompt: 'x' });
  assert.equal(lastChat().json.max_tokens, 100);
  await low.stop();
});

test('ask_model explains an empty answer cut off by max_tokens', async () => {
  const mcp = await initialized();
  const r = await mcp.call('ask_model', { prompt: 'x', model: 'empty-model', max_tokens: 50 });
  assert.ok(!r.isError);
  assert.match(textOf(r), /max_tokens ran out during the model's reasoning; raise max_tokens/);
  assert.match(textOf(r), /cut off at max_tokens/);
  await mcp.stop();
});

test('compare_models runs models in parallel and reports a failing model without failing the rest', async () => {
  const mcp = await initialized({ EZKIELYNA_MAX_CALLS: '4' });
  maxActive = 0;
  const r = await mcp.call('compare_models', { prompt: 'Is this SQL safe?', models: ['deepseek-v4.1-flash', 'claude-sonnet-5.5', 'broken-model'] });
  assert.ok(!r.isError, textOf(r));
  const t = textOf(r);
  assert.ok(maxActive >= 2, `requests overlapped (max ${maxActive})`);
  assert.match(t, /## 1\. deepseek-v4\.1-flash\n.*\n\nAnswer from deepseek-v4\.1-flash: Is this SQL safe\?/);
  assert.match(t, /## 2\. claude-sonnet-5\.5\n/);
  // Premium model priced at 1.5x: 1000 x 0.1605/M + 500 x 0.8025/M = 0.00056175
  assert.match(t, /≈ \$0\.000562 /);
  assert.match(t, /## 3\. broken-model\n\nGAGAL \/ FAILED: .*cannot use this model/);
  assert.match(t, /broken-model failed/);
  // The refused call gave its slot back: 2 of 3 used, so one more call fits.
  assert.match(t, /Session: 2\/4/);
  assert.ok(!(await mcp.call('ask_model', { prompt: 'x' })).isError);
  const lim = await mcp.call('ask_model', { prompt: 'x', model: 'limited-model' });
  assert.ok(lim.isError);
  assert.match(textOf(lim), /model limits/);
  await mcp.stop();
});

test('compare_models validates 2-4 distinct models before sending', async () => {
  const mcp = await initialized();
  const before = seen.length;
  for (const models of [['deepseek-v4.1-flash'], ['a', 'a'], ['a', 'b', 'c', 'd', 'e'], 'glm-5.3']) {
    const r = await mcp.call('compare_models', { prompt: 'x', models });
    assert.ok(r.isError, JSON.stringify(models));
    assert.match(textOf(r), /2-4 different model ids/);
  }
  const bad = await mcp.call('compare_models', { prompt: 'x', models: ['ok-model', 'bad model!'] });
  assert.match(textOf(bad), /Invalid model id/);
  const hidden = await mcp.call('ask_model', { prompt: 'x', model: 'demo-flash-uncensored' });
  assert.ok(hidden.isError);
  assert.match(textOf(hidden), /not available through this MCP server/);
  assert.equal(seen.length, before, 'nothing was sent');
  await mcp.stop();
});

test('session cap counts ask_model, each compared model and web_search', async () => {
  const mcp = await initialized({ EZKIELYNA_MAX_CALLS: '3' });
  assert.ok(!(await mcp.call('ask_model', { prompt: 'one' })).isError);
  assert.ok(!(await mcp.call('web_search', { query: 'two' })).isError);
  const before = seen.length;
  const cmp = await mcp.call('compare_models', { prompt: 'x', models: ['a-model', 'b-model'] });
  assert.ok(cmp.isError);
  assert.match(textOf(cmp), /EZKIELYNA_MAX_CALLS.*2 used, 2 needed|2 used, 2 needed/s);
  assert.equal(seen.length, before, 'nothing sent when the cap would be passed');
  assert.ok(!(await mcp.call('ask_model', { prompt: 'three' })).isError);
  const four = await mcp.call('ask_model', { prompt: 'four' });
  assert.ok(four.isError);
  assert.match(textOf(four), /Session limit of 3 calls reached/);
  const bal = await mcp.call('check_balance', {});
  assert.ok(!bal.isError, 'free tools still work at the cap');
  assert.match(textOf(bal), /3\/3/);
  await mcp.stop();
});

test('friendly 401/402/429 errors, key never shown, refused calls do not use the cap', async () => {
  for (const [key, re] of [['sk-wrong-401', /Wrong or inactive API key/], ['sk-broke-402', /Insufficient API balance/], ['sk-busy-429', /busy/]]) {
    const mcp = await initialized({ EZKIELYNA_API_KEY: key, EZKIELYNA_MAX_CALLS: '1' });
    const r = await mcp.call('ask_model', { prompt: 'x' });
    assert.ok(r.isError, key);
    assert.match(textOf(r), re);
    const again = await mcp.call('ask_model', { prompt: 'x' });
    assert.doesNotMatch(textOf(again), /EZKIELYNA_MAX_CALLS/, 'refused call gave its slot back');
    await mcp.stop();
    assert.ok(!mcp.logs().includes(key), `key ${key} leaked`);
  }
});

test('list_models joins /v1/models with public prices and hides filtered ids', async () => {
  const mcp = await initialized();
  const t = textOf(await mcp.call('list_models', {}));
  assert.match(t, /Models this key can use: 6/);
  assert.match(t, /- deepseek-v4\.1-flash \[chat\]: in \$0\.04 \/ out \$0\.16 per 1M tokens/);
  assert.match(t, /- claude-sonnet-5\.5 \[chat\]: in \$0\.1605 \/ out \$0\.8025 per 1M tokens/);
  assert.match(t, /- gpt-image-2\.5 \[image\]: \$0\.00207 per call/);
  assert.match(t, /- edge-tts \[tts\]: \$1 per 1M input characters/);
  assert.match(t, /- mystery-model \[\?\]: harga \/ price/);
  assert.doesNotMatch(t, /uncensored/i);
  assert.ok(t.indexOf('deepseek') < t.indexOf('gpt-image'), 'chat models first');
  const f = textOf(await mcp.call('list_models', { filter: 'tts' }));
  assert.match(f, /: 1\n- edge-tts/);
  const none = await mcp.call('list_models', { filter: 'zzz' });
  assert.ok(!none.isError);
  assert.match(textOf(none), /No model matches "zzz"/);
  await mcp.stop();
});

test('list_models without a key shows the public price list', async () => {
  const mcp = await initialized({ EZKIELYNA_API_KEY: '' });
  const r = await mcp.call('list_models', { filter: 'glm' });
  assert.ok(!r.isError, textOf(r));
  assert.match(textOf(r), /No key set: this is the public price list/);
  assert.match(textOf(r), /glm-5\.3 \[chat\]: in \$0\.2244 \/ out \$0\.7013/);
  await mcp.stop();
});

test('web_search sends the documented body and formats results', async () => {
  const mcp = await initialized();
  const r = await mcp.call('web_search', { query: '  harga emas hari ini ', max_results: 3, time_range: 'week', language: 'id' });
  assert.ok(!r.isError, textOf(r));
  const req = seen.filter(s => s.url === '/v1/search').at(-1);
  assert.deepEqual(req.json, { query: 'harga emas hari ini', max_results: 3, time_range: 'week', language: 'id' });
  assert.equal(req.auth, `Bearer ${GOOD_KEY}`);
  const t = textOf(r);
  assert.match(t, /1\. Result 1\n {3}https:\/\/example\.com\/1\n {3}snippet text/);
  assert.match(t, /2\. Result 2\n {3}https:\/\/example\.com\/2 \(2026-11-01\)\n {3}content field snippet/);
  assert.match(t, /3 hasil \/ results \(cache\)/);
  assert.doesNotMatch(t, /no url/);
  await mcp.call('web_search', { query: 'x', max_results: 50 });
  assert.equal(seen.filter(s => s.url === '/v1/search').at(-1).json.max_results, 10);
  await mcp.call('web_search', { query: 'x' });
  assert.equal(seen.filter(s => s.url === '/v1/search').at(-1).json.max_results, 5);
  assert.match(textOf(await mcp.call('web_search', { query: 'nothing' })), /No results/);
  assert.match(textOf(await mcp.call('web_search', { query: 'limit' })), /rate limit reached/);
  const before = seen.length;
  assert.match(textOf(await mcp.call('web_search', { query: 'x'.repeat(401) })), /1-400 characters/);
  assert.match(textOf(await mcp.call('web_search', { query: 'x', time_range: 'decade' })), /time_range/);
  assert.match(textOf(await mcp.call('web_search', { query: 'x', language: 'id; drop' })), /language/);
  assert.equal(seen.length, before);
  await mcp.stop();
});

test('check_balance reads billing endpoints; odd shapes and errors point to the dashboard', async () => {
  const mcp = await initialized();
  const r = await mcp.call('check_balance', {});
  assert.ok(!r.isError, textOf(r));
  const t = textOf(r);
  assert.match(t, /Reported credit limit: \$12\.5/);
  assert.match(t, /Used: \$3\.255/);
  assert.match(t, /Remaining \(approx\.\): \$9\.245/);
  assert.match(t, /0\/50/);
  assert.ok(seen.some(s => /^\/v1\/dashboard\/billing\/usage\?start_date=\d{4}-\d\d-\d\d&end_date=\d{4}-\d\d-\d\d$/.test(s.url)));
  await mcp.stop();
  const odd = await initialized({ EZKIELYNA_API_KEY: ODD_KEY });
  const o = await odd.call('check_balance', {});
  assert.ok(!o.isError);
  assert.match(textOf(o), /could not be read from the API; open the dashboard: https:\/\/api\.ezkielyna\.store/);
  await odd.stop();
  const wrong = await initialized({ EZKIELYNA_API_KEY: 'sk-wrong-401' });
  const w = await wrong.call('check_balance', {});
  assert.ok(w.isError);
  assert.match(textOf(w), /Wrong or inactive API key/);
  await wrong.stop();
});

test('missing key and unreachable gateway give setup help instead of crashing', async () => {
  const mcp = await initialized({ EZKIELYNA_API_KEY: '' });
  for (const [name, args] of [['ask_model', { prompt: 'x' }], ['compare_models', { prompt: 'x', models: ['a', 'b'] }], ['web_search', { query: 'x' }], ['check_balance', {}]]) {
    const r = await mcp.call(name, args);
    assert.ok(r.isError, name);
    assert.match(textOf(r), /EZKIELYNA_API_KEY/);
  }
  await mcp.stop();
  const down = await initialized({ EZKIELYNA_BASE_URL: 'http://127.0.0.1:9/v1', EZKIELYNA_TIMEOUT_MS: '2000' });
  const r = await down.call('ask_model', { prompt: 'x' });
  assert.ok(r.isError);
  assert.match(textOf(r), /Could not reach the gateway|timed out/);
  const l = await down.call('list_models', {});
  assert.ok(l.isError);
  await down.stop();
  assert.ok(!down.logs().includes(GOOD_KEY));
});
