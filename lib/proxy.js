#!/usr/bin/env node
'use strict';
/*
 * deepvariance-claude-code :: proxy
 * ---------------------------------------------------------------------------
 * Ollama-style tool-calling emulation for a vLLM (OpenAI-compatible) backend
 * that was launched WITHOUT --enable-auto-tool-choice / --tool-call-parser.
 *
 * Claude Code speaks the Anthropic Messages API. This proxy:
 *   1. accepts POST /v1/messages (+ /v1/messages/count_tokens)
 *   2. renders Anthropic `tools` into a Hermes tool prompt (what Qwen2.5 was
 *      trained on) inside the system message
 *   3. calls the backend /chat/completions WITHOUT the `tools` param
 *      (so the server never hits the missing-parser 400)
 *   4. parses <tool_call>{...}</tool_call> back out of the reply
 *   5. returns an Anthropic response, faux-streamed as SSE when requested
 *
 * Config via env (set by `bin/deepvariance`):
 *   UPSTREAM_BASE   e.g. https://host/v1        (no trailing /chat/completions)
 *   UPSTREAM_KEY    bearer key for the backend
 *   UPSTREAM_MODEL  e.g. Qwen/Qwen2.5-Coder-32B-Instruct
 *   USER_EMAIL      sent as X-User-Email on every upstream call (usage logging)
 *   MODEL_CTX       total context window (default 32768)
 *   PORT            default 8787
 *   PROXY_DEBUG     "1" to log requests/responses
 */

const http = require('http');

const UPSTREAM_BASE = (process.env.UPSTREAM_BASE || '').replace(/\/+$/, '');
const UPSTREAM_KEY = process.env.UPSTREAM_KEY || '';
const UPSTREAM_MODEL = process.env.UPSTREAM_MODEL || '';
const USER_EMAIL = process.env.USER_EMAIL || '';
const MODEL_CTX = parseInt(process.env.MODEL_CTX || '32768', 10); // total context window
const CTX_MARGIN = parseInt(process.env.CTX_MARGIN || '1024', 10); // reserve
const PORT = parseInt(process.env.PORT || '8787', 10);
const DEBUG = process.env.PROXY_DEBUG === '1';

if (!UPSTREAM_BASE || !UPSTREAM_MODEL) {
  console.error('[proxy] UPSTREAM_BASE and UPSTREAM_MODEL are required');
  process.exit(1);
}
const CHAT_URL = UPSTREAM_BASE + '/chat/completions';

// Headers sent to the backend on every call. X-User-Email is the logging hook:
// the model server records which user drove the request.
function upstreamHeaders() {
  const h = {
    'Content-Type': 'application/json',
    Authorization: 'Bearer ' + UPSTREAM_KEY,
  };
  if (USER_EMAIL) h['X-User-Email'] = USER_EMAIL;
  return h;
}

function log(...a) { if (DEBUG) console.error('[proxy]', ...a); }
function rid(prefix) {
  return prefix + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}
function approxTokens(str) { return Math.max(1, Math.ceil((str || '').length / 4)); }

// ---- Anthropic -> plain text helpers ------------------------------------

function systemToText(system) {
  if (!system) return '';
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) {
    return system.map(b => (typeof b === 'string' ? b : (b && b.text) || '')).join('\n');
  }
  return '';
}

