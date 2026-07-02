'use strict';
// Structured logging + key redaction.

const test = require('node:test');
const assert = require('node:assert');
const { withStack, anthropicReq, postMessages, okChat } = require('./helpers.js');

test('emits one structured JSON summary line per request', async () => {
  await withStack(
    () => okChat('hi'),
    { TOOL_MODE: 'emulated' },
    async (proxy) => {
      await postMessages(proxy.base, anthropicReq('hello'));
      await new Promise(r => setTimeout(r, 100));
      const lines = proxy.getStderr().split('\n').filter(Boolean);
      const summaries = lines.filter(l => {
        try { const o = JSON.parse(l); return o.rid && o.path === '/v1/messages' && typeof o.ms === 'number'; }
        catch (_) { return false; }
      });
      assert.strictEqual(summaries.length, 1, 'exactly one summary line');
      const o = JSON.parse(summaries[0]);
      assert.strictEqual(o.status, 200);
      assert.strictEqual(o.tool_calls, 0);
    }
  );
});

test('the upstream key never appears in any log output', async () => {
  await withStack(
    () => okChat('hi'),
    { TOOL_MODE: 'emulated', PROXY_DEBUG: '1' },
    async (proxy) => {
      await postMessages(proxy.base, anthropicReq('hello'));
      await new Promise(r => setTimeout(r, 100));
      const logs = proxy.getStderr();
      assert.ok(!logs.includes('sk-test-secret-key'), 'API key redacted from logs');
    }
  );
});

test('error responses are also logged with their status', async () => {
  await withStack(
    () => ({ status: 500, json: { error: { message: 'boom' } } }),
    { TOOL_MODE: 'emulated', UPSTREAM_RETRIES: '0' },
    async (proxy) => {
      await postMessages(proxy.base, anthropicReq('hello'));
      await new Promise(r => setTimeout(r, 100));
      const lines = proxy.getStderr().split('\n').filter(Boolean);
      const err = lines.map(l => { try { return JSON.parse(l); } catch (_) { return null; } })
        .find(o => o && o.path === '/v1/messages' && o.status === 500);
      assert.ok(err, 'a 500 summary line was written');
    }
  );
});
