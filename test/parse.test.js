'use strict';
process.env.PROXY_TEST = '1';

const test = require('node:test');
const assert = require('node:assert');
const proxy = require('../lib/proxy.js');

const TOOLS = [
  { name: 'Bash', description: 'run', input_schema: { type: 'object' } },
  { name: 'Write', description: 'write', input_schema: { type: 'object' } },
  { name: 'Read', description: 'read', input_schema: { type: 'object' } },
  { name: 'mcp__h1b-sponsors__dataset_info', description: 'mcp', input_schema: { type: 'object' } },
];

test('parses a <tool_call> block', () => {
  const raw = '<tool_call>\n{"name":"Bash","arguments":{"command":"ls"}}\n</tool_call>';
  const { text, toolCalls } = proxy.parseToolCalls(raw, TOOLS);
  assert.strictEqual(toolCalls.length, 1);
  assert.strictEqual(toolCalls[0].name, 'Bash');
  assert.deepStrictEqual(toolCalls[0].input, { command: 'ls' });
  assert.strictEqual(text, '');
});

test('parses multiple <tool_call> blocks', () => {
  const raw = '<tool_call>{"name":"Bash","arguments":{"command":"ls"}}</tool_call>\n' +
    '<tool_call>{"name":"Read","arguments":{"file_path":"/a"}}</tool_call>';
  const { toolCalls } = proxy.parseToolCalls(raw, TOOLS);
  assert.deepStrictEqual(toolCalls.map(c => c.name), ['Bash', 'Read']);
});

test('accepts arguments passed as a JSON string', () => {
  const raw = '<tool_call>{"name":"Bash","arguments":"{\\"command\\":\\"ls\\"}"}</tool_call>';
  const { toolCalls } = proxy.parseToolCalls(raw, TOOLS);
  assert.strictEqual(toolCalls.length, 1);
  assert.deepStrictEqual(toolCalls[0].input, { command: 'ls' });
});

test('rejects tool names not in the tool list', () => {
  const raw = '<tool_call>{"name":"NotATool","arguments":{}}</tool_call>';
  const { toolCalls } = proxy.parseToolCalls(raw, TOOLS);
  assert.strictEqual(toolCalls.length, 0);
});

test('regression: prose code fence survives, is not stripped', () => {
  const raw = 'Here is the fix:\n```js\nconst x = 1;\n```\nDone.';
  const { text, toolCalls } = proxy.parseToolCalls(raw, TOOLS);
  assert.strictEqual(toolCalls.length, 0);
  assert.ok(text.includes('```js'), 'fence opener kept');
  assert.ok(text.includes('const x = 1;'), 'fence body kept');
  assert.ok(text.includes('Done.'));
});

test('regression: fence holding a tool call is stripped, prose fence kept', () => {
  const raw = 'Run this:\n```json\n{"name":"Bash","arguments":{"command":"ls"}}\n```\n' +
    'Example output:\n```\nfile.txt\n```';
  const { text, toolCalls } = proxy.parseToolCalls(raw, TOOLS);
  assert.strictEqual(toolCalls.length, 1);
  assert.strictEqual(toolCalls[0].name, 'Bash');
  assert.ok(!text.includes('"name":"Bash"'), 'tool-call fence removed');
  assert.ok(text.includes('file.txt'), 'plain fence kept');
});

test('tool call inside a fence is not double-counted', () => {
  const raw = '```json\n<tool_call>{"name":"Bash","arguments":{"command":"ls"}}</tool_call>\n```';
  const { toolCalls } = proxy.parseToolCalls(raw, TOOLS);
  assert.strictEqual(toolCalls.length, 1);
});

test('parses function-style drift: Write(file_path=..., content=...)', () => {
  const raw = 'Write(file_path="/tmp/a.txt", content=\'\'\'hello\nworld\'\'\')';
  const { text, toolCalls } = proxy.parseToolCalls(raw, TOOLS);
  assert.strictEqual(toolCalls.length, 1);
  assert.strictEqual(toolCalls[0].name, 'Write');
  assert.deepStrictEqual(toolCalls[0].input, { file_path: '/tmp/a.txt', content: 'hello\nworld' });
  assert.strictEqual(text, '');
});

test('parses object-style drift: write {file_path: "..."}', () => {
  const raw = 'write {file_path: "/tmp/a.txt", content: "hi"}';
  const { toolCalls } = proxy.parseToolCalls(raw, TOOLS);
  assert.strictEqual(toolCalls.length, 1);
  assert.strictEqual(toolCalls[0].name, 'Write');
  assert.deepStrictEqual(toolCalls[0].input, { file_path: '/tmp/a.txt', content: 'hi' });
});

test('parses bare JSON fallback', () => {
  const raw = '{"name":"Read","arguments":{"file_path":"/a"}}';
  const { toolCalls } = proxy.parseToolCalls(raw, TOOLS);
  assert.strictEqual(toolCalls.length, 1);
  assert.strictEqual(toolCalls[0].name, 'Read');
});

test('parseNativeToolCalls maps tool_calls and content', () => {
  const message = {
    content: 'thinking about it',
    tool_calls: [
      { id: 'call_1', type: 'function', function: { name: 'Bash', arguments: '{"command":"ls"}' } },
      { id: 'call_2', type: 'function', function: { name: 'NotATool', arguments: '{}' } },
      { id: 'call_3', type: 'function', function: { name: 'Read', arguments: 'not json' } },
    ],
  };
  const { text, toolCalls } = proxy.parseNativeToolCalls(message, TOOLS);
  assert.strictEqual(text, 'thinking about it');
  assert.strictEqual(toolCalls.length, 2, 'unknown tool filtered');
  assert.deepStrictEqual(toolCalls[0].input, { command: 'ls' });
  assert.deepStrictEqual(toolCalls[1].input, { _raw: 'not json' }, 'bad JSON args preserved as _raw');
});

