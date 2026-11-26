'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../server');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function request(port, method, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function fakeOpenSearch(status) {
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status }));
  });
  const port = await listen(srv);
  return { srv, url: `http://127.0.0.1:${port}` };
}

test('ingest API', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchsoc-'));
  const eventLog = path.join(dir, 'events.log');
  const yellow = await fakeOpenSearch('yellow');
  const red = await fakeOpenSearch('red');

  const api = createServer({ opensearchUrl: yellow.url, eventLog, healthTimeoutMs: 500 });
  const apiRed = createServer({ opensearchUrl: red.url, eventLog, healthTimeoutMs: 500 });
  const apiDown = createServer({ opensearchUrl: 'http://127.0.0.1:1', eventLog, healthTimeoutMs: 500 });
  const port = await listen(api);
  const portRed = await listen(apiRed);
  const portDown = await listen(apiDown);

  t.after(() => [api, apiRed, apiDown, yellow.srv, red.srv].forEach((s) => s.close()));
  const json = { 'Content-Type': 'application/json' };

  await t.test('healthz is 200 on yellow', async () => {
    const r = await request(port, 'GET', '/healthz');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.opensearch, 'yellow');
  });

  await t.test('healthz is 503 on red', async () => {
    const r = await request(portRed, 'GET', '/healthz');
    assert.strictEqual(r.status, 503);
  });

  await t.test('healthz is 503 when OpenSearch is unreachable', async () => {
    const r = await request(portDown, 'GET', '/healthz');
    assert.strictEqual(r.status, 503);
    assert.strictEqual(r.body.opensearch, 'unreachable');
  });

  await t.test('valid event is accepted and written as JSON line', async () => {
    const payload = JSON.stringify({ event_type: 'auth_failure', message: 'bad password for root', severity: 'warning' });
    const r = await request(port, 'POST', '/v1/tenant/acme/events', payload, json);
    assert.strictEqual(r.status, 202);
    const lines = fs.readFileSync(eventLog, 'utf8').trim().split('\n');
    const rec = JSON.parse(lines[lines.length - 1]);
    assert.strictEqual(rec.tenant, 'acme');
    assert.strictEqual(rec.event_type, 'auth_failure');
    assert.strictEqual(rec.severity, 'warning');
  });

  await t.test('bad tenant id is rejected', async () => {
    const r = await request(port, 'POST', '/v1/tenant/Bad..Tenant/events', '{}', json);
    assert.strictEqual(r.status, 400);
  });

  await t.test('invalid JSON is rejected', async () => {
    const r = await request(port, 'POST', '/v1/tenant/acme/events', '{nope', json);
    assert.strictEqual(r.status, 400);
  });

  await t.test('schema violations return 422', async () => {
    const r = await request(port, 'POST', '/v1/tenant/acme/events', JSON.stringify({ event_type: 'x' }), json);
    assert.strictEqual(r.status, 422);
    const r2 = await request(port, 'POST', '/v1/tenant/acme/events',
      JSON.stringify({ event_type: 'x', message: 'y', severity: 'loud' }), json);
    assert.strictEqual(r2.status, 422);
  });

  await t.test('wrong content type returns 415', async () => {
    const r = await request(port, 'POST', '/v1/tenant/acme/events', '{}', { 'Content-Type': 'text/plain' });
    assert.strictEqual(r.status, 415);
  });

  await t.test('GET on events route returns 405', async () => {
    const r = await request(port, 'GET', '/v1/tenant/acme/events');
    assert.strictEqual(r.status, 405);
  });

  await t.test('oversized body returns 413', async () => {
    const big = JSON.stringify({ event_type: 'x', message: 'y'.repeat(70 * 1024) });
    const r = await request(port, 'POST', '/v1/tenant/acme/events', big, json).catch((e) => ({ status: e.code }));
    assert.ok(r.status === 413 || r.status === 'ECONNRESET' || r.status === 'EPIPE');
  });

  await t.test('unknown path returns 404', async () => {
    const r = await request(port, 'GET', '/nope');
    assert.strictEqual(r.status, 404);
  });
});