// Build the Hermes tool instruction block from Anthropic tool defs.
function buildToolPrompt(tools) {
  const defs = tools.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description || '',
      parameters: t.input_schema || { type: 'object', properties: {} },
    },
  }));
  const lines = [];
  lines.push('# Tools');
  lines.push('');
  lines.push('You may call one or more functions to assist with the user query.');
  lines.push('');
  lines.push('You are provided with function signatures within <tools></tools> XML tags:');
  lines.push('<tools>');
  for (const d of defs) lines.push(JSON.stringify(d));
  lines.push('</tools>');
  lines.push('');
  lines.push('For each function call, return a json object with function name and arguments within <tool_call></tool_call> XML tags:');
  lines.push('<tool_call>');
  lines.push('{"name": <function-name>, "arguments": <args-json-object>}');
  lines.push('</tool_call>');
  lines.push('');
  lines.push('Rules:');
  lines.push('- If the user asks you to use tools, output only tool calls. Do not explain, plan, or claim a command/file was run.');
  lines.push('- Use the literal tag <tool_call> for calls. Never use <tools>, <function_call>, or code fences for a call.');
  lines.push('- Emit one <tool_call> block per function call. Multiple calls = multiple blocks.');
  lines.push('- "arguments" must be a JSON object, never a string.');
  lines.push('- Put no tool-call JSON outside <tool_call></tool_call> tags.');
  lines.push('');
  lines.push('Valid examples:');
  lines.push('<tool_call>');
  lines.push('{"name":"Bash","arguments":{"command":"mkdir -p /tmp/example","description":"Create directory"}}');
  lines.push('</tool_call>');
  lines.push('<tool_call>');
  lines.push('{"name":"Write","arguments":{"file_path":"/tmp/example.txt","content":"hello"}}');
  lines.push('</tool_call>');
  return lines.join('\n');
}

// Convert one Anthropic message's content into a plain string for the backend.
function contentToText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content);
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') { parts.push(String(block)); continue; }
    switch (block.type) {
      case 'text':
        parts.push(block.text || '');
        break;
      case 'tool_use':
        // Reconstruct assistant tool call so history stays consistent.
        parts.push('<tool_call>\n' + JSON.stringify({ name: block.name, arguments: block.input || {} }) + '\n</tool_call>');
        break;
      case 'tool_result': {
        const inner = contentToText(block.content);
        const tag = block.is_error ? 'tool_response_error' : 'tool_response';
        parts.push('<' + tag + '>\n' + inner + '\n</' + tag + '>');
        break;
      }
      case 'image':
        parts.push('[image omitted: backend is text-only]');
        break;
      default:
        if (block.text) parts.push(block.text);
        else parts.push('[' + (block.type || 'unknown') + ' block]');
    }
  }
  return parts.join('\n');
}

// Build the OpenAI-style messages array (no tools param).
function toOpenAIMessages(body) {
  const msgs = [];
  const hasTools = Array.isArray(body.tools) && body.tools.length;
  let sys = systemToText(body.system);
  if (hasTools) {
    sys = (sys ? sys + '\n\n' : '') + buildToolPrompt(body.tools);
  }
  if (sys) msgs.push({ role: 'system', content: sys });

  for (const m of body.messages || []) {
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    const text = contentToText(m.content);
    msgs.push({ role, content: text });
  }
  if (hasTools) {
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role !== 'user') continue;
      const names = body.tools.map(t => t && t.name).filter(Boolean).join(', ');
      msgs[i] = Object.assign({}, msgs[i], {
        content: msgs[i].content + '\n\nTool reminder: Tools available: ' + names + '. If this request needs an action, output only <tool_call>{"name":"TOOL_NAME","arguments":{...}}</tool_call>. Do not explain, plan, or claim the action is done.',
      });
      break;
    }
  }
  return msgs;
}

// ---- backend response -> Anthropic content ------------------------------

// Turn a parsed {name, arguments} object into a tool_use call, or null.
function toCall(parsed) {
  if (!parsed || !parsed.name || typeof parsed.name !== 'string') return null;
  let args = parsed.arguments !== undefined ? parsed.arguments : parsed.parameters;
  if (typeof args === 'string') {
    try { args = JSON.parse(args); } catch (_) { args = { _raw: args }; }
  }
  if (args == null || typeof args !== 'object' || Array.isArray(args)) args = {};
  return { id: rid('toolu_'), name: parsed.name, input: args };
}

function tryParseObj(str) {
  const s = str.trim();
  try { return JSON.parse(s); } catch (_) {}
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a !== -1 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch (_) {} }
  return null;
}

