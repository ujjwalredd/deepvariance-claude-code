# deepvariance-claude-code

Run [Claude Code](https://github.com/anthropics/claude-code) against a **self-hosted, OpenAI-compatible model** (e.g. `Qwen/Qwen2.5-Coder-32B-Instruct` on vLLM):

```
deepvariance launch claude
```

Claude Code speaks the **Anthropic Messages API**; your model speaks the **OpenAI Chat Completions API**. deepvariance runs a tiny local proxy that translates between them and supports tool-calling (so file read/edit/bash work). It tries native OpenAI tool calls first when available, then falls back to Ollama-style prompt parsing when the backend was started without vLLM's `--tool-call-parser`. Responses **stream token-by-token**; in emulated mode a hold-back buffer keeps tool-call tags from leaking into the visible answer.

`deepvariance launch claude` starts Claude Code in `--safe-mode` by default. This disables user hooks, plugins, MCP servers, custom agents, skills, and other Claude Code customizations so unrelated local setup cannot hijack prompts.

---

## Install

**Via npm** (works with `npx`, no copy step):

```
npm install -g deepvariance-claude-code
# or run without installing:
npx deepvariance-claude-code launch claude
```

**Via the curl installer:**

```
curl -fsSL https://github.com/ujjwalredd/deepvariance-claude-code/raw/refs/heads/main/install.sh | bash
```

Both require **Node ≥ 18** and install Claude Code (`@anthropic-ai/claude-code`) if it isn't already present. Config is saved to `~/.deepvariance/config.json` either way.

## Usage

```
deepvariance launch claude                  # start proxy + Claude Code in safe mode
deepvariance launch claude -p "..."          # non-interactive, pass Claude Code args
deepvariance launch claude --no-safe-mode    # opt out of safe mode for this session
deepvariance config                         # re-enter API key / email / endpoint
deepvariance doctor                         # preflight: node, claude, config, upstream
deepvariance stop                           # stop a running proxy
deepvariance help
```

Safe mode prevents user-level Claude Code hooks, plugins, MCP servers, custom agents, skills, and workflows from taking over generic prompts. Pass `--no-safe-mode` only when you intentionally want your local Claude Code customizations loaded.

**First run** prompts for:

- **Model API base URL** — your OpenAI-compatible endpoint, e.g. `https://your-host/v1` (required; must be reachable)
- **Email** — sent as an `X-User-Email` header for usage logging (see below)
- **API key** — entered hidden

These are saved to `~/.deepvariance/config.json` (`chmod 600`). Nothing is committed to this repo and nothing is sent anywhere except your configured model endpoint.

## How it works

```
Claude Code ──Anthropic /v1/messages──▶ deepvariance proxy ──OpenAI /chat/completions──▶ your model (vLLM)
   ▲                                         │  • native OpenAI tools when supported
   │                                         │  • otherwise render Anthropic tools -> Hermes prompt
   └────────── Anthropic response ◀──────────┘  • parse native tool_calls or <tool_call> back into tool_use
                                                • cap output to the model context window
                                                • add X-User-Email header
```

Defaults live in [`config.default.json`](config.default.json): model, `apiBase`, `modelCtx` (context window), `toolMode`, `port`.

`maxOutputTokens` (default 8192) caps the output headroom reserved from the context window; raise it for models/tasks that need longer answers.

Optional environment overrides on the proxy: `MAX_OUTPUT_TOKENS` (output ceiling, default 8192), `UPSTREAM_TIMEOUT_MS` (per-call timeout, default 120000), `UPSTREAM_RETRIES` (extra retries on transient 5xx/429, default 2), `PROXY_LOG_FILE` (append structured request logs to a file), `PROXY_DEBUG=1` (verbose logs). The proxy always emits one structured JSON log line per request to stderr (the API key is redacted). Endpoints: `GET /health` (process up), `GET /ready` (probes the upstream `/models`).

`toolMode` values:

- `auto` — try native upstream tool calls first, fall back to emulated prompt parsing on parser/tool errors.
- `native` — require upstream OpenAI tool calls. Best when vLLM is launched with `--enable-auto-tool-choice --tool-call-parser hermes`.
- `emulated` — always use prompt-based Ollama/Hermes-style tool parsing.

MCP tools are hidden from the model by default. A configured MCP server/tool is exposed only when the most recent user *instruction* explicitly names that MCP server or tool, for example `use h1b-sponsors` or `call mcp__h1b-sponsors__dataset_info`. The opt-in persists for the whole agentic turn (tool-result continuations included) and resets when you send a new instruction that doesn't name it.

## Usage logging

Every upstream request carries `X-User-Email: <your email>`. Your model server records it. This identifies who is driving requests — by using this tool you consent to that email + your usage being logged by the endpoint operator. There is no per-user auth isolation beyond the shared API key.

## Limitations

- **Tool-calling can be native or emulated.** Native is best when the backend supports OpenAI tools. Emulated mode is useful for backends started without vLLM's `--enable-auto-tool-choice --tool-call-parser hermes`. The proxy recovers many malformed shapes (tagged, function-style, object-style, and one or more bare JSON calls), but a weak model can still produce tool JSON the parser can't recover.
- **Plan mode and parallel multi-agent (sub-agent) flows are unreliable on small local models.** Their heavy system prompts push the model into emitting several malformed tool calls at once. Prefer normal mode for local models (`Shift+Tab` toggles plan mode in Claude Code).
- **Context window** is bounded by the model (default 32K). Big repos / long sessions hit the cap; output is trimmed to fit.
- **`WebSearch` / `WebFetch` do not work** — those are Anthropic-hosted tools. For web access on a local model, add a search **MCP server** (e.g. Brave/Tavily).
- **MCP tools are opt-in per task turn** — deepvariance filters configured MCP tools unless the most recent user instruction explicitly names that MCP server/tool. This prevents unrelated MCPs from being picked for generic requests.
- **No prompt caching, vision, or extended thinking** through the proxy.
- If your endpoint is a Cloudflare **quick-tunnel** (`*.trycloudflare.com`), its URL rotates on restart — update it with `deepvariance config`.

## Development

Zero-dependency test suite using Node's built-in test runner:

```
npm test          # unit tests (tool-call parsing, trimming, MCP filtering)
                  # + integration tests (proxy vs. mock upstream)
                  # + launcher tests under /bin/bash (bash 3.2 compatible)
```

Individual suites:

```
node --test                      # JS tests only
bash test/launcher.test.sh       # launcher/arg-handling tests only
```

## Uninstall

```
rm -rf ~/.deepvariance ~/.local/bin/deepvariance
npm uninstall -g @anthropic-ai/claude-code   # optional
```

## Credits

Built on **[Claude Code](https://github.com/anthropics/claude-code)** by **Anthropic** (`@anthropic-ai/claude-code`). Claude Code is Anthropic's product and is used here under Anthropic's own terms.

**deepvariance-claude-code is an unofficial community wrapper. It is not affiliated with, endorsed by, or supported by Anthropic.** All it adds is a local translation + tool-emulation proxy and a launcher.

The launcher and tool-call compatibility approach is inspired by [Ollama](https://ollama.com)'s Anthropic-API compatibility and the Hermes / Qwen tool-call format.

## License

MIT (the wrapper — see [LICENSE](LICENSE)). Claude Code and the models you connect to are covered by their own licenses and terms.
