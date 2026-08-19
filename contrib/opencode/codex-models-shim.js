// Shim in front of the LiteLLM bridge for Codex.
// GET /models | /v1/models -> merged catalog: ChatGPT subscription models + OpenCode Go models
// POST /responses           -> routed per model: ChatGPT-catalog slugs go to the ChatGPT
//                              backend with the user's subscription tokens (from
//                              ~/.codex/auth.json, refreshed by the app itself);
//                              everything else proxied to the LiteLLM bridge.
const http = require('http');
const https = require('https');
const fs = require('fs');

const UPSTREAM = { host: '127.0.0.1', port: 4000 };
const PORT = 4001;
const CHATGPT_HOST = 'chatgpt.com';
const CHATGPT_BASE = '/backend-api/codex';
const CLIENT_VERSION = '0.148.0';

function log(...a) {
  console.log(new Date().toISOString(), ...a);
}

function chatgptAuth() {
  try {
    const a = JSON.parse(fs.readFileSync(process.env.HOME + '/.codex/auth.json', 'utf8'));
    return { token: a.tokens.access_token, account: a.tokens.account_id };
  } catch (e) {
    return null;
  }
}

function chatgptHeaders(extra) {
  const auth = chatgptAuth();
  if (!auth) return null;
  return Object.assign(
    {
      authorization: `Bearer ${auth.token}`,
      'chatgpt-account-id': auth.account,
      'openai-beta': 'responses=experimental',
      originator: 'codex_cli_rs',
      'user-agent': `codex_cli_rs/${CLIENT_VERSION}`,
      accept: 'text/event-stream',
      'content-type': 'application/json',
    },
    extra || {}
  );
}

// ---- ChatGPT catalog (cached in memory) ----
let gptCatalog = { at: 0, models: [] };
const GPT_TTL_MS = 5 * 60 * 1000;

function fetchGptCatalog() {
  return new Promise((resolve) => {
    if (Date.now() - gptCatalog.at < GPT_TTL_MS) return resolve(gptCatalog.models);
    const headers = chatgptHeaders({ accept: 'application/json' });
    if (!headers) return resolve(gptCatalog.models);
    const req = https.request(
      { host: CHATGPT_HOST, path: `${CHATGPT_BASE}/models?client_version=${CLIENT_VERSION}`, headers },
      (r) => {
        let body = '';
        r.on('data', (c) => (body += c));
        r.on('end', () => {
          try {
            const models = JSON.parse(body).models || [];
            if (models.length) gptCatalog = { at: Date.now(), models };
            log('chatgpt catalog:', r.statusCode, models.length, 'models');
          } catch (e) {
            log('chatgpt catalog parse failed:', r.statusCode);
          }
          resolve(gptCatalog.models);
        });
      }
    );
    req.on('error', (e) => {
      log('chatgpt catalog error:', e.message);
      resolve(gptCatalog.models);
    });
    req.end();
  });
}

function gptSlugs() {
  return new Set(gptCatalog.models.map((m) => m.slug));
}

// ---- OpenCode catalog ----
const FAMILY = [
  [/^minimax/, 'MiniMax', 10],
  [/^kimi/, 'Kimi', 20],
  [/^glm/, 'GLM', 30],
  [/^deepseek/, 'DeepSeek', 40],
  [/^qwen/, 'Qwen', 50],
  [/^mimo/, 'MiMo', 60],
  [/^hy/, 'Hunyuan', 70],
  [/^gpt/, 'OpenAI', 80],
  [/^grok/, 'xAI', 90],
];
function pretty(slug) {
  const fam = FAMILY.find(([re]) => re.test(slug));
  const name = slug
    .replace(/-/g, ' ')
    .replace(/\b([a-z])/g, (c) => c.toUpperCase())
    .replace(/\bGlm\b/i, 'GLM')
    .replace(/\bHy(\d)/i, 'Hunyuan $1')
    .replace(/\bMimo\b/i, 'MiMo')
    .replace(/\bGpt\b/i, 'GPT')
    .replace(/\bMinimax\b/i, 'MiniMax');
  return { name, family: fam ? fam[1] : 'OpenCode', prio: fam ? fam[2] : 99 };
}