function readQuotedValue(s, i) {
  const quote = s[i];
  const triple = s.slice(i, i + 3) === quote + quote + quote;
  const start = i + (triple ? 3 : 1);
  const endQuote = triple ? quote + quote + quote : quote;
  let out = '', j = start;
  const escapes = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0' };
  while (j < s.length) {
    if (triple && s.slice(j, j + 3) === endQuote) return { value: out, next: j + 3 };
    if (!triple && s[j] === quote) return { value: out, next: j + 1 };
    if (!triple && s[j] === '\\' && j + 1 < s.length) {
      const escaped = s[j + 1];
      out += Object.prototype.hasOwnProperty.call(escapes, escaped) ? escapes[escaped] : escaped;
      j += 2;
      continue;
    }
    out += s[j++];
  }
  return null;
}

function readBareValue(s, i) {
  let depth = 0, j = i;
  while (j < s.length) {
    const ch = s[j];
    if (ch === '"' || ch === "'") {
      const q = readQuotedValue(s, j);
      if (!q) return null;
      j = q.next;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    if (ch === ')' || ch === ']' || ch === '}') depth--;
    if (ch === ',' && depth <= 0) break;
    j++;
  }
  const raw = s.slice(i, j).trim();
  if (!raw) return null;
  if (/^-?\d+(?:\.\d+)?$/.test(raw)) return { value: Number(raw), next: j };
  if (raw === 'true' || raw === 'True') return { value: true, next: j };
  if (raw === 'false' || raw === 'False') return { value: false, next: j };
  if (raw === 'null' || raw === 'None') return { value: null, next: j };
  try { return { value: JSON.parse(raw), next: j }; } catch (_) {}
  return { value: raw, next: j };
}

function parseKeywordArgs(argText) {
  const args = {};
  let i = 0;
  while (i < argText.length) {
    while (/\s|,/.test(argText[i] || '')) i++;
    if (i >= argText.length) break;

    const keyMatch = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(argText.slice(i));
    if (!keyMatch) return null;
    const key = keyMatch[0];
    i += key.length;

    while (/\s/.test(argText[i] || '')) i++;
    if (argText[i] !== '=') return null;
    i++;
    while (/\s/.test(argText[i] || '')) i++;

    let parsed;
    if (argText[i] === '"' || argText[i] === "'") parsed = readQuotedValue(argText, i);
    else parsed = readBareValue(argText, i);
    if (!parsed) return null;
    args[key] = parsed.value;
    i = parsed.next;

    while (/\s/.test(argText[i] || '')) i++;
    if (i < argText.length && argText[i] !== ',') return null;
  }
  return args;
}

function parseObjectLikeArgs(objText) {
  const s = objText.trim();
  if (!s.startsWith('{') || !s.endsWith('}')) return null;
  const args = {};
  let i = 1;
  while (i < s.length - 1) {
    while (/\s|,/.test(s[i] || '')) i++;
    if (i >= s.length - 1) break;

    let key;
    if (s[i] === '"' || s[i] === "'") {
      const parsedKey = readQuotedValue(s, i);
      if (!parsedKey) return null;
      key = parsedKey.value;
      i = parsedKey.next;
    } else {
      const keyMatch = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(s.slice(i));
      if (!keyMatch) return null;
      key = keyMatch[0];
      i += key.length;
    }

    while (/\s/.test(s[i] || '')) i++;
    if (s[i] !== ':') return null;
    i++;
    while (/\s/.test(s[i] || '')) i++;

    let parsed;
    if (s[i] === '"' || s[i] === "'") parsed = readQuotedValue(s, i);
    else parsed = readBareValue(s, i);
    if (!parsed) return null;
    args[key] = parsed.value;
    i = parsed.next;

    while (/\s/.test(s[i] || '')) i++;
    if (i < s.length - 1 && s[i] !== ',') return null;
  }
  return args;
}

function findCallEnd(s, openIdx) {
  let depth = 1, i = openIdx + 1;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '"' || ch === "'") {
      const q = readQuotedValue(s, i);
      if (!q) return -1;
      i = q.next;
      continue;
    }
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (depth === 0) return i;
    i++;
  }
  return -1;
}

function findGroupEnd(s, openIdx, openCh, closeCh) {
  let depth = 1, i = openIdx + 1;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '"' || ch === "'") {
      const q = readQuotedValue(s, i);
      if (!q) return -1;
      i = q.next;
      continue;
    }
    if (ch === openCh) depth++;
    if (ch === closeCh) depth--;
    if (depth === 0) return i;
    i++;
  }
  return -1;
}

