# deepvariance-claude-code

Run [Claude Code](https://github.com/anthropics/claude-code) against a **self-hosted, OpenAI-compatible model** (e.g. `Qwen/Qwen2.5-Coder-32B-Instruct` on vLLM):

```
deepvariance launch claude
```

Claude Code speaks the **Anthropic Messages API**; your model speaks the **OpenAI Chat Completions API**. deepvariance runs a tiny local proxy that translates between them **and emulates tool-calling** (so file read/edit/bash work) even when the backend was started without vLLM's `--tool-call-parser`.

---

## Install

```
curl -fsSL https://raw.githubusercontent.com/ujjwalredd/deepvariance-claude-code/main/install.sh | bash
```

Requires **Node ≥ 18**. The installer also installs Claude Code (`@anthropic-ai/claude-code`) if it isn't already present, then installs the latest tagged deepvariance release.

Pin a release:

```
curl -fsSL https://raw.githubusercontent.com/ujjwalredd/deepvariance-claude-code/main/install.sh | DEEPVARIANCE_REF=v1.0.1 bash
```

Install from `main`:

```
curl -fsSL https://raw.githubusercontent.com/ujjwalredd/deepvariance-claude-code/main/install.sh | DEEPVARIANCE_REF=main bash
```

## Usage

```
deepvariance launch claude          # start proxy + Claude Code
deepvariance launch claude -p "..."  # non-interactive, pass Claude Code args
deepvariance config                 # re-enter API key / email / endpoint
deepvariance help
```

**First run** prompts for:

- **Model API base URL** — defaults to the bundled endpoint (editable)
- **Email** — sent as an `X-User-Email` header for usage logging (see below)
- **API key** — entered hidden

These are saved to `~/.deepvariance/config.json` (`chmod 600`). Nothing is committed to this repo and nothing is sent anywhere except your configured model endpoint.

## How it works

```
Claude Code ──Anthropic /v1/messages──▶ deepvariance proxy ──OpenAI /chat/completions──▶ your model (vLLM)
   ▲                                         │  • render Anthropic tools -> Hermes prompt
   │                                         │  • call backend WITHOUT `tools` (dodge missing-parser 400)                       │
   └────────── Anthropic response ◀──────────┘  • parse <tool_call> back into tool_use
                                                • cap output to the model context window
                                                • add X-User-Email header
```

Defaults live in [`config.default.json`](config.default.json): model, `apiBase`, `modelCtx` (context window), `port`.

## Usage logging

Every upstream request carries `X-User-Email: <your email>`. Your model server records it. This identifies who is driving requests — by using this tool you consent to that email + your usage being logged by the endpoint operator. There is no per-user auth isolation beyond the shared API key.

## Limitations

- **Tool-calling is emulated**, not native. Reliable for common flows, but complex multi-tool turns can occasionally malform. The rock-solid fix is to launch vLLM with `--enable-auto-tool-choice --tool-call-parser hermes` — then native tool calls work and this proxy is optional.
- **Context window** is bounded by the model (default 32K). Big repos / long sessions hit the cap; output is trimmed to fit.
- **`WebSearch` / `WebFetch` do not work** — those are Anthropic-hosted tools. For web access on a local model, add a search **MCP server** (e.g. Brave/Tavily).
- **No prompt caching, vision, or extended thinking** through the proxy.
- If your endpoint is a Cloudflare **quick-tunnel** (`*.trycloudflare.com`), its URL rotates on restart — update it with `deepvariance config`.

## Uninstall

```
rm -rf ~/.deepvariance ~/.local/bin/deepvariance
npm uninstall -g @anthropic-ai/claude-code   # optional
```

## Credits

Built on **[Claude Code](https://github.com/anthropics/claude-code)** by **Anthropic** (`@anthropic-ai/claude-code`). Claude Code is Anthropic's product and is used here under Anthropic's own terms.

**deepvariance-claude-code is an unofficial community wrapper. It is not affiliated with, endorsed by, or supported by Anthropic.** All it adds is a local translation + tool-emulation proxy and a launcher.

The tool-calling emulation approach is inspired by [Ollama](https://ollama.com)'s Anthropic-API compatibility and the Hermes / Qwen tool-call format.

## License

MIT (the wrapper — see [LICENSE](LICENSE)). Claude Code and the models you connect to are covered by their own licenses and terms.