test('parseNativeToolCalls handles array content parts', () => {
  const message = { content: [{ type: 'text', text: 'a' }, 'b', { type: 'text', text: 'c' }], tool_calls: [] };
  const { text } = proxy.parseNativeToolCalls(message, TOOLS);
  assert.strictEqual(text, 'a\nb\nc');
});

// ---- shouldRetryToolCall -------------------------------------------------

function bodyWithUser(text) {
  return { tools: TOOLS, messages: [{ role: 'user', content: text }] };
}

test('regression: summary prose with "created"/"I\'ll" does not retry', () => {
  const body = { tools: TOOLS, messages: [
    { role: 'user', content: 'thanks' },
  ] };
  const raw = 'I created the folder earlier and I\'ll note the config lives in lib/. Next step is up to you.';
  assert.strictEqual(proxy.shouldRetryToolCall(raw, body), false);
});

test('pseudo-call Bash(...) in output triggers retry', () => {
  const body = { tools: TOOLS, messages: [{ role: 'user', content: 'thanks' }] };
  assert.strictEqual(proxy.shouldRetryToolCall('Bash(command="ls -la")', body), true);
});

test('malformed <tool_call tag triggers retry', () => {
  const body = { tools: TOOLS, messages: [{ role: 'user', content: 'thanks' }] };
  assert.strictEqual(proxy.shouldRetryToolCall('<tool_call>{"name": "Bash", broken', body), true);
});

test('action request in latest user text triggers retry', () => {
  assert.strictEqual(proxy.shouldRetryToolCall('Sure, sounds good.', bodyWithUser('create a folder for me')), true);
});

test('no retry when latest user message is only tool results', () => {
  const body = { tools: TOOLS, messages: [
    { role: 'user', content: 'create a folder' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'mkdir x' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
  ] };
  assert.strictEqual(proxy.shouldRetryToolCall('Directory is ready.', body), false);
});

// ---- MCP opt-in filtering ------------------------------------------------

test('MCP tool hidden for generic request', () => {
  const body = { tools: TOOLS.slice(), messages: [{ role: 'user', content: 'list files here' }] };
  const out = proxy.filterMcpToolsForRequest(body);
  assert.deepStrictEqual(out.tools.map(t => t.name), ['Bash', 'Write', 'Read']);
});

test('MCP tool exposed when user names the server', () => {
  const body = { tools: TOOLS.slice(), messages: [{ role: 'user', content: 'use h1b-sponsors to look this up' }] };
  const out = proxy.filterMcpToolsForRequest(body);
  assert.ok(out.tools.some(t => t.name === 'mcp__h1b-sponsors__dataset_info'));
});

test('regression: MCP opt-in persists across tool_result continuation turns', () => {
  const body = { tools: TOOLS.slice(), messages: [
    { role: 'user', content: 'use h1b-sponsors to look this up' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'mcp__h1b-sponsors__dataset_info', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'dataset: 12k rows' }] },
  ] };
  assert.strictEqual(proxy.latestActionableUserText(body), 'use h1b-sponsors to look this up');
  const out = proxy.filterMcpToolsForRequest(body);
  assert.ok(out.tools.some(t => t.name === 'mcp__h1b-sponsors__dataset_info'), 'MCP tool still exposed mid-loop');
});

test('new generic user instruction drops the MCP opt-in again', () => {
  const body = { tools: TOOLS.slice(), messages: [
    { role: 'user', content: 'use h1b-sponsors to look this up' },
    { role: 'assistant', content: 'done' },
    { role: 'user', content: 'now just list the files' },
  ] };
  const out = proxy.filterMcpToolsForRequest(body);
  assert.ok(!out.tools.some(t => t.name === 'mcp__h1b-sponsors__dataset_info'));
});

test('forced tool_choice of a hidden MCP tool downgrades to auto', () => {
  const body = {
    tools: TOOLS.slice(),
    tool_choice: { type: 'tool', name: 'mcp__h1b-sponsors__dataset_info' },
    messages: [{ role: 'user', content: 'list files' }],
  };
  const out = proxy.filterMcpToolsForRequest(body);
  assert.deepStrictEqual(out.tool_choice, { type: 'auto' });
});

// ---- upstreamSupportsFallback ---------------------------------------------

test('fallback fires on tool-specific 400s', () => {
  assert.strictEqual(proxy.upstreamSupportsFallback(400, '"auto" tool choice requires --enable-auto-tool-choice and --tool-call-parser'), true);
  assert.strictEqual(proxy.upstreamSupportsFallback(400, 'tool_calls is not supported by this model'), true);
  assert.strictEqual(proxy.upstreamSupportsFallback(422, 'unknown field: tools are not supported'), true);
});

test('regression: fallback does NOT fire on unrelated 400s', () => {
  assert.strictEqual(proxy.upstreamSupportsFallback(400, 'invalid model name'), false);
  assert.strictEqual(proxy.upstreamSupportsFallback(400, 'unsupported parameter: logprobs'), false);
  assert.strictEqual(proxy.upstreamSupportsFallback(500, 'tool_choice error'), false, 'non-4xx never falls back');
});
