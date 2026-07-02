'use strict';
// End-to-end tests: real proxy child process against a scripted mock upstream.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PROXY_JS = path.join(__dirname, '..', 'lib', 'proxy.js');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

// Mock OpenAI-compatible upstream. `script` gets (requestBody, callIndex)
// and returns { status, json }.
async function startMock(script) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', c => { data += c; });
    req.on('end', () => {
      const body = JSON.parse(data || '{}');
      calls.push(body);
      const out = script(body, calls.length - 1);
      res.writeHead(out.status || 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out.json));
    });
  });
  const port = await freePort();
  await new Promise(r => server.listen(port, '127.0.0.1', r));
  return { server, calls, base: 'http://127.0.0.1:' + port + '/v1' };
}

async function startProxy(upstreamBase, envExtra) {
  const port = await freePort();
  const proc = spawn(process.execPath, [PROXY_JS], {
    env: Object.assign({}, process.env, {
      UPSTREAM_BASE: upstreamBase,
      UPSTREAM_KEY: 'test-key',
      UPSTREAM_MODEL: 'test-model',
      USER_EMAIL: 'test@example.com',
      PORT: String(port),
      PROXY_TEST: '', // run as a real server
    }, envExtra || {}),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  proc.stderr.on('data', c => { stderr += c; });

  const base = 'http://127.0.0.1:' + port;
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(base + '/health');
      if (r.ok) return { proc, base, getStderr: () => stderr };
    } catch (_) {}
    if (proc.exitCode !== null) break;
    await new Promise(r => setTimeout(r, 100));
  }
  proc.kill();
  throw new Error('proxy failed to start: ' + stderr);
}

async function withStack(script, envExtra, fn) {
  const mock = await startMock(script);
  let proxy;
  try {
    proxy = await startProxy(mock.base, envExtra);
    await fn(proxy.base, mock);
  } finally {
    if (proxy) proxy.proc.kill();
    mock.server.close();
  }
}

function ok(content, extra) {
  return { status: 200, json: {
    choices: [{ message: Object.assign({ content }, extra || {}) }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  } };
}

const BASH_TOOL = { name: 'Bash', description: 'run a command', input_schema: { type: 'object', properties: { command: { type: 'string' } } } };

function anthropicReq(userText, opts) {
  return Object.assign({
    model: 'claude-test',
    max_tokens: 1024,
    messages: [{ role: 'user', content: userText }],
  }, opts || {});
}

async function postMessages(base, body) {
  const r = await fetch(base + '/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json() };
}

test('plain answer round-trip keeps code fences (emulated)', async () => {
  await withStack(
    () => ok('Here is the fix:\n```js\nconst x = 1;\n```\nDone.'),
    { TOOL_MODE: 'emulated' },
    async (base, mock) => {
      const { status, json } = await postMessages(base, anthropicReq('say hello', { tools: [BASH_TOOL] }));
      assert.strictEqual(status, 200);
      assert.strictEqual(json.type, 'message');
      assert.strictEqual(json.stop_reason, 'end_turn');
      assert.ok(json.content[0].text.includes('```js'), 'code fence survives the proxy');
      assert.ok(json.content[0].text.includes('const x = 1;'));

      const upstream = mock.calls[0];
      assert.strictEqual(upstream.model, 'test-model');
      assert.strictEqual(upstream.tools, undefined, 'emulated mode sends no tools param');
      assert.ok(upstream.messages[0].role === 'system' && upstream.messages[0].content.includes('<tools>'), 'Hermes tool prompt injected');
    }
  );
});

test('emulated <tool_call> becomes an Anthropic tool_use block', async () => {
  await withStack(
    () => ok('<tool_call>\n{"name":"Bash","arguments":{"command":"ls"}}\n</tool_call>'),
    { TOOL_MODE: 'emulated' },
    async (base) => {
      const { status, json } = await postMessages(base, anthropicReq('list files', { tools: [BASH_TOOL] }));
      assert.strictEqual(status, 200);
      assert.strictEqual(json.stop_reason, 'tool_use');
      const toolUse = json.content.find(b => b.type === 'tool_use');
      assert.ok(toolUse, 'tool_use block present');
      assert.strictEqual(toolUse.name, 'Bash');
      assert.deepStrictEqual(toolUse.input, { command: 'ls' });
    }
  );
});

test('native mode forwards tools and maps tool_calls back', async () => {
  await withStack(
    () => ok(null, { tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'Bash', arguments: '{"command":"ls"}' } }] }),
    { TOOL_MODE: 'native' },
    async (base, mock) => {
      const { status, json } = await postMessages(base, anthropicReq('list files', { tools: [BASH_TOOL] }));
      assert.strictEqual(status, 200);
      assert.strictEqual(json.stop_reason, 'tool_use');
      const toolUse = json.content.find(b => b.type === 'tool_use');
      assert.deepStrictEqual(toolUse.input, { command: 'ls' });

      const upstream = mock.calls[0];
      assert.ok(Array.isArray(upstream.tools) && upstream.tools[0].function.name === 'Bash', 'native tools forwarded');
    }
  );
});

