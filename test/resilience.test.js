'use strict';
// Upstream resilience: timeout, transient retry/backoff, hard failure.

const test = require('node:test');
const assert = require('node:assert');
const { withStack, anthropicReq, postMessages, okChat } = require('./helpers.js');

test('a hanging upstream returns 504 within the timeout, not a hang', async () => {
  await withStack(
    (body, i, req, res) => { /* never respond */ return undefined; },
    { TOOL_MODE: 'emulated', UPSTREAM_TIMEOUT_MS: '800', UPSTREAM_RETRIES: '0' },
    async (proxy) => {
      const started = Date.now();
      const { status, json } = await postMessages(proxy.base, anthropicReq('hello'));
      const elapsed = Date.now() - started;
      assert.strictEqual(status, 504);
      assert.strictEqual(json.type, 'error');
      assert.ok(elapsed < 5000, 'returned promptly, not hung (' + elapsed + 'ms)');
    }
  );
});

test('transient 503 twice then 200 succeeds after retry', async () => {
  await withStack(
    (body, i) => i < 2 ? { status: 503, json: { error: { message: 'temporarily unavailable' } } } : okChat('recovered'),
    { TOOL_MODE: 'emulated', UPSTREAM_RETRIES: '2' },
    async (proxy, mock) => {
      const { status, json } = await postMessages(proxy.base, anthropicReq('hello'));
      assert.strictEqual(status, 200);
      assert.strictEqual(json.content[0].text, 'recovered');
      assert.strictEqual(mock.calls.length, 3, 'two retries then success');
    }
  );
});

test('persistent 500 surfaces an error after exhausting retries', async () => {
  await withStack(
    () => ({ status: 500, json: { error: { message: 'boom' } } }),
    { TOOL_MODE: 'emulated', UPSTREAM_RETRIES: '2' },
    async (proxy, mock) => {
      const { status, json } = await postMessages(proxy.base, anthropicReq('hello'));
      assert.strictEqual(status, 500);
      assert.strictEqual(json.type, 'error');
      assert.strictEqual(mock.calls.length, 3, 'initial try + 2 retries');
    }
  );
});

test('429 is treated as transient and retried', async () => {
  await withStack(
    (body, i) => i === 0 ? { status: 429, json: { error: { message: 'rate limited' } } } : okChat('ok now'),
    { TOOL_MODE: 'emulated', UPSTREAM_RETRIES: '2' },
    async (proxy, mock) => {
      const { status } = await postMessages(proxy.base, anthropicReq('hello'));
      assert.strictEqual(status, 200);
      assert.strictEqual(mock.calls.length, 2);
    }
  );
});

test('/ready reports upstream reachability', async () => {
  await withStack(
    (body, i, req, res) => {
      // The /ready probe hits /models on the mock; answer it 200.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'test-model' }] }));
      return undefined;
    },
    { TOOL_MODE: 'emulated' },
    async (proxy) => {
      const r = await fetch(proxy.base + '/ready');
      assert.strictEqual(r.status, 200);
      const json = await r.json();
      assert.strictEqual(json.ready, true);
    }
  );
});
