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
 *      trained on) inside the system message, or forwards tools natively when
 *      TOOL_MODE=native/auto and the backend supports OpenAI tool calls
 *   3. calls the backend /chat/completions
 *   4. parses native tool_calls or <tool_call>{...}</tool_call> back out
 *   5. returns an Anthropic response, faux-streamed as SSE when requested
 *
 * Config via env (set by `bin/deepvariance`):
 *   UPSTREAM_BASE   e.g. https://host/v1        (no trailing /chat/completions)
 *   UPSTREAM_KEY    bearer key for the backend
 *   UPSTREAM_MODEL  e.g. Qwen/Qwen2.5-Coder-32B-Instruct
 *   USER_EMAIL      sent as X-User-Email on every upstream call (usage logging)
 *   MODEL_CTX       total context window (default 32768)
 *   TOOL_MODE       auto | emulated | native (default auto)
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
const RAW_TOOL_MODE = (process.env.TOOL_MODE || 'auto').toLowerCase();
const TOOL_MODE = ['auto', 'emulated', 'native'].includes(RAW_TOOL_MODE) ? RAW_TOOL_MODE : 'auto';
const PORT = parseInt(process.env.PORT || '8787', 10);
const DEBUG = process.env.PROXY_DEBUG === '1';
const UPSTREAM_TIMEOUT_MS = parseInt(process.env.UPSTREAM_TIMEOUT_MS || '120000', 10);
const UPSTREAM_RETRIES = parseInt(process.env.UPSTREAM_RETRIES || '2', 10); // extra tries on transient 5xx/429
const LOG_FILE = process.env.PROXY_LOG_FILE || '';
// PROXY_TEST=1 imports this file as a library (unit tests): skip env
// validation and never bind the port.
const TESTING = process.env.PROXY_TEST === '1';
let nativeToolsKnownUnsupported = false;

