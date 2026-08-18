// Shim in front of the LiteLLM bridge for Codex.
// GET /models | /v1/models -> Codex-native ModelInfo list (so the desktop picker shows them)
// everything else -> proxied unchanged to the LiteLLM bridge.
const http = require('http');

const UPSTREAM = { host: '127.0.0.1', port: 4000 };
const PORT = 4001;

const fs = require('fs');
let TEMPLATE = null;
try {
  const cache = JSON.parse(fs.readFileSync(process.env.HOME + '/.codex/models_cache.json', 'utf8'));
  TEMPLATE = cache.models.find((m) => m.visibility === 'list') || cache.models[0];
} catch (e) {}

function modelInfo(slug) {
  const base = TEMPLATE ? JSON.parse(JSON.stringify(TEMPLATE)) : {};
  return Object.assign(base, {
    slug,
    display_name: slug,
    description: 'OpenCode Go model',
    default_reasoning_level: 'medium',
    supported_reasoning_levels: [{ effort: 'medium', description: 'Default' }],
    shell_type: 'shell_command',
    visibility: 'list',
    supported_in_api: true,
    priority: 0,
    additional_speed_tiers: [],
    service_tiers: [],
    availability_nux: null,
    upgrade: null,
    base_instructions: undefined,
    is_default: false,
  });
}

function serveModels(req, res) {
  const up = http.request(
    { ...UPSTREAM, path: '/v1/models', headers: { authorization: req.headers.authorization || 'Bearer x' } },
    (r) => {
      let body = '';
      r.on('data', (c) => (body += c));
      r.on('end', () => {
        let models = [];
        try {
          models = JSON.parse(body).data.map((m) => modelInfo(m.id));
        } catch (e) {}
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ models }));
      });
    }
  );
  up.on('error', () => {
    res.writeHead(502);
    res.end('{"error":"bridge unavailable"}');
  });
  up.end();
}

http
  .createServer((req, res) => {
    const path = req.url.split('?')[0];
    console.log(new Date().toISOString(), req.method, req.url);
    if (req.method === 'GET' && (path === '/models' || path === '/v1/models')) return serveModels(req, res);
    const up = http.request(
      { ...UPSTREAM, path: req.url, method: req.method, headers: { ...req.headers, host: `${UPSTREAM.host}:${UPSTREAM.port}` } },
      (r) => {
        res.writeHead(r.statusCode, r.headers);
        r.pipe(res);
      }
    );
    up.on('error', () => {
      res.writeHead(502);
      res.end('{"error":"bridge unavailable"}');
    });
    req.pipe(up);
  })
  .listen(PORT, '127.0.0.1');
