'use strict';
process.env.PROXY_TEST = '1';

const test = require('node:test');
const assert = require('node:assert');
const proxy = require('../lib/proxy.js');

function msg(role, chars, extra) {
  return Object.assign({ role, content: 'x'.repeat(chars) }, extra || {});
}

test('returns messages unchanged when under budget', () => {
  const msgs = [msg('system', 100), msg('user', 100)];
  assert.deepStrictEqual(proxy.trimToBudget(msgs, 1000), msgs);
});

test('preserves system and most recent message, drops oldest first', () => {
  const msgs = [
    msg('system', 400),
    msg('user', 4000),
    msg('assistant', 4000),
    msg('user', 400),
  ];
  const out = proxy.trimToBudget(msgs, 400); // ~1600 tok total, budget 400
  assert.strictEqual(out[0].role, 'system');
  assert.strictEqual(out[out.length - 1].role, 'user');
  assert.strictEqual(out[out.length - 1].content.length, 400, 'most recent kept');
  assert.ok(out.length < msgs.length, 'old history dropped');
});

test('regression: dropping an assistant tool_calls message drops its tool results too', () => {
  const msgs = [
    msg('system', 100),
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'Bash', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'y'.repeat(4000) },
    msg('user', 100),
  ];
  const out = proxy.trimToBudget(msgs, 200);
  assert.ok(!out.some(m => m.role === 'tool'), 'no orphaned tool message');
  assert.strictEqual(out[0].role, 'system');
  assert.strictEqual(out[out.length - 1].role, 'user');
});

test('never emits a message list starting the history with a tool role', () => {
  const msgs = [
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'Bash', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'y'.repeat(2000) },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c2', type: 'function', function: { name: 'Read', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c2', content: 'z'.repeat(2000) },
    msg('user', 100),
  ];
  const out = proxy.trimToBudget(msgs, 600);
  assert.notStrictEqual(out[0].role, 'tool', 'history must not open with a tool result');
});

test('hard-truncates the longest message when dropping is not enough', () => {
  const msgs = [msg('system', 40000), msg('user', 200)];
  const out = proxy.trimToBudget(msgs, 2000);
  assert.ok(out[0].content.length < 40000, 'longest message truncated');
  assert.ok(out[0].content.includes('[trimmed to fit model context]'));
  assert.ok(proxy.totalTokens(out) <= 2100, 'close to budget');
});

test('hard-truncate terminates on tiny budgets', () => {
  const msgs = [msg('system', 5000), msg('user', 5000)];
  const out = proxy.trimToBudget(msgs, 10); // impossible budget: must not hang
  assert.ok(Array.isArray(out));
});