if (!TESTING && (!UPSTREAM_BASE || !UPSTREAM_MODEL)) {
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

// Strip anything that looks like the bearer key from a string before logging.
function redact(str) {
  let s = String(str == null ? '' : str);
  if (UPSTREAM_KEY) s = s.split(UPSTREAM_KEY).join('***');
  s = s.replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, 'Bearer ***');
  s = s.replace(/("?(?:api[_-]?key|authorization)"?\s*[:=]\s*"?)[A-Za-z0-9._\-]+/gi, '$1***');
  return s;
}

// One structured JSON line per request to stderr (always on), plus the log
// file when PROXY_LOG_FILE is set. Never throws into the request path.
let fsMod = null;
function structuredLog(fields) {
  const line = JSON.stringify(Object.assign({ ts: new Date().toISOString() }, fields));
  const safe = redact(line);
  try { process.stderr.write(safe + '\n'); } catch (_) {}
  if (LOG_FILE) {
    try {
      if (!fsMod) fsMod = require('fs');
      fsMod.appendFile(LOG_FILE, safe + '\n', () => {});
    } catch (_) {}
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// POST to the upstream chat endpoint with a hard timeout and transient-error
// retry (429/500/502/503/504) using jittered backoff. Returns a normalized
// { ok, status, text, timedOut, networkError, retries }.
async function postUpstream(upstreamReq) {
  let retries = 0;
  for (let tryIdx = 0; tryIdx <= UPSTREAM_RETRIES; tryIdx++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
    let up;
    try {
      up = await fetch(CHAT_URL, {
        method: 'POST',
        headers: upstreamHeaders(),
        body: JSON.stringify(upstreamReq),
        signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      const timedOut = e && (e.name === 'AbortError' || /abort/i.test(e.message || ''));
      if (tryIdx < UPSTREAM_RETRIES && !timedOut) { // network blip: retry
        retries++;
        await sleep(500 * (tryIdx + 1) + Math.floor(Math.random() * 250));
        continue;
      }
      return { ok: false, status: timedOut ? 504 : 502, text: '', timedOut: !!timedOut, networkError: e && e.message, retries };
    }
    clearTimeout(timer);
    const text = await up.text();
    const transient = up.status === 429 || (up.status >= 500 && up.status <= 599);
    if (transient && tryIdx < UPSTREAM_RETRIES) {
      retries++;
      log('upstream transient', up.status, '-> retry', tryIdx + 1);
      await sleep(500 * (tryIdx + 1) + Math.floor(Math.random() * 250));
      continue;
    }
    return { ok: up.ok, status: up.status, text, timedOut: false, retries };
  }
  return { ok: false, status: 502, text: '', retries };
}

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
  const defs = anthropicToolsToOpenAI(tools);
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
  lines.push('- Do not use plan-mode tools such as EnterPlanMode unless the user explicitly asks for a plan or plan mode.');
  lines.push('- For codebase understanding or summarization, inspect files with tools, then summarize findings.');
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

function anthropicToolsToOpenAI(tools) {
  return (tools || []).map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description || '',
      parameters: t.input_schema || { type: 'object', properties: {} },
    },
  }));
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

function isToolResultBlock(block) {
  return block && typeof block === 'object' && (block.type === 'tool_result' || block.type === 'web_search_tool_result');
}

function hasActionableUserContent(content) {
  if (content == null) return false;
  if (typeof content === 'string') return content.trim() !== '';
  if (!Array.isArray(content)) return String(content).trim() !== '';
  return content.some(block => {
    if (isToolResultBlock(block)) return false;
    if (!block || typeof block !== 'object') return String(block).trim() !== '';
    if (block.type === 'text') return (block.text || '').trim() !== '';
    return block.type !== 'tool_result' && block.type !== 'web_search_tool_result';
  });
}

// Most recent user message that carries real text (not just tool results).
// Scanning back past tool_result-only continuations keeps opt-ins (e.g. MCP
// tools) alive for the whole agentic turn, not just the first call.
function latestActionableUserText(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === 'user' && hasActionableUserContent(m.content)) {
      return contentToText(m.content);
    }
  }
  return '';
}

function mentionNorm(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

function mcpToolParts(tool) {
  const name = tool && tool.name ? String(tool.name) : '';
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  if (!m) return null;
  return { name, server: m[1], tool: m[2] };
}

function mcpToolAllowed(tool, userText) {
  const parts = mcpToolParts(tool);
  if (!parts) return true;
  const raw = String(userText || '').toLowerCase();
  const norm = mentionNorm(userText);
  const fullRaw = parts.name.toLowerCase();
  const serverRaw = parts.server.toLowerCase();
  const fullNorm = mentionNorm(parts.name);
  const serverNorm = mentionNorm(parts.server);

  // MCP tools are opt-in only. The user must name the MCP server/tool, e.g.
  // "use h1b-sponsors" or "call mcp__h1b-sponsors__dataset_info".
  return raw.includes(fullRaw) ||
    raw.includes(serverRaw) ||
    norm.includes(fullNorm) ||
    norm.includes(serverNorm);
}

function filterMcpToolsForRequest(body) {
  if (!Array.isArray(body.tools) || body.tools.length === 0) return body;
  const userText = latestActionableUserText(body);
  const filtered = body.tools.filter(t => mcpToolAllowed(t, userText));
  if (filtered.length === body.tools.length) return body;

  const hidden = body.tools.length - filtered.length;
  const allowedNames = new Set(filtered.map(t => t && t.name).filter(Boolean));
  let toolChoice = body.tool_choice;
  if (toolChoice && toolChoice.type === 'tool' && !allowedNames.has(toolChoice.name)) {
    toolChoice = { type: 'auto' };
  }
  log('mcp filter: hidden', hidden, 'tool(s); available', filtered.length);
  return Object.assign({}, body, { tools: filtered, tool_choice: toolChoice });
}

function toolResultText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content);
  return content.map(block => {
    if (!block || typeof block !== 'object') return String(block);
    if (block.type === 'text') return block.text || '';
    if (block.type === 'image') return '[image omitted: backend is text-only]';
    if (block.text) return block.text;
    return '';
  }).filter(Boolean).join('\n');
}