function template() {
  const m = gptCatalog.models.find((x) => x.visibility === 'list');
  if (m) return m;
  try {
    const cache = JSON.parse(fs.readFileSync(process.env.HOME + '/.codex/models_cache.json', 'utf8'));
    return cache.models.find((x) => x.visibility === 'list') || cache.models[0] || {};
  } catch (e) {
    return {};
  }
}

function opencodeModelInfo(slug, tmpl) {
  const base = JSON.parse(JSON.stringify(tmpl));
  const p = pretty(slug);
  return Object.assign(base, {
    slug,
    display_name: p.name,
    description: p.family + ' via OpenCode Go',
    default_reasoning_level: 'medium',
    supported_reasoning_levels: [
      { effort: 'low', description: 'Fast responses with lighter reasoning' },
      { effort: 'medium', description: 'Balances speed and reasoning depth for everyday tasks' },
      { effort: 'high', description: 'Greater reasoning depth for complex problems' },
      { effort: 'xhigh', description: 'Extra high reasoning depth for complex problems' },
      { effort: 'max', description: 'Maximum reasoning depth for the hardest problems' },
    ],
    shell_type: 'shell_command',
    visibility: 'list',
    supported_in_api: true,
    priority: 500 + p.prio,
    additional_speed_tiers: [],
    service_tiers: [],
    availability_nux: null,
    upgrade: null,
    base_instructions: undefined,
    is_default: false,
  });
}

function serveModels(req, res) {
  fetchGptCatalog().then((gpt) => {
    const up = http.request(
      { ...UPSTREAM, path: '/v1/models', headers: { authorization: req.headers.authorization || 'Bearer x' } },
      (r) => {
        let body = '';
        r.on('data', (c) => (body += c));
        r.on('end', () => {
          let oc = [];
          try {
            const tmpl = template();
            const taken = new Set(gpt.map((m) => m.slug));
            oc = JSON.parse(body)
              .data.filter((m) => !taken.has(m.id))
              .map((m) => opencodeModelInfo(m.id, tmpl));
            oc.sort((a, b) => pretty(a.slug).prio - pretty(b.slug).prio || a.slug.localeCompare(b.slug));
          } catch (e) {
            log('opencode catalog error:', e.message);
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ models: [...gpt, ...oc] }));
        });
      }
    );
    up.on('error', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ models: gpt }));
    });
    up.end();
  });
}


// ---- Combined limits view ----
function fetchJson(mod, opts) {
  return new Promise((resolve) => {
    const req = mod.request(opts, (r) => {
      let b = '';
      r.on('data', (c) => (b += c));
      r.on('end', () => {
        try { resolve({ status: r.statusCode, json: JSON.parse(b) }); }
        catch (e) { resolve({ status: r.statusCode, json: null, raw: b.slice(0, 200) }); }
      });
    });
    req.on('error', (e) => resolve({ error: e.message }));
    req.end();
  });
}

async function getLimits() {
  const ocKey = process.env.OPENCODE_API_KEY || '';
  const [oc, gpt] = await Promise.all([
    fetchJson(https, { host: 'opencode.ai', path: '/zen/go/v1/usage', headers: { authorization: `Bearer ${ocKey}` } }),
    (() => {
      const h = chatgptHeaders({ accept: 'application/json' });
      return h ? fetchJson(https, { host: CHATGPT_HOST, path: '/backend-api/wham/usage', headers: h }) : Promise.resolve({ error: 'no chatgpt auth' });
    })(),
  ]);
  return { opencode: oc, chatgpt: gpt, at: new Date().toISOString() };
}

function bar(pct, label, sub) {
  const c = pct >= 90 ? '#e5534b' : pct >= 70 ? '#d4a72c' : '#57ab5a';
  return `<div style="margin:10px 0"><div style="display:flex;justify-content:space-between"><span>${label}</span><span>${pct}% ${sub || ''}</span></div>
<div style="background:#333;border-radius:6px;height:8px;overflow:hidden"><div style="width:${Math.min(100, pct)}%;background:${c};height:100%"></div></div></div>`;
}

function fmtReset(iso) {
  try { const d = new Date(iso); const h = Math.round((d - Date.now()) / 3600000); return h >= 48 ? `resets in ${Math.round(h / 24)}d` : `resets in ${h}h`; } catch (e) { return ''; }
}