function canonicalToolName(name, allowedNames) {
  if (!allowedNames || allowedNames.size === 0) return null;
  for (const allowed of allowedNames) {
    if (allowed.toLowerCase() === name.toLowerCase()) return allowed;
  }
  return null;
}

function parseFunctionStyleCalls(raw, allowedNames) {
  if (!allowedNames || allowedNames.size === 0) return [];
  const calls = [];
  let i = 0;
  const s = raw.trim();
  while (i < s.length) {
    while (/\s|;/.test(s[i] || '')) i++;
    if (i >= s.length) break;

    const nameMatch = /^[A-Za-z_][A-Za-z0-9_]*\s*\(/.exec(s.slice(i));
    if (!nameMatch) return [];
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(nameMatch[0])[0];
    const canonical = canonicalToolName(name, allowedNames);
    if (!canonical) return [];

    const openIdx = i + nameMatch[0].lastIndexOf('(');
    const closeIdx = findCallEnd(s, openIdx);
    if (closeIdx === -1) return [];

    const argText = s.slice(openIdx + 1, closeIdx).trim();
    const args = parseKeywordArgs(argText) || parseObjectLikeArgs(argText);
    if (!args) return [];
    calls.push({ name: canonical, arguments: args });
    i = closeIdx + 1;
  }
  return calls;
}

function parseObjectStyleCalls(raw, allowedNames) {
  if (!allowedNames || allowedNames.size === 0) return [];
  const s = raw.trim();
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '"' || s[i] === "'") {
      const q = readQuotedValue(s, i);
      if (!q) return [];
      i = q.next - 1;
      continue;
    }
    if (s[i] !== '{') continue;

    let j = i - 1;
    while (j >= 0 && /\s/.test(s[j])) j--;
    const end = j + 1;
    while (j >= 0 && /[A-Za-z0-9_]/.test(s[j])) j--;
    const name = s.slice(j + 1, end);
    const canonical = canonicalToolName(name, allowedNames);
    if (!canonical) continue;

    const closeIdx = findGroupEnd(s, i, '{', '}');
    if (closeIdx === -1) return [];
    const args = parseObjectLikeArgs(s.slice(i, closeIdx + 1));
    if (!args) return [];
    return [{ name: canonical, arguments: args }];
  }
  return [];
}

// Extract tool calls, tolerating the tag variants models drift into
// (<tool_call>, <tools>, <function_call>, ```json fences, or bare JSON).
// We only parse the model's completion here, never the prompt, so accepting
// <tools> in the output is safe.
function parseToolCalls(raw, tools) {
  const toolCalls = [];
  let text = raw;
  const allowedNames = new Set((Array.isArray(tools) ? tools : []).map(t => t && t.name).filter(Boolean));
  const patterns = [
    /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g,
    /<tools>\s*([\s\S]*?)\s*<\/tools>/g,
    /<function_call>\s*([\s\S]*?)\s*<\/function_call>/g,
    /```(?:json|tool_call)?\s*([\s\S]*?)\s*```/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(raw)) !== null) {
      const obj = tryParseObj(m[1]);
      const call = toCall(obj);
      if (call) toolCalls.push(call);
    }
    text = text.replace(re, '');
  }
  // Some local models drift into Claude-Code-looking calls like:
  // Write(file_path="...", content='''...''')
  if (toolCalls.length === 0) {
    for (const obj of parseFunctionStyleCalls(raw, allowedNames)) {
      const call = toCall(obj);
      if (call) toolCalls.push(call);
    }
    if (toolCalls.length) text = '';
  }
  // Other local model drift: `write {file_path: "...", content: "..."}`
  if (toolCalls.length === 0) {
    for (const obj of parseObjectStyleCalls(raw, allowedNames)) {
      const call = toCall(obj);
      if (call) toolCalls.push(call);
    }
    if (toolCalls.length) text = '';
  }
  // Fallback: bare JSON object with name+arguments and no tags at all.
  if (toolCalls.length === 0) {
    const obj = tryParseObj(raw);
    const call = toCall(obj);
    if (call) { toolCalls.push(call); text = ''; }
  }
  // strip any unclosed trailing tag noise
  text = text.replace(/<\/?(?:tool_call|tools|function_call)>[\s\S]*$/g, '').trim();
  return { text, toolCalls };
}