test('auto mode falls back to emulated when backend rejects tools', async () => {
  await withStack(
    (body) => Array.isArray(body.tools)
      ? { status: 400, json: { error: { message: '"auto" tool choice requires --enable-auto-tool-choice and --tool-call-parser' } } }
      : ok('hi there'),
    { TOOL_MODE: 'auto' },
    async (base, mock) => {
      const { status, json } = await postMessages(base, anthropicReq('say hi', { tools: [BASH_TOOL] }));
      assert.strictEqual(status, 200);
      assert.strictEqual(json.content[0].text, 'hi there');
      assert.strictEqual(mock.calls.length, 2, 'native attempt then emulated fallback');
    }
  );
});

test('auto mode surfaces unrelated 400s instead of falling back', async () => {
  await withStack(
    () => ({ status: 400, json: { error: { message: 'invalid model name' } } }),
    { TOOL_MODE: 'auto' },
    async (base, mock) => {
      const { status, json } = await postMessages(base, anthropicReq('say hi', { tools: [BASH_TOOL] }));
      assert.strictEqual(status, 400);
      assert.strictEqual(json.type, 'error');
      assert.ok(json.error.message.includes('invalid model name'));
      assert.strictEqual(mock.calls.length, 1, 'no emulated fallback for a non-tool error');
    }
  );
});

test('context overflow 400 triggers a trimmed retry', async () => {
  await withStack(
    (body, i) => i === 0
      ? { status: 400, json: { error: { message: "This model's maximum context length is exceeded" } } }
      : ok('short answer'),
    { TOOL_MODE: 'emulated', MODEL_CTX: '32768' },
    async (base, mock) => {
      const { status, json } = await postMessages(base, anthropicReq('hello'));
      assert.strictEqual(status, 200);
      assert.strictEqual(json.content[0].text, 'short answer');
      assert.strictEqual(mock.calls.length, 2, 'retried after overflow');
    }
  );
});

test('stream: true replays the message as Anthropic SSE', async () => {
  await withStack(
    () => ok('streamed text'),
    { TOOL_MODE: 'emulated' },
    async (base) => {
      const r = await fetch(base + '/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(anthropicReq('hello', { stream: true })),
      });
      assert.strictEqual(r.status, 200);
      assert.ok((r.headers.get('content-type') || '').includes('text/event-stream'));
      const body = await r.text();
      assert.ok(body.includes('event: message_start'));
      assert.ok(body.includes('"text_delta"') && body.includes('streamed text'));
      assert.ok(body.includes('event: message_stop'));
    }
  );
});

test('count_tokens returns an estimate', async () => {
  await withStack(
    () => ok('unused'),
    { TOOL_MODE: 'emulated' },
    async (base) => {
      const r = await fetch(base + '/v1/messages/count_tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(anthropicReq('hello world, count me')),
      });
      assert.strictEqual(r.status, 200);
      const json = await r.json();
      assert.ok(Number.isInteger(json.input_tokens) && json.input_tokens > 0);
    }
  );
});

test('upstream X-User-Email header is attached', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.headers['x-user-email']);
    let data = '';
    req.on('data', c => { data += c; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(ok('hi').json));
    });
  });
  const port = await freePort();
  await new Promise(r => server.listen(port, '127.0.0.1', r));
  let proxy;
  try {
    proxy = await startProxy('http://127.0.0.1:' + port + '/v1', { TOOL_MODE: 'emulated' });
    await postMessages(proxy.base, anthropicReq('hello'));
    assert.deepStrictEqual(seen, ['test@example.com']);
  } finally {
    if (proxy) proxy.proc.kill();
    server.close();
  }
});