// Build the OpenAI-style messages array (no tools param).
function toOpenAIMessages(body, opts = {}) {
  if (opts.nativeTools) return toNativeOpenAIMessages(body);
  const msgs = [];
  const hasTools = Array.isArray(body.tools) && body.tools.length;
  let sys = systemToText(body.system);
  if (hasTools) {
    sys = (sys ? sys + '\n\n' : '') + buildToolPrompt(body.tools);
  }
  if (sys) msgs.push({ role: 'system', content: sys });

  let lastActionableUserMsgIndex = -1;
  for (const m of body.messages || []) {
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    const text = contentToText(m.content);
    const idx = msgs.length;
    msgs.push({ role, content: text });
    if (role === 'user' && hasActionableUserContent(m.content)) {
      lastActionableUserMsgIndex = idx;
    }
  }
  if (hasTools && lastActionableUserMsgIndex !== -1) {
    const names = body.tools.map(t => t && t.name).filter(Boolean).join(', ');
    msgs[lastActionableUserMsgIndex] = Object.assign({}, msgs[lastActionableUserMsgIndex], {
      content: msgs[lastActionableUserMsgIndex].content + '\n\nTool reminder: Tools available: ' + names + '. If this request needs an action, output only <tool_call>{"name":"TOOL_NAME","arguments":{...}}</tool_call>. Do not explain, plan, enter plan mode, or claim the action is done.',
    });
  }
  return msgs;
}

function toNativeOpenAIMessages(body) {
  const msgs = [];
  const sys = systemToText(body.system);
  if (sys) msgs.push({ role: 'system', content: sys });

  for (const m of body.messages || []) {
    const converted = nativeMessageToOpenAI(m);
    for (const item of converted) msgs.push(item);
  }
  return msgs;
}

function nativeMessageToOpenAI(message) {
  const role = message.role === 'assistant' ? 'assistant' : 'user';
  const content = message.content;
  if (typeof content === 'string' || content == null || !Array.isArray(content)) {
    return [{ role, content: content == null ? '' : String(content) }];
  }

  const textParts = [];
  const toolCalls = [];
  const toolResults = [];

  for (const block of content) {
    if (!block || typeof block !== 'object') {
      textParts.push(String(block));
      continue;
    }
    switch (block.type) {
      case 'text':
        textParts.push(block.text || '');
        break;
      case 'thinking':
        if (block.thinking) textParts.push('<thinking>\n' + block.thinking + '\n</thinking>');
        break;
      case 'image':
        textParts.push('[image omitted: backend is text-only]');
        break;
      case 'tool_use':
      case 'server_tool_use':
        toolCalls.push({
          id: block.id || rid('call_'),
          type: 'function',
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input || {}),
          },
        });
        break;
      case 'tool_result':
      case 'web_search_tool_result':
        toolResults.push({
          role: 'tool',
          tool_call_id: block.tool_use_id || '',
          content: toolResultText(block.content),
        });
        break;
      default:
        if (block.text) textParts.push(block.text);
    }
  }

  const out = [];
  const text = textParts.filter(Boolean).join('\n');
  if (role === 'assistant') {
    if (text || toolCalls.length) {
      const assistant = { role: 'assistant', content: text || null };
      if (toolCalls.length) assistant.tool_calls = toolCalls;
      out.push(assistant);
    }
    out.push(...toolResults);
  } else {
    out.push(...toolResults);
    if (text) out.push({ role: 'user', content: text });
  }
  return out;
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

// Like toCall, but only returns a call whose name resolves (case-insensitively)
// to one of the allowed tools, with the name rewritten to its canonical form
// (so a model that emits "agent"/"explore" still maps to Agent/Explore).
function toAllowedCall(parsed, allowedNames) {
  const call = toCall(parsed);
  if (!call) return null;
  const canonical = canonicalToolName(call.name, allowedNames);
  if (!canonical) return null;
  call.name = canonical;
  return call;
}