function buildAnthropicMessage(model, parsed, usage) {
  const content = [];
  if (parsed.text) content.push({ type: 'text', text: parsed.text });
  for (const tc of parsed.toolCalls) {
    content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input });
  }
  if (content.length === 0) content.push({ type: 'text', text: '' });
  return {
    id: rid('msg_'),
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: parsed.toolCalls.length ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  };
}

// ---- SSE (faux streaming) ------------------------------------------------

function sse(res, event, data) {
  res.write('event: ' + event + '\n');
  res.write('data: ' + JSON.stringify(data) + '\n\n');
}

function streamAnthropic(res, msg) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const base = Object.assign({}, msg, { content: [], stop_reason: null, stop_sequence: null });
  sse(res, 'message_start', { type: 'message_start', message: base });

  msg.content.forEach((block, i) => {
    if (block.type === 'text') {
      sse(res, 'content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } });
      if (block.text) sse(res, 'content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: block.text } });
      sse(res, 'content_block_stop', { type: 'content_block_stop', index: i });
    } else if (block.type === 'tool_use') {
      sse(res, 'content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } });
      sse(res, 'content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input || {}) } });
      sse(res, 'content_block_stop', { type: 'content_block_stop', index: i });
    }
  });

  sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: msg.stop_reason, stop_sequence: null }, usage: { output_tokens: msg.usage.output_tokens } });
  sse(res, 'message_stop', { type: 'message_stop' });
  res.end();
}

// ---- HTTP server ---------------------------------------------------------

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// ---- context-window fitting ---------------------------------------------

function totalTokens(msgs) { return msgs.reduce((s, m) => s + approxTokens(m.content), 0); }

// Shrink the message list so it fits `targetIn` estimated tokens:
//  1. drop the oldest non-system, non-last messages (lose old history first),
//  2. if still too big, hard-truncate the longest remaining message contents.
// The system message (tools + instructions) and the most recent message are
// preserved as long as possible.
function trimToBudget(msgs, targetIn) {
  if (totalTokens(msgs) <= targetIn) return msgs;
  const hasSys = msgs.length > 0 && msgs[0].role === 'system';
  const head = hasSys ? [msgs[0]] : [];
  let mid = hasSys ? msgs.slice(1) : msgs.slice();

  // drop oldest until only the most recent message remains in `mid`
  let dropped = 0;
  while (mid.length > 1 && totalTokens(head.concat(mid)) > targetIn) {
    mid.shift();
    dropped++;
  }
  let out = head.concat(mid);
  if (dropped > 0) log('trim: dropped', dropped, 'old message(s)');

  // still over budget -> hard-truncate the longest message repeatedly
  let guard = 0;
  while (totalTokens(out) > targetIn && guard++ < 5000) {
    let idx = 0, max = -1;
    out.forEach((m, i) => { if (m.content.length > max) { max = m.content.length; idx = i; } });
    if (max < 200) break;
    const cut = Math.max(400, Math.floor(out[idx].content.length * 0.15));
    out[idx] = Object.assign({}, out[idx], {
      content: out[idx].content.slice(0, out[idx].content.length - cut) + '\n…[trimmed to fit model context]',
    });
  }
  if (guard > 0) log('trim: hard-truncated to fit', targetIn, 'tok');
  return out;
}

