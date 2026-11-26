'use strict';

const http = require('node:http');
const fs = require('node:fs');

const MAX_BODY_BYTES = 64 * 1024;
const TENANT_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const SEVERITIES = new Set(['debug', 'info', 'notice', 'warning', 'error', 'critical']);
const EVENT_ROUTE = /^\/v1\/tenant\/([^/]+)\/events$/;

function config(env = process.env) {
  return {
    host: env.HOST || '127.0.0.1',
    port: Number(env.PORT || 3000),
    opensearchUrl: env.OPENSEARCH_URL || 'http://127.0.0.1:9200',
    eventLog: env.WATCHSOC_EVENT_LOG || '/var/log/watchsoc-ingest.log',
    healthTimeoutMs: Number(env.HEALTH_TIMEOUT_MS || 2000),
  };
}

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        const err = new Error('payload too large');
        err.status = 413;
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function validateEvent(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return 'body must be a JSON object';
  }
  if (typeof body.event_type !== 'string' || body.event_type.length === 0 || body.event_type.length > 128) {
    return 'event_type must be a non-empty string up to 128 characters';
  }
  if (typeof body.message !== 'string' || body.message.length === 0 || body.message.length > 4096) {
    return 'message must be a non-empty string up to 4096 characters';
  }
  if (body.severity !== undefined && !SEVERITIES.has(body.severity)) {
    return 'severity must be one of: ' + [...SEVERITIES].join(', ');
  }
  if (body.source !== undefined && (typeof body.source !== 'string' || body.source.length > 256)) {
    return 'source must be a string up to 256 characters';
  }
  if (body.fields !== undefined && (body.fields === null || typeof body.fields !== 'object' || Array.isArray(body.fields))) {
    return 'fields must be a JSON object';
  }
  return null;
}

async function opensearchHealth(cfg) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), cfg.healthTimeoutMs);
  try {
    const resp = await fetch(`${cfg.opensearchUrl}/_cluster/health`, { signal: ctl.signal });
    if (!resp.ok) {
      return { ok: false, status: `http_${resp.status}` };
    }
    const data = await resp.json();
    return { ok: data.status === 'green' || data.status === 'yellow', status: data.status };
  } catch (err) {
    return { ok: false, status: err.name === 'AbortError' ? 'timeout' : 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

function writeEvent(cfg, tenant, event) {
  const record = {
    ts: new Date().toISOString(),
    tenant,
    event_type: event.event_type,
    severity: event.severity || 'info',
    source: event.source || 'api',
    message: event.message,
    fields: event.fields || {},
  };
  return new Promise((resolve, reject) => {
    fs.appendFile(cfg.eventLog, JSON.stringify(record) + '\n', { mode: 0o640 }, (err) => {
      if (err) reject(err);
      else resolve(record);
    });
  });
}

function createServer(cfg = config()) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (req.method === 'GET' && url.pathname === '/healthz') {
        const os = await opensearchHealth(cfg);
        return send(res, os.ok ? 200 : 503, { status: os.ok ? 'ok' : 'degraded', opensearch: os.status });
      }

      const match = EVENT_ROUTE.exec(url.pathname);
      if (match) {
        if (req.method !== 'POST') {
          res.setHeader('Allow', 'POST');
          return send(res, 405, { error: 'method not allowed' });
        }
        const tenant = match[1];
        if (!TENANT_RE.test(tenant)) {
          return send(res, 400, { error: 'invalid tenant id' });
        }
        const type = (req.headers['content-type'] || '').split(';')[0].trim();
        if (type !== 'application/json') {
          return send(res, 415, { error: 'content-type must be application/json' });
        }
        let body;
        try {
          body = JSON.parse(await readBody(req));
        } catch (err) {
          if (err.status === 413) return send(res, 413, { error: err.message });
          return send(res, 400, { error: 'invalid JSON' });
        }
        const problem = validateEvent(body);
        if (problem) return send(res, 422, { error: problem });
        const record = await writeEvent(cfg, tenant, body);
        return send(res, 202, { accepted: true, tenant, ts: record.ts });
      }

      return send(res, 404, { error: 'not found' });
    } catch (err) {
      console.error(JSON.stringify({ level: 'error', msg: err.message }));
      return send(res, 500, { error: 'internal error' });
    }
  });
}

if (require.main === module) {
  const cfg = config();
  const server = createServer(cfg);
  server.listen(cfg.port, cfg.host, () => {
    console.log(JSON.stringify({ level: 'info', msg: 'listening', host: cfg.host, port: cfg.port }));
  });
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

module.exports = { createServer, config, validateEvent };
