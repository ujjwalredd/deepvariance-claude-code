'use strict';
// True streaming: token-by-token SSE with tool-call hold-back.

const test = require('node:test');
const assert = require('node:assert');
const { withStack, anthropicReq } = require('./helpers.js');

// A mock upstream that answers /chat/completions with OpenAI-style SSE chunks.
// `chunks` is an array of content strings streamed as delta events.
function sseMock(chunks, opts) {
  return (body, i, req, res) => {
    if ((opts && opts.status) && (opts.status !== 200)) {
      res.writeHead(opts.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: opts.message || 'no stream' } }));
      return undefined;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    for (const c of chunks) {
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: c } }] }) + '\n\n');
    }
    res.write('data: [DONE]\n\n');
    res.end();
    return undefined;
  };
}

async function streamRequest(base, body) {
  const r = await fetch(base + '/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({ stream: true }, body)),
  });
  const text = await r.text();
  return { status: r.status, ctype: r.headers.get('content-type') || '', text };
}

function textDeltas(sse) {
  const out = [];
  for (const line of sse.split('\n')) {
    const l = line.trim();
    if (!l.startsWith('data:')) continue;
    try {
      const o = JSON.parse(l.slice(5).trim());
      if (o.type === 'content_block_delta' && o.delta && o.delta.type === 'text_delta') out.push(o.delta.text);
    } catch (_) {}
  }
  return out;
}

function toolUseBlocks(sse) {
  const out = [];
  for (const line of sse.split('\n')) {
    const l = line.trim();
    if (!l.startsWith('data:')) continue;
    try {
      const o = JSON.parse(l.slice(5).trim());
      if (o.type === 'content_block_start' && o.content_block && o.content_block.type === 'tool_use') out.push(o.content_block);
    } catch (_) {}
  }
  return out;
}

const BASH = { name: 'Bash', input_schema: { type: 'object' } };

test('long plain text streams as multiple text_delta events and reassembles', async () => {
  const chunks = ['Hello ', 'there, ', 'this is ', 'a long ', 'streamed answer.'];
  await withStack(sseMock(chunks), { TOOL_MODE: 'emulated' }, async (proxy) => {
    const { status, ctype, text } = await streamRequest(proxy.base, anthropicReq('hi'));
    assert.strictEqual(status, 200);
    assert.ok(ctype.includes('event-stream'));
    const deltas = textDeltas(text);
    assert.ok(deltas.length >= 2, 'more than one delta (' + deltas.length + ')');
    assert.strictEqual(deltas.join(''), chunks.join(''));
    assert.ok(text.includes('event: message_stop'));
  });
});

test('text then <tool_call>: prose streams, tool_use emitted, tag never leaks', async () => {
  const chunks = ['Let me check. ', '<tool_call>', '{"name":"Bash","arguments":{"command":"ls"}}', '</tool_call>'];
  await withStack(sseMock(chunks), { TOOL_MODE: 'emulated' }, async (proxy) => {
    const { text } = await streamRequest(proxy.base, anthropicReq('list', { tools: [BASH] }));
    const deltas = textDeltas(text).join('');
    assert.ok(deltas.includes('Let me check.'), 'prose streamed');
    assert.ok(!deltas.includes('<tool_call'), 'tag not leaked as text');
    assert.ok(!deltas.includes('"name":"Bash"'), 'tool JSON not leaked as text');
    const tools = toolUseBlocks(text);
    assert.strictEqual(tools.length, 1);
    assert.strictEqual(tools[0].name, 'Bash');
    assert.ok(text.includes('"stop_reason":"tool_use"'));
  });
});

test('streamed prose before a tool call is not duplicated as a residual block', async () => {
  const chunks = ['Streaming ', 'works ', 'token by token. ', '<tool_call>', '{"name":"Bash","arguments":{"command":"ls"}}', '</tool_call>'];
  await withStack(sseMock(chunks), { TOOL_MODE: 'emulated' }, async (proxy) => {
    const { text } = await streamRequest(proxy.base, anthropicReq('list', { tools: [BASH] }));
    const full = textDeltas(text).join('');
    // The prose appears exactly once (streamed), not again as a trailing block.
    const occurrences = full.split('Streaming works token by token.').length - 1;
    assert.strictEqual(occurrences, 1, 'prose emitted exactly once');
    assert.strictEqual(toolUseBlocks(text).length, 1);
  });
});

test('pure tool call at the very start emits no text and one tool_use', async () => {
  const chunks = ['<tool_call>{"name":"Bash","arguments":{"command":"pwd"}}</tool_call>'];
  await withStack(sseMock(chunks), { TOOL_MODE: 'emulated' }, async (proxy) => {
    const { text } = await streamRequest(proxy.base, anthropicReq('where', { tools: [BASH] }));
    assert.strictEqual(textDeltas(text).join(''), '', 'no text leaked');
    assert.strictEqual(toolUseBlocks(text).length, 1);
  });
});

test('marker split across chunks is still held back (no leak)', async () => {
  const chunks = ['ok ', '<tool_', 'call>', '{"name":"Bash","arguments":{"command":"ls"}}', '</tool_call>'];
  await withStack(sseMock(chunks), { TOOL_MODE: 'emulated' }, async (proxy) => {
    const { text } = await streamRequest(proxy.base, anthropicReq('list', { tools: [BASH] }));
    const deltas = textDeltas(text).join('');
    assert.ok(!deltas.includes('<tool_'), 'split marker not leaked');
    assert.strictEqual(toolUseBlocks(text).length, 1);
  });
});

test('code fence in a plain answer is preserved while streaming', async () => {
  const chunks = ['Here:\n', '```js\n', 'const x = 1;\n', '```\n', 'done'];
  await withStack(sseMock(chunks), { TOOL_MODE: 'emulated' }, async (proxy) => {
    const { text } = await streamRequest(proxy.base, anthropicReq('show', { tools: [BASH] }));
    const full = textDeltas(text).join('');
    assert.ok(full.includes('```js'), 'fence opener kept');
    assert.ok(full.includes('const x = 1;'));
    assert.ok(full.includes('done'));
    assert.strictEqual(toolUseBlocks(text).length, 0);
  });
});

test('backend that cannot stream falls back to a valid buffered SSE', async () => {
  // 200 but plain JSON (ignores stream:true) -> proxy detects + buffers.
  await withStack(
    () => ({ status: 200, json: { choices: [{ message: { content: 'buffered answer' } }], usage: { prompt_tokens: 3, completion_tokens: 2 } } }),
    { TOOL_MODE: 'emulated' },
    async (proxy) => {
      const { status, ctype, text } = await streamRequest(proxy.base, anthropicReq('hi'));
      assert.strictEqual(status, 200);
      assert.ok(ctype.includes('event-stream'));
      assert.ok(textDeltas(text).join('').includes('buffered answer'));
    }
  );
});
