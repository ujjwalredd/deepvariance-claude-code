'use strict';
// Shared harness: a scripted mock OpenAI upstream + the real proxy as a child.

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

// script(requestBody, callIndex, req, res) may either return { status, json }
// or take over the response directly (return undefined to signal that).
async function startMock(script) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', c => { data += c; });
    req.on('end', async () => {
      const body = data ? JSON.parse(data) : {};
      calls.push(body);
      const out = await script(body, calls.length - 1, req, res);
      if (out === undefined) return; // script handled the response
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
      UPSTREAM_KEY: 'sk-test-secret-key',
      UPSTREAM_MODEL: 'test-model',
      USER_EMAIL: 'test@example.com',
      PORT: String(port),
      PROXY_TEST: '',
    }, envExtra || {}),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  proc.stderr.on('data', c => { stderr += c; });

  const base = 'http://127.0.0.1:' + port;
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(base + '/health');
      if (r.ok) return { proc, base, port, getStderr: () => stderr };
    } catch (_) {}
    if (proc.exitCode !== null) break;
    await new Promise(r => setTimeout(r, 100));
  }
  proc.kill();
  throw new Error('proxy failed to start: ' + stderr);
}

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

function okChat(content, extra) {
  return { status: 200, json: {
    choices: [{ message: Object.assign({ content }, extra || {}) }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  } };
}

async function withStack(script, envExtra, fn) {
  const mock = await startMock(script);
  let proxy;
  try {
    proxy = await startProxy(mock.base, envExtra);
    await fn(proxy, mock);
  } finally {
    if (proxy) proxy.proc.kill();
    mock.server.close();
  }
}

module.exports = { freePort, startMock, startProxy, anthropicReq, postMessages, okChat, withStack };
