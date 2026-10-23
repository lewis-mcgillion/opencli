# OpenCLI

A terminal coding agent for local and hosted language models. It reads and edits files, runs shell and git commands, searches code, fetches web pages, and talks to MCP tool servers. It works with OpenAI-compatible endpoints (Ollama, LM Studio, llama.cpp), Azure OpenAI / Foundry OpenAI, and the Anthropic Messages API.

## Install

Development needs [Bun](https://bun.sh) 1.3 or newer.

```sh
bun install
bun run src/main.ts --help
bun run build
./dist/opencli --help
```

A standalone binary is written to `dist/opencli`. Add `dist` to your `PATH` to use the `opencli` commands below, or replace `opencli` with `bun run src/main.ts` when working from source. The package is currently private; global npm installation is not a supported install path.

For a local model, start Ollama and pull a model that supports tool calls:

```sh
ollama pull gemma4:e4b
```

## Use

```sh
opencli                                   # full-screen TUI on a terminal
opencli "rename parseDate to parseIso"    # run one task and exit
opencli -p --output-format json "..."     # machine-readable result for scripts
echo "summarise README.md" | opencli -p   # task from stdin
opencli -c                                # resume the last session in this directory
```

Inside the UI, type `/help` for commands. End a line with `\` to continue it, or use `/paste` for multi-line input. Mention files with `@./path` to include their contents.

## Configuration

Settings come from three layers, later layers overriding earlier ones:

1. `~/.opencli/config.json`: your defaults.
2. `.opencli/settings.json` in the project: shared with the team.
3. `.opencli/settings.local.json` in the project: personal, not for commit.

Environment variables override all of them: `OPENCLI_MODEL`, `OPENCLI_URL`, `OPENCLI_PROVIDER` (`openai`, `anthropic`, or `azure`), and `OPENCLI_API_KEY`. Provider-specific key fallbacks are `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and `AZURE_OPENAI_API_KEY`; explicit CLI flags override settings and environment for normal task runs.

Legacy configuration remains supported. See [Migration from LLMCLI](docs/migration.md) before creating new configuration directories.

```json
{
  "provider": "openai",
  "model": "gemma4:31b",
  "url": "http://localhost:11434/v1",
  "contextWindow": 32768,
  "maxOutputTokens": 8192,
  "repoMap": true,
  "tui": true,
  "verifyCommand": "bun test",
  "sandbox": { "enabled": "auto", "network": false, "writable": [] },
  "permissions": {
    "allow": ["run_bash(npm test*)"],
    "ask": ["run_bash(npm publish*)"],
    "deny": ["run_bash(rm -rf /*)", "web_fetch(https://internal.example.com/*)"]
  },
  "hooks": {
    "pre_tool": [{ "tool": "run_bash", "command": "./scripts/check-command.sh" }],
    "post_tool": [],
    "on_stop": [{ "command": "bun run check" }]
  },
  "mcpServers": {
    "docs": { "command": "npx", "args": ["-y", "some-mcp-server"], "timeoutSeconds": 60, "allowTools": ["search"] }
  },
  "prices": { "some-cloud-model": { "inputPerMTok": 3, "outputPerMTok": 15 } }
}
```

### Trust for project settings

A project's `.opencli/` settings can start processes (MCP servers, hooks, `verifyCommand`) and change permissions and the sandbox. Those keys are ignored until you trust the project. Interactive runs ask once; headless runs print a warning and skip them. Trust is stored per directory in `~/.opencli/trust.json` and is revoked automatically when the project's settings change.

## Provider profiles

`opencli models list` prints the built-in provider profiles (`local-openai`, `openai`, `azure-openai`, `anthropic`). `opencli models test <profile>` sends a small, potentially billable request without tools. Set `OPENCLI_MODEL`, `OPENCLI_URL`, and `OPENCLI_PROVIDER` for the target provider, plus its API key, before testing. A successful reply checks basic connectivity, not tool-call support or coding quality. Profile context sizes are defaults; adjust them for your chosen model.

### Local OpenAI-compatible servers

Use a loaded model with tool-call support and the server's model ID:

```sh
OPENCLI_PROVIDER=openai OPENCLI_URL=http://localhost:11434/v1 \
  OPENCLI_MODEL=gemma4:e4b opencli "summarise README.md"
```

| Server | Setup | Typical base URL |
| --- | --- | --- |
| Ollama | Start Ollama and pull a tool-capable model | `http://localhost:11434/v1` |
| LM Studio | Load a model and start its local API server | `http://localhost:1234/v1` |
| llama.cpp | Start `llama-server` with a model and a chat template that supports tool calls | `http://localhost:8080/v1` |

Replace the URL and model above for your server. Set `OPENCLI_API_KEY` if authentication is enabled. The adapter uses streaming Chat Completions; compatibility depends on the model and server configuration.

### Hosted providers

Supply secrets through your environment rather than committing them to project settings. For any hosted OpenAI-compatible endpoint, set `OPENCLI_PROVIDER=openai`, its `/v1` base URL, model ID, and `OPENCLI_API_KEY`. For the OpenAI API:

```sh
export OPENCLI_PROVIDER=openai
export OPENCLI_URL=https://api.openai.com/v1
export OPENCLI_MODEL=YOUR_MODEL_ID
export OPENCLI_API_KEY="$OPENAI_API_KEY"
opencli models test openai
```

For Anthropic, set `ANTHROPIC_API_KEY` first:

```sh
export OPENCLI_PROVIDER=anthropic
export OPENCLI_URL=https://api.anthropic.com/v1
export OPENCLI_MODEL=YOUR_CLAUDE_MODEL_ID
export OPENCLI_API_KEY="$ANTHROPIC_API_KEY"
opencli models test anthropic
```

The current Anthropic adapter returns a complete response rather than streaming text.

For an Azure OpenAI deployment in Azure OpenAI or Foundry, set `AZURE_OPENAI_API_KEY` first:

```sh
export OPENCLI_PROVIDER=azure
export OPENCLI_URL=https://YOUR-RESOURCE.openai.azure.com/openai/v1
export OPENCLI_MODEL=YOUR_DEPLOYMENT_NAME
export OPENCLI_API_KEY="$AZURE_OPENAI_API_KEY"
opencli models test azure-openai
```

Use the OpenAI v1 base URL supplied by your resource, without `/chat/completions`; the model value is the deployment name. Azure mode sends an `api-key` header. Microsoft Entra token authentication and arbitrary Foundry model APIs are not implemented. Some reasoning deployments may need request options this adapter does not expose.

### Rate limits and retries

Model requests retry HTTP 429, selected transient HTTP errors, and connection failures, up to six attempts. Delays use `Retry-After` (seconds or HTTP date), `retry-after-ms`, or Azure's `x-ms-retry-after-ms` when valid; otherwise they use exponential backoff. Each delay is capped at 60 seconds, so longer server-requested waits are shortened. Retries do not increase your quota or automatically switch models. If limits persist, reduce concurrent agents and request volume, wait for your quota to recover, or choose another deployment with available quota.

### Project instructions

`AGENTS.md`, `OPENCLI.md`, and legacy `LLMCLI.md` in the project root are appended to the system prompt, in that order, when present. Rename the legacy file when migrating to avoid loading duplicate instructions. `--show-system` prints the full prompt, and `--show-config` prints the resolved settings.

## Modes

| Mode | Behaviour |
| --- | --- |
| `regular` (default) | Reads and searches run freely. Edits show a diff and ask. Shell commands run freely only if they are read-only; anything else asks. |
| `plan` | The agent writes a plan with no tools. You approve it before anything runs. |
| `auto` | Approves everything. Requires `--allow-auto`. Deny rules still apply. |

Set it with `--mode`, `/mode`, or Shift+Tab in the TUI.

## Safety model

- **Shell commands are analysed, not pattern-matched.** `src/shell-guard.ts` splits a command into segments on `;`, `&&`, `|`, subshells and substitutions, then classifies each one. Read-only commands pass. `git push`, `git -C . push`, `rm -rf`, `find -delete`, `python -c`, output redirects to files, and unparseable input all ask.
- **Allow rules only cover simple commands.** `run_bash(npm test*)` will not approve `npm test && rm -rf x`. Deny and ask rules check every segment.
- **Sandbox.** On macOS, shell commands run under `sandbox-exec` with writes limited to the project and temp directories and outbound network denied. Linux uses `bwrap` when installed. Use `sandbox.writable` to add directories, `sandbox.network: true` to allow network, or `--no-sandbox` to turn it off.
- **Web fetches are checked.** Loopback, private, link-local and cloud-metadata addresses are refused, including on redirects. To allow one, add an explicit rule such as `web_fetch(http://localhost:11434/*)`.
- **Edits are reviewable.** Each edit shows a unified diff before it is written. `/undo` reverts the last turn's file changes.
- **Hooks can block.** A `pre_tool` hook that exits with code 2 blocks the call, and its stderr is returned to the model.

What this does not protect against: a sandbox is only as strong as its backend, and `auto` mode should only be used in a disposable checkout.

## Slash commands

| Command | Purpose |
| --- | --- |
| `/model [name]` | Show or set the model |
| `/mode [regular\|plan\|auto]` | Show or set the mode |
| `/context` | Conversation summary and token estimate |
| `/usage` | Token totals, and cost when prices are configured |
| `/compact` | Summarise the conversation now (also happens automatically near the context limit) |
| `/undo` | Revert the files changed by the last turn |
| `/todos` | Show the todo list the agent keeps |
| `/save <name>`, `/load <name>`, `/sessions` | Named sessions in `~/.opencli/sessions` |
| `/sandbox` | Show sandbox status |
| `/tools` | List tools |
| `/mcp` | List MCP servers and their tools |
| `/reset` | Clear the conversation |
| `/help`, `/exit` | Help and quit |

Custom commands are Markdown files in `.opencli/commands/` (project) or `~/.opencli/commands/` (user). `$ARGUMENTS` is replaced by the text after the command name. A frontmatter line `allowed-tools: read_file, grep_files` restricts the tools for that turn. MCP prompts also appear as commands, named `server:prompt`.

## Tools

| Tool | Kind | Notes |
| --- | --- | --- |
| `read_file`, `list_dir`, `glob_files`, `grep_files` | read | Uses `rg` when installed |
| `write_file`, `edit_file`, `replace_lines`, `insert_lines` | write | Diff preview and approval |
| `run_bash`, `git` | exec | Analysed by the shell guard; `background: true` starts a job |
| `bash_output`, `bash_kill` | read / exec | Read or stop a background job |
| `web_fetch` | network | HTTP and HTTPS only, private addresses refused by default |
| `todo_write` | meta | Keeps a checklist for multi-step work |
| `task` | meta | Runs a read-only subagent for broad searches |
| `mcp__<server>__<tool>`, `mcp_read_resource` | from config | Tools from MCP servers |

## Headless use and exit codes

With `-p`, opencli runs one task and exits. `--output-format json` prints one result object; `stream-json` prints one event per line.

| Exit code | Meaning |
| --- | --- |
| 0 | Task finished |
| 1 | Error |
| 2 | Turn limit (`--max-turns`) or cost limit (`--max-cost`) reached |
| 3 | Task finished, but at least one action was denied |

Other flags: `--allowed-tools`, `--file`, `--resume <name>`, `--no-repo-map`, `--tool <name> '<json>'` to run one tool directly.

## Tests and evals

```sh
bun test            # unit and end-to-end tests; the CLI tests use a fake model server
bun run check       # type check (needs @types/bun installed)
bun run eval -- --model gemma4:31b   # real-model task suite, see evals/README.md
```

The eval suite is 30 small coding tasks checked by their results on disk, not by the model's wording. Results are recorded per run under `evals/results/`.

## Project layout

| Path | Contents |
| --- | --- |
| `src/main.ts` | Argument parsing, headless and interactive entry points, exit codes |
| `src/agent.ts` | Turn loop, verify-after-edit, subagents, compaction |
| `src/execute.ts` | Single path for every tool call: validation, permissions, approval, hooks |
| `src/permissions.ts`, `src/shell-guard.ts`, `src/net-guard.ts`, `src/sandbox.ts` | Safety |
| `src/tools/` | Tool implementations |
| `src/model/` | OpenAI-compatible, Azure, and Anthropic providers, retries, text tool-call fallback |
| `src/mcp/` | MCP stdio client and manager |
| `src/ui/` | Plain text, JSON, TUI and REPL front ends |
| `tests/`, `evals/` | Tests and the eval suite |

## Status

This is a development project. Tests use fake model servers; passing them does not establish live provider compatibility. Before a release, validate the standalone binary, interactive TUI, supported sandbox backends, and live local and cloud deployments in the target environment. Model evals require a running endpoint and may incur charges.

Current implementation work and verification gates are in [PLAN.md](PLAN.md). Future features in [COMPREHENSIVE_PLAN.md](COMPREHENSIVE_PLAN.md) are roadmap targets rather than supported commands.