// Scan free text for bare JSON tool calls: any balanced top-level {...} object
// with name+arguments, or a [...] array of such objects. Handles the case a
// weak model emits several calls back-to-back with no <tool_call> tags, e.g.
//   {"name":"Agent",...}{"name":"Agent",...}{"name":"Agent",...}
// Returns the calls in document order plus the spans they occupied so the
// caller can splice them out of the visible text.
function scanBareJsonCalls(str, allowedNames) {
  const calls = [];
  const spans = [];
  const s = String(str);
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '"' || ch === "'") {
      const q = readQuotedValue(s, i);
      if (!q) { i++; continue; }
      i = q.next;
      continue;
    }
    if (ch === '{' || ch === '[') {
      const closeCh = ch === '{' ? '}' : ']';
      const end = findGroupEnd(s, i, ch, closeCh);
      if (end === -1) break; // unbalanced tail: nothing more to extract
      const slice = s.slice(i, end + 1);
      const found = [];
      if (ch === '{') {
        const call = toAllowedCall(tryParseObj(slice), allowedNames);
        if (call) found.push(call);
      } else {
        const arr = tryParseObj(slice);
        if (Array.isArray(arr)) {
          for (const el of arr) {
            const call = toAllowedCall(el, allowedNames);
            if (call) found.push(call);
          }
        }
      }
      if (found.length) {
        for (const c of found) calls.push(c);
        spans.push([i, end + 1]);
      }
      i = end + 1;
      continue;
    }
    i++;
  }
  return { calls, spans };
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
// <tools> in the output is safe. A matched segment is removed from the text
// only when it parses into a valid, allowed tool call — ordinary code fences
// and quoted tags in prose stay in the answer.
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
    text = text.replace(re, (match, inner) => {
      const call = toAllowedCall(tryParseObj(inner), allowedNames);
      if (call) { toolCalls.push(call); return ''; }
      return match;
    });
  }
  // Bare JSON calls anywhere in the remaining text: one or many objects, or a
  // JSON array of calls, with no tags. Splice each consumed span out so any
  // surrounding prose survives; runs even when a tagged call was already found
  // so a mixed response captures both.
  {
    const { calls, spans } = scanBareJsonCalls(text, allowedNames);
    if (calls.length) {
      for (const s of spans.sort((a, b) => b[0] - a[0])) {
        text = text.slice(0, s[0]) + text.slice(s[1]);
      }
      for (const c of calls) toolCalls.push(c);
    }
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
  // Strip unclosed trailing tag noise, but only when this response actually
  // contained tool calls — otherwise a prose mention of the tags would nuke
  // the rest of the answer.
  if (toolCalls.length > 0) {
    text = text.replace(/<\/?(?:tool_call|tools|function_call)>[\s\S]*$/g, '');
  }
  text = text.trim();
  return { text, toolCalls };
}

function parseNativeToolCalls(message, tools) {
  const toolCalls = [];
  const allowedNames = new Set((Array.isArray(tools) ? tools : []).map(t => t && t.name).filter(Boolean));
  const rawCalls = Array.isArray(message && message.tool_calls) ? message.tool_calls : [];
  for (const tc of rawCalls) {
    const fn = tc && tc.function;
    if (!fn || !fn.name) continue;
    if (!allowedNames.has(fn.name)) continue;
    let args = fn.arguments;
    if (typeof args === 'string') {
      try { args = JSON.parse(args || '{}'); } catch (_) { args = { _raw: args }; }
    }
    if (args == null || typeof args !== 'object' || Array.isArray(args)) args = {};
    toolCalls.push({ id: tc.id || rid('toolu_'), name: fn.name, input: args });
  }

  let text = '';
  const content = message && message.content;
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) text = content.map(part => {
    if (typeof part === 'string') return part;
    if (part && typeof part === 'object') return part.text || '';
    return '';
  }).filter(Boolean).join('\n');

  return { text: text.trim(), toolCalls };
}