function serveLimits(req, res, asJson) {
  getLimits().then((data) => {
    if (asJson) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(data, null, 2));
    }
    let oc = '<p>unavailable</p>';
    const u = data.opencode?.json?.usage;
    if (u) oc = ['rolling', 'weekly', 'monthly'].filter((k) => u[k]).map((k) => bar(u[k].percent, k[0].toUpperCase() + k.slice(1), fmtReset(u[k].resetsAt))).join('');
    let gpt = '<p>unavailable</p>';
    const g = data.chatgpt?.json;
    if (g?.rate_limit) {
      const pw = g.rate_limit.primary_window;
      const days = pw ? Math.round(pw.limit_window_seconds / 86400) : 0;
      gpt = `<p style="color:#999">Plan: ${g.plan_type}${g.rate_limit.limit_reached ? ' - LIMIT REACHED' : ''}</p>`;
      if (pw) gpt += bar(pw.used_percent, `${days}-day window`, fmtReset(new Date(pw.reset_at * 1000).toISOString()));
      const sw = g.rate_limit.secondary_window;
      if (sw) gpt += bar(sw.used_percent, `${Math.round(sw.limit_window_seconds / 3600)}h window`, fmtReset(new Date(sw.reset_at * 1000).toISOString()));
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="60">
<title>Provider limits</title>
<body style="background:#1c1c1e;color:#ddd;font:14px/1.5 system-ui;max-width:560px;margin:2rem auto;padding:0 1rem">
<h2 style="font-weight:600">OpenCode Go</h2>${oc}
<h2 style="font-weight:600;margin-top:2rem">ChatGPT subscription</h2>${gpt}
<p style="color:#666;margin-top:2rem">Updated ${data.at.slice(11, 19)} UTC - auto-refreshes every 60s - <a href="/limits.json" style="color:#888">raw JSON</a></p></body>`);
  });
}

// ---- Request routing ----
function forwardToChatGpt(req, res, bodyBuf, path) {
  const headers = chatgptHeaders();
  if (!headers) {
    res.writeHead(401);
    return res.end('{"error":"no chatgpt auth"}');
  }
  for (const h of ['session_id', 'openai-beta', 'accept-language']) {
    if (req.headers[h]) headers[h] = req.headers[h];
  }
  headers['content-length'] = Buffer.byteLength(bodyBuf);
  const up = https.request({ host: CHATGPT_HOST, path: `${CHATGPT_BASE}${path}`, method: req.method, headers }, (r) => {
    log('chatgpt', path, '->', r.statusCode);
    res.writeHead(r.statusCode, r.headers);
    r.pipe(res);
  });
  up.on('error', (e) => {
    log('chatgpt forward error:', e.message);
    res.writeHead(502);
    res.end('{"error":"chatgpt backend unavailable"}');
  });
  up.end(bodyBuf);
}

function forwardToBridge(req, res, bodyBuf) {
  const headers = { ...req.headers, host: `${UPSTREAM.host}:${UPSTREAM.port}` };
  if (bodyBuf) headers['content-length'] = Buffer.byteLength(bodyBuf);
  const up = http.request({ ...UPSTREAM, path: req.url, method: req.method, headers }, (r) => {
    res.writeHead(r.statusCode, r.headers);
    r.pipe(res);
  });
  up.on('error', () => {
    res.writeHead(502);
    res.end('{"error":"bridge unavailable"}');
  });
  if (bodyBuf) up.end(bodyBuf);
  else req.pipe(up);
}

http
  .createServer((req, res) => {
    const path = req.url.split('?')[0];
    log(req.method, req.url);
    if (req.method === 'GET' && (path === '/models' || path === '/v1/models')) return serveModels(req, res);
    if (req.method === 'GET' && path === '/limits') return serveLimits(req, res, false);
    if (req.method === 'GET' && path === '/limits.json') return serveLimits(req, res, true);
    if (req.method === 'POST' && (path === '/responses' || path === '/v1/responses')) {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const bodyBuf = Buffer.concat(chunks);
        let model = null;
        try {
          model = JSON.parse(bodyBuf.toString()).model;
        } catch (e) {}
        if (model && gptSlugs().has(model)) return forwardToChatGpt(req, res, bodyBuf, '/responses');
        return forwardToBridge(req, res, bodyBuf);
      });
      return;
    }
    return forwardToBridge(req, res, null);
  })
  .listen(PORT, '127.0.0.1');

fetchGptCatalog();
