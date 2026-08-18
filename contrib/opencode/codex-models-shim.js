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