function mapToolChoice(choice) {
  if (!choice || typeof choice !== 'object') return undefined;
  switch (choice.type) {
    case 'auto':
      return 'auto';
    case 'any':
      return 'required';
    case 'none':
      return 'none';
    case 'tool':
      return choice.name ? { type: 'function', function: { name: choice.name } } : undefined;
    default:
      return undefined;
  }
}

// Decide whether a native-tools failure means "this backend can't do OpenAI
// tool calls" (fall back to emulated prompting) vs an unrelated error that
// should surface to the caller. Requires a tool-specific signal — a bare
// "invalid"/"unsupported" (e.g. "invalid model") must NOT trigger fallback.
function upstreamSupportsFallback(status, text) {
  if (status !== 400 && status !== 422) return false;
  return /tool[\s_-]?choice|tool[\s_-]?calls?|tool[\s_-]?use|function[\s_-]?call|tool-call-parser|--enable-auto-tool-choice|parser|tools?[^.]{0,40}support|support[^.]{0,40}tools?/i.test(text || '');
}

function latestUserMessage(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i] && messages[i].role === 'user') return messages[i];
  }
  return null;
}

function shouldRetryToolCall(raw, body) {
  if (!Array.isArray(body.tools) || body.tools.length === 0) return false;
  const latestUser = latestUserMessage(body);
  const user = latestUser && hasActionableUserContent(latestUser.content) ? contentToText(latestUser.content) : '';
  const actionRequest = user !== '' && /\b(use tools?|create|make|write|edit|read|inspect|summari[sz]e|understand|codebase|folder|file|bash|command)\b/i.test(user);
  // Only treat output as a fake action when it looks like actual tool-call
  // drift, not ordinary prose ("I created", "I'll") in a legitimate summary:
  //  - a Claude-Code-style pseudo call at the start of a line: Bash(...), Write(...)
  //  - a <tool_call tag that parseToolCalls failed to extract (malformed JSON)
  //  - a claim of entering plan mode without calling the tool
  const fakeActionText =
    /(?:^|\n)\s*(?:Bash|Write|Read|Edit|Glob|Grep|Task|WebFetch|TodoWrite)\s*\(/.test(raw) ||
    /<tool_call/i.test(raw) ||
    /\bEnterPlanMode\b/.test(raw);
  return actionRequest || fakeActionText;
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

function messageContent(m) {
  if (!m || m.content == null) return '';
  if (typeof m.content === 'string') return m.content;
  try { return JSON.stringify(m.content); } catch (_) { return String(m.content); }
}

function totalTokens(msgs) { return msgs.reduce((s, m) => s + approxTokens(messageContent(m)), 0); }

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

  // drop oldest until only the most recent message remains in `mid`;
  // when a dropped assistant message carried tool_calls, drop its dependent
  // `tool` role messages with it so the backend never sees an orphaned
  // tool result (OpenAI-compat servers reject those).
  let dropped = 0;
  while (mid.length > 1 && totalTokens(head.concat(mid)) > targetIn) {
    mid.shift();
    dropped++;
    while (mid.length > 1 && mid[0] && mid[0].role === 'tool') {
      mid.shift();
      dropped++;
    }
  }
  let out = head.concat(mid);
  if (dropped > 0) log('trim: dropped', dropped, 'old message(s)');

  // still over budget -> hard-truncate the longest message repeatedly
  let guard = 0;
  while (totalTokens(out) > targetIn && guard++ < 5000) {
    let idx = 0, max = -1;
    out.forEach((m, i) => {
      const content = messageContent(m);
      if (content.length > max) { max = content.length; idx = i; }
    });
    if (max < 200) break;
    const content = messageContent(out[idx]);
    const cut = Math.max(400, Math.floor(content.length * 0.15));
    out[idx] = Object.assign({}, out[idx], {
      content: content.slice(0, content.length - cut) + '\n…[trimmed to fit model context]',
    });
  }
  if (guard > 0) log('trim: hard-truncated to fit', targetIn, 'tok');
  return out;
}

async function handleMessages(req, res, body) {
  const reqId = rid('req_');
  const startedAt = Date.now();
  let transientRetries = 0;
  body = filterMcpToolsForRequest(body);
  const wantStream = body.stream === true;
  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
  const wantsNativeTools = hasTools && TOOL_MODE !== 'emulated' && (TOOL_MODE === 'native' || !nativeToolsKnownUnsupported);
  const allowEmulatedFallback = TOOL_MODE !== 'native';

  const summary = (status, extra) => structuredLog(Object.assign({
    rid: reqId, path: '/v1/messages', tool_mode: TOOL_MODE, has_tools: hasTools,
    stream: wantStream, status, ms: Date.now() - startedAt, retries: transientRetries,
  }, extra || {}));
  const fail = (status, message) => {
    summary(status, { error: message });
    if (!res.headersSent) res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message } }));
  };

  // Desired output headroom; Claude Code often asks for far more than fits.
  const reserveOut = Math.min(Math.max(body.max_tokens || 4096, 512), 4096);

  // Retry loop: trim input to a target, send; if the backend still reports a
  // context-length overflow (our char/4 estimate can undershoot the real
  // tokenizer), shrink the target and retry. Each runUpstream call gets its
  // own budget so a native-run shrink doesn't leak into the emulated fallback.
  const baseTargetIn = MODEL_CTX - reserveOut - CTX_MARGIN;
  let usedTargetIn = baseTargetIn;
  let upJson = null, lastErr = '', lastStatus = 500, msgs = null, usedNativeTools = false;

  const runUpstream = async (nativeTools) => {
    const baseMsgs = toOpenAIMessages(body, { nativeTools });
    let targetIn = baseTargetIn;
    let localMsgs = baseMsgs;
    let localErr = '', localStatus = 500;

    for (let attempt = 0; attempt < 4; attempt++) {
      localMsgs = trimToBudget(baseMsgs, targetIn);
      const inTok = totalTokens(localMsgs);
      const maxOut = Math.max(256, Math.min(reserveOut, MODEL_CTX - inTok - CTX_MARGIN));

      const upstreamReq = {
        model: UPSTREAM_MODEL,
        messages: localMsgs,
        max_tokens: maxOut,
        temperature: typeof body.temperature === 'number' ? (hasTools ? Math.min(body.temperature, 0.2) : body.temperature) : (hasTools ? 0.2 : 0.6),
        stream: false,
      };
      if (typeof body.top_p === 'number') upstreamReq.top_p = body.top_p;
      if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) {
        upstreamReq.stop = body.stop_sequences;
      }
      if (nativeTools) {
        upstreamReq.tools = anthropicToolsToOpenAI(body.tools);
        const choice = mapToolChoice(body.tool_choice);
        if (choice !== undefined) upstreamReq.tool_choice = choice;
        if (body.tool_choice && body.tool_choice.disable_parallel_tool_use) {
          upstreamReq.parallel_tool_calls = false;
        }
      }
      log('->upstream attempt', attempt, nativeTools ? 'native-tools' : 'emulated-tools', 'inTok~' + inTok, 'maxOut', maxOut);

      const up = await postUpstream(upstreamReq);
      transientRetries += up.retries || 0;
      if (up.timedOut) {
        return { status: 504, err: 'upstream timed out after ' + UPSTREAM_TIMEOUT_MS + 'ms', msgs: localMsgs };
      }
      if (up.networkError && !up.ok) {
        return { status: up.status || 502, err: 'upstream fetch failed: ' + up.networkError, msgs: localMsgs };
      }

      const upText = up.text || '';
      if (up.ok) {
        try {
          return { json: JSON.parse(upText), msgs: localMsgs, targetIn };
        } catch (_) {
          return { status: 502, err: 'bad upstream json', msgs: localMsgs };
        }
      }

      localErr = upText.slice(0, 500);
      localStatus = up.status;
      const overflow = up.status === 400 && /context length|input_tokens|maximum context/i.test(upText);
      if (overflow && attempt < 3) {
        targetIn = Math.floor(targetIn * 0.75); // shrink hard and retry
        log('upstream overflow -> retry with targetIn', targetIn);
        continue;
      }
      log('upstream error', up.status, localErr.slice(0, 200));
      return { status: localStatus, err: localErr, msgs: localMsgs };
    }

    return { status: localStatus, err: localErr, msgs: localMsgs };
  };

  let result = wantsNativeTools ? await runUpstream(true) : null;
  if (result && result.json) {
    upJson = result.json;
    msgs = result.msgs;
    usedTargetIn = result.targetIn;
    usedNativeTools = true;
  } else if (result && allowEmulatedFallback && upstreamSupportsFallback(result.status, result.err)) {
    log('native tools unavailable -> fallback to emulated tools');
    if (TOOL_MODE === 'auto') nativeToolsKnownUnsupported = true;
  } else if (result && !allowEmulatedFallback) {
    return fail(result.status || 500, 'upstream ' + (result.status || 500) + ': ' + result.err);
  } else if (result && !upstreamSupportsFallback(result.status, result.err)) {
    return fail(result.status || 500, 'upstream ' + (result.status || 500) + ': ' + result.err);
  }

  if (!upJson) {
    result = await runUpstream(false);
    if (result.json) {
      upJson = result.json;
      msgs = result.msgs;
      usedTargetIn = result.targetIn;
    } else {
      return fail(result.status || 500, 'upstream ' + (result.status || 500) + ': ' + result.err);
    }
  }

  if (!upJson) {
    return fail(lastStatus, 'upstream ' + lastStatus + ': ' + lastErr);
  }

  const upstreamMessage = (((upJson.choices || [])[0] || {}).message || {});
  let rawContent = upstreamMessage.content || '';
  let parsed = usedNativeTools ? parseNativeToolCalls(upstreamMessage, body.tools) : parseToolCalls(rawContent, body.tools);
  let outputTokens = (upJson.usage && upJson.usage.completion_tokens) || approxTokens(rawContent);
  let usage = { input_tokens: (upJson.usage && upJson.usage.prompt_tokens) || totalTokens(msgs), output_tokens: outputTokens };

  if (!usedNativeTools && hasTools && parsed.toolCalls.length === 0 && shouldRetryToolCall(rawContent, body)) {
    const retryMsgs = trimToBudget(msgs.concat([
      { role: 'assistant', content: rawContent || '[empty invalid response]' },
      {
        role: 'user',
        content: 'Invalid response: you did not call a tool. For this request, output exactly one tool call using the available tools. Use <tool_call>{"name":"TOOL_NAME","arguments":{...}}</tool_call>. No text.',
      },
    ]), usedTargetIn);
    const retryInTok = totalTokens(retryMsgs);
    const retryMaxOut = Math.max(256, Math.min(reserveOut, MODEL_CTX - retryInTok - CTX_MARGIN));
    const retryReq = {
      model: UPSTREAM_MODEL,
      messages: retryMsgs,
      max_tokens: retryMaxOut,
      temperature: 0,
      stream: false,
    };
    if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) {
      retryReq.stop = body.stop_sequences;
    }
    log('->upstream tool retry inTok~' + retryInTok, 'maxOut', retryMaxOut);
    try {
      const retryUp = await postUpstream(retryReq);
      transientRetries += retryUp.retries || 0;
      const retryText = retryUp.text || '';
      if (retryUp.ok) {
        const retryJson = JSON.parse(retryText);
        const retryRaw = (((retryJson.choices || [])[0] || {}).message || {}).content || '';
        const retryParsed = parseToolCalls(retryRaw, body.tools);
        log('<-retry parsed', retryParsed.toolCalls.length, 'tool calls,', retryParsed.text.length, 'chars text');
        if (retryParsed.toolCalls.length > 0) {
          rawContent = retryRaw;
          parsed = retryParsed;
          outputTokens = (retryJson.usage && retryJson.usage.completion_tokens) || approxTokens(retryRaw);
          usage = { input_tokens: (retryJson.usage && retryJson.usage.prompt_tokens) || totalTokens(retryMsgs), output_tokens: outputTokens };
        }
      } else {
        log('tool retry upstream error', retryUp.status, retryText.slice(0, 200));
      }
    } catch (e) {
      log('tool retry failed', e && e.message);
    }
  }
  const msg = buildAnthropicMessage(body.model || UPSTREAM_MODEL, parsed, usage);
  log('<-parsed', parsed.toolCalls.length, 'tool calls,', parsed.text.length, 'chars text');

  summary(200, {
    native: usedNativeTools, in_tok: usage.input_tokens, out_tok: usage.output_tokens,
    tool_calls: parsed.toolCalls.length, stop_reason: msg.stop_reason,
  });
  if (wantStream) {
    streamAnthropic(res, msg);
  } else {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(msg));
  }
}