async function handleMessages(req, res, body) {
  const wantStream = body.stream === true;
  const baseMsgs = toOpenAIMessages(body);
  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;

  // Desired output headroom; Claude Code often asks for far more than fits.
  const reserveOut = Math.min(Math.max(body.max_tokens || 4096, 512), 4096);

  // Retry loop: trim input to a target, send; if the backend still reports a
  // context-length overflow (our char/4 estimate can undershoot the real
  // tokenizer), shrink the target and retry.
  let targetIn = MODEL_CTX - reserveOut - CTX_MARGIN;
  let upJson = null, lastErr = '', lastStatus = 500, msgs = baseMsgs;

  for (let attempt = 0; attempt < 4; attempt++) {
    msgs = trimToBudget(baseMsgs, targetIn);
    const inTok = totalTokens(msgs);
    const maxOut = Math.max(256, Math.min(reserveOut, MODEL_CTX - inTok - CTX_MARGIN));

    const upstreamReq = {
      model: UPSTREAM_MODEL,
      messages: msgs,
      max_tokens: maxOut,
      temperature: typeof body.temperature === 'number' ? (hasTools ? Math.min(body.temperature, 0.2) : body.temperature) : (hasTools ? 0.2 : 0.6),
      stream: false,
    };
    if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) {
      upstreamReq.stop = body.stop_sequences;
    }
    log('->upstream attempt', attempt, 'inTok~' + inTok, 'maxOut', maxOut);

    let up;
    try {
      up = await fetch(CHAT_URL, { method: 'POST', headers: upstreamHeaders(), body: JSON.stringify(upstreamReq) });
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'upstream fetch failed: ' + e.message } }));
      return;
    }

    const upText = await up.text();
    if (up.ok) {
      try { upJson = JSON.parse(upText); }
      catch (e) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'bad upstream json' } }));
        return;
      }
      break;
    }

    lastErr = upText.slice(0, 500);
    lastStatus = up.status;
    const overflow = up.status === 400 && /context length|input_tokens|maximum context/i.test(upText);
    if (overflow && attempt < 3) {
      targetIn = Math.floor(targetIn * 0.75); // shrink hard and retry
      log('upstream overflow -> retry with targetIn', targetIn);
      continue;
    }
    // non-recoverable (or out of retries)
    log('upstream error', up.status, lastErr.slice(0, 200));
    res.writeHead(up.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'upstream ' + up.status + ': ' + lastErr } }));
    return;
  }

  if (!upJson) {
    res.writeHead(lastStatus, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'upstream ' + lastStatus + ': ' + lastErr } }));
    return;
  }

  const rawContent = (((upJson.choices || [])[0] || {}).message || {}).content || '';
  const parsed = parseToolCalls(rawContent, body.tools);
  const outputTokens = (upJson.usage && upJson.usage.completion_tokens) || approxTokens(rawContent);
  const usage = { input_tokens: (upJson.usage && upJson.usage.prompt_tokens) || totalTokens(msgs), output_tokens: outputTokens };
  const msg = buildAnthropicMessage(body.model || UPSTREAM_MODEL, parsed, usage);
  log('<-parsed', parsed.toolCalls.length, 'tool calls,', parsed.text.length, 'chars text');

  if (wantStream) {
    streamAnthropic(res, msg);
  } else {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(msg));
  }
}

function handleCountTokens(res, body) {
  const openaiMsgs = toOpenAIMessages(body);
  const n = approxTokens(openaiMsgs.map(m => m.content).join('\n'));
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ input_tokens: n }));
}

const server = http.createServer(async (req, res) => {
  const url = (req.url || '').split('?')[0];
  if (req.method === 'GET' && (url === '/health' || url === '/')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, model: UPSTREAM_MODEL, upstream: CHAT_URL }));
    return;
  }
  if (req.method !== 'POST') { res.writeHead(404).end(); return; }

  let body;
  try { body = JSON.parse(await readBody(req) || '{}'); }
  catch (e) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'bad json' } }));
    return;
  }

  try {
    if (url.endsWith('/count_tokens')) return handleCountTokens(res, body);
    if (url === '/v1/messages' || url.endsWith('/messages')) return await handleMessages(req, res, body);
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'unknown path ' + url } }));
  } catch (e) {
    log('handler error', e && e.stack);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: e.message } }));
  }
});

server.on('error', (e) => {
  console.error('[proxy] failed to listen on 127.0.0.1:' + PORT + ': ' + (e && e.message ? e.message : e));
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  console.error('[proxy] listening http://127.0.0.1:' + PORT + '  model=' + UPSTREAM_MODEL + '  upstream=' + CHAT_URL + (USER_EMAIL ? '  user=' + USER_EMAIL : ''));
});