function handleCountTokens(res, body) {
  body = filterMcpToolsForRequest(body);
  const openaiMsgs = toOpenAIMessages(body);
  const n = approxTokens(openaiMsgs.map(messageContent).join('\n'));
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ input_tokens: n }));
}

// Cheap upstream reachability probe for /ready (short timeout of its own).
async function probeUpstream() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const r = await fetch(UPSTREAM_BASE + '/models', { headers: upstreamHeaders(), signal: controller.signal });
    clearTimeout(timer);
    return { ready: r.ok, upstream_status: r.status };
  } catch (e) {
    clearTimeout(timer);
    return { ready: false, upstream_status: 0, error: (e && e.name === 'AbortError') ? 'timeout' : (e && e.message) };
  }
}

const server = http.createServer(async (req, res) => {
  const url = (req.url || '').split('?')[0];
  if (req.method === 'GET' && (url === '/health' || url === '/')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, model: UPSTREAM_MODEL, upstream: CHAT_URL }));
    return;
  }
  if (req.method === 'GET' && url === '/ready') {
    const probe = await probeUpstream();
    res.writeHead(probe.ready ? 200 : 503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(Object.assign({ model: UPSTREAM_MODEL }, probe)));
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

if (!TESTING) {
  // A single bad request must not take down a user's whole session.
  process.on('unhandledRejection', (reason) => {
    console.error('[proxy] unhandledRejection:', redact(reason && reason.stack ? reason.stack : String(reason)));
  });
  process.on('uncaughtException', (err) => {
    console.error('[proxy] uncaughtException:', redact(err && err.stack ? err.stack : String(err)));
  });

  let shuttingDown = false;
  const shutdown = (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error('[proxy] ' + sig + ' received, shutting down');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref(); // force-exit if connections linger
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  server.on('error', (e) => {
    console.error('[proxy] failed to listen on 127.0.0.1:' + PORT + ': ' + (e && e.message ? e.message : e));
    process.exit(1);
  });

  server.listen(PORT, '127.0.0.1', () => {
    console.error('[proxy] listening http://127.0.0.1:' + PORT + '  model=' + UPSTREAM_MODEL + '  upstream=' + CHAT_URL + (USER_EMAIL ? '  user=' + USER_EMAIL : ''));
  });
}

if (TESTING) {
  module.exports = {
    parseToolCalls,
    parseNativeToolCalls,
    parseFunctionStyleCalls,
    parseObjectStyleCalls,
    scanBareJsonCalls,
    toAllowedCall,
    canonicalToolName,
    tryParseObj,
    toCall,
    redact,
    trimToBudget,
    totalTokens,
    shouldRetryToolCall,
    upstreamSupportsFallback,
    mcpToolAllowed,
    filterMcpToolsForRequest,
    latestActionableUserText,
    hasActionableUserContent,
    toOpenAIMessages,
    toNativeOpenAIMessages,
    contentToText,
    buildAnthropicMessage,
    mapToolChoice,
  };
}
