# llmcli plan: Q4 2026 to Q3 2027

Goal: llmcli is a terminal coding agent that a developer can rely on for daily work with a local model, and that holds up against Claude Code, Codex CLI, Aider, Gemini CLI, and OpenCode on the workflows they share. Where we cannot match a feature, we say so and pick the local-first equivalent.

## Where we are

Verified on 2026-10-22:

- `npm test`, `npm run check`, and `--selftest` pass.
- A live run against `gemma4:31b` read a file with `read_file` and answered correctly.
- The agent works end to end: streaming, tool calls, plan mode, sessions, compaction, MCP, and the TUI are all implemented.

The gaps are in reliability, safety, and the features that make the leading tools feel fast on real repositories.

### Defects found in the audit

| # | Severity | Finding | Where |
| --- | --- | --- | --- |
| D1 | High | Positional one-shot prompt is dropped unless `--mode` is also given; the program opens the REPL instead. | `llmcli.ts` `main()`, the `oneShot` filter |
| D2 | High | Shell guard is a regex denylist. `git -C . push`, `git --no-pager reset --hard`, `rm -- -rf x`, `find . -delete`, and `python3 -c` all pass. | `DANGEROUS` in `llmcli.ts` |
| D3 | Medium | `/load` on a corrupt session file throws an uncaught `SyntaxError`. | `COMMANDS.load` |
| D4 | Medium | `web_fetch` will fetch `localhost`, link-local, and cloud metadata addresses, with no restriction. | `HANDLERS.web_fetch` |
| D5 | Medium | `auto` mode approves every confirmation, including destructive commands. | `COMMANDS.mode`, `cycleMode` |
| D6 | Medium | Edits are written with no diff shown and no undo. | `guardedWrite` |
| D7 | Low | Hard-coded `~/llmcli` paths in the system prompt and roadmap. The repo is `opencli`. | `SYSTEM_BASE`, `ROADMAP.md`, `AUTO.md` |
| D8 | Low | Default model differs between `llmcli.ts` (`gemma4:e4b`) and `auto.ts` (`gemma4:31b`). | both files |
| D9 | Low | Roadmap checks grep the source for strings rather than testing behaviour. | `ROADMAP.md` |
| D10 | Low | No tests for slash commands, the REPL, the TUI, MCP, or retry logic. | `tests/run.ts` |
| D11 | Low | 956 lines in one file makes review and self-editing risky. | `llmcli.ts` |

### Capability gap against leading tools

| Capability | Leading tools | llmcli today | Target |
| --- | --- | --- | --- |
| Diff preview and approve edits | Standard | None | Q4 2026 |
| Undo or checkpoint | Standard | None | Q1 2027 |
| Permission rules (allow and deny patterns per tool) | Standard | Denylist only | Q4 2026 |
| Real sandbox for shell | Codex (seatbelt, Linux sandbox); others partial | None | Q3 2027 |
| Automatic context compaction | Standard | Manual `/compact` | Q1 2027 |
| Repo map or codebase index | Aider, most others | None | Q1 2027 |
| Layered config (user, project, local) | Standard | User file and env only | Q4 2026 |
| Project instructions file | `CLAUDE.md`, `AGENTS.md`, `GEMINI.md` | `LLMCLI.md` only | Q4 2026 (also read `AGENTS.md`) |
| Resume last session | Standard | Manual `/save` and `/load` | Q1 2027 |
| Headless output (JSON, exit codes) | Standard | Plain text only | Q2 2027 |
| Custom slash commands from files | Standard | Compiled-in only | Q2 2027 |
| Hooks on tool events | Claude Code, Gemini CLI | None | Q2 2027 |
| Subagents with isolated context | Claude Code, others | None | Q2 2027 |
| MCP (tools, resources, prompts, reconnect) | Standard | Tools only, no reconnect | Q2 2027 |
| Multiple providers (Anthropic, OpenAI, local) | Most | Any OpenAI-compatible endpoint | Q1 2027 |
| Handling models that emit tool calls as text | Varies | None | Q1 2027 |
| Editor integration (ACP or similar) | Several | None | Q3 2027 |
| Cost and token reporting | Standard | Per-call token line only | Q1 2027 |

## Principles

1. **Local first, not local only.** Every feature works against an OpenAI-compatible local endpoint. Cloud providers are added as adapters, not as requirements.
2. **Measure the model, not just the code.** A fixed task suite run against a fixed model set decides whether a change made the agent better. Unit tests alone do not.
3. **Safe by default.** Anything that writes outside the project, runs a process, or reaches the network needs an explicit rule or approval. A denylist alone never counts as protection.
4. **Small, reviewable changes.** The self-editing loop only ships changes that pass the eval suite, not just the compile check.
5. **Say what it cannot do.** Where a model is too weak for a task, the agent reports that and stops rather than guessing.

## Q4 2026 (October to December): Trust

Goal: the basics are correct, safe to run on a real repository, and measurable.

Exit criteria:

- D1 to D5 fixed, each with a regression test.
- A tool-use eval suite of at least 30 tasks runs in CI with a recorded pass rate per model.
- `llmcli.ts` is split into modules, and each module is under 400 lines.
- Edits show a diff and require approval in `regular` mode.
- Permission rules can be set per tool and per command pattern in config.

Workstreams:

1. **Correctness.** Fix D1 (argv handling), D3 (wrap command errors and report them as text), and D7 and D8 (one default, one set of paths).
2. **Safety.** Replace the regex guard with argv-aware parsing for `git` and `rm`, and add `find -delete`, `python -c`, and interpreter one-liners to the approval list. Add an allow and deny rules file. Block `web_fetch` to loopback, link-local, and private ranges unless a rule permits it. Make `auto` mode require an explicit flag and print a warning.
3. **Edits.** Show a unified diff before writing. Accept, reject, or edit per change in `regular` mode. `plan` mode keeps its current approval step.
4. **Config.** Layered settings: user (`~/.llmcli/config.json`), project (`.llmcli/settings.json`), and local (`.llmcli/settings.local.json`, git-ignored). Read `AGENTS.md` alongside `LLMCLI.md`.
5. **Structure.** Split `llmcli.ts` into `config`, `tools/`, `commands/`, `model/`, `mcp/`, `ui/repl`, `ui/tui`, and `main`. Keep behaviour identical; the existing tests must still pass unchanged.
6. **Tests and evals.** Add command tests (piped stdin, as the roadmap already does), a fake-model harness so tests run without Ollama, and the tool-use eval suite. Replace grep-based roadmap checks with behavioural ones (D9). Add lint and format (ESLint, Prettier) and a GitHub Actions workflow that runs `npm test`, `npm run check`, and the fake-model tests on every push.
7. **Self-editing.** Keep the feature, but gate it. The runner must pass the eval suite before it accepts a change. Snapshots move out of the repo into a git-ignored directory.

Risks: splitting the file while the self-editing loop is still active could break it. Freeze the self-editing loop during the split.

## Q1 2027 (January to March): Daily-driver quality

Goal: a developer can work a real repository from start to finish without leaving the tool.

Exit criteria:

- Checkpoints and `/undo` restore the working tree to any previous turn.
- Automatic compaction triggers at 80 percent of the model's context window and keeps the task state.
- A repo map (file tree with top-level symbols) is included in the system prompt within a token budget.
- The eval pass rate for `gemma4:31b` is at least 80 percent on the Q4 suite, and the `gemma4:e4b` rate is recorded.
- Session resume with `--continue` returns to the last session in that directory.

Workstreams:

1. **Checkpoints.** Snapshot changed files before each turn into a git-ignored store, or use `git stash create` when the tree is a git repo. `/undo` and `/checkpoints` commands.
2. **Context management.** Track tokens per message against the model's window. Automatic compaction with a summary that keeps the current goal, open files, and todo list. `/context` shows the budget.
3. **Repo map.** Walk the project honouring `.gitignore`. Extract top-level definitions with a lightweight parser (tree-sitter bindings or ctags). Cache by file mtime.
4. **Search.** Use `rg` when installed and fall back to `grep`. Add a `--max-count` limit and file-type filters to `grep_files`.
5. **Providers.** Adapters for OpenAI, Anthropic, and generic OpenAI-compatible endpoints. Per-model profile recording context window, tool-call support, and whether streaming is supported.
6. **Tool-call fallback.** When a model writes a tool call as plain text (a common failure in small local models), parse it and re-issue the call, or ask the model to retry with the schema. Count how often this happens in the eval suite.
7. **Cost and usage.** Session totals for input and output tokens. For cloud providers, an estimated cost from a checked-in price table with a date.
8. **Resume.** `--continue` and `--resume <name>` flags. Sessions store the model, mode, and checkpoint id.
9. **UI.** Markdown rendering in the TUI and plain REPL (code blocks, headings, lists). Diff rendering with colour.

Risks: repo map and compaction both change prompt content. Both must be gated on the eval suite, or quality may drop without anyone noticing.

## Q2 2027 (April to June): Extensibility and automation

Goal: teams can script llmcli, extend it, and run it in CI.

Exit criteria:

- `--output-format json` produces a documented schema, and exit codes are defined for success, tool failure, and user denial.
- Custom slash commands load from `.llmcli/commands/*.md`, with `$ARGUMENTS` substitution.
- Hooks run on `pre_tool`, `post_tool`, and `on_stop` and can block a tool call.
- A `task` tool runs a subagent with its own history, a tool subset, and a token budget, and returns a summary.
- MCP servers reconnect after failure, support resources and prompts, and have per-server timeouts and tool allowlists.
- A CI example runs llmcli to fix a failing test in a sample repository.

Workstreams:

1. **Headless mode.** `--output-format text|json|stream-json`. Stable exit codes. `--max-turns`, `--max-cost`, and `--allowed-tools` flags for unattended runs.
2. **Commands.** Markdown files with frontmatter for description and allowed tools. Project and user scopes.
3. **Hooks.** Configured in settings. Each hook receives JSON on stdin and can return allow, deny, or a message.
4. **Subagents.** `task` tool with isolated history and a summary return. Limit depth to one by default.
5. **MCP.** Reconnect with backoff. Support `resources/list` and `prompts/list`. Surface MCP prompts as slash commands.
6. **Verification loop.** Optional `verify_command` in project settings. After edits, run it and feed failures back to the agent, with a turn cap.
7. **Background processes.** `run_bash` with `background: true` returns a handle. `bash_output` and `bash_kill` tools.

Risks: hooks and custom commands run user-supplied code. Document the trust model and require project settings to be approved once per directory.

## Q3 2027 (July to September): Sandbox, reach, and polish

Goal: llmcli is safe enough to run unattended on a developer's machine, is easy to install, and works in an editor.

Exit criteria:

- `run_bash`, `git`, and tools that write files run under a sandbox by default on macOS and Linux. Opt-out is explicit and logged.
- Network access for shell commands follows a policy (deny by default, allow listed hosts).
- Install with `npm install -g llmcli` and a `llmcli` binary on `PATH`.
- Startup to first prompt is under 500 ms on a warm cache. Measure and publish.
- llmcli works as an agent in at least one editor through the Agent Client Protocol or an equivalent.
- An external security review has been done and high-severity findings are closed.
- A public benchmark result is published with the model, hardware, and task suite.

Workstreams:

1. **Sandbox.** macOS: `sandbox-exec` profile generated from the project root and allowed paths. Linux: `bubblewrap` if present. Windows is out of scope; document WSL.
2. **Network policy.** Applies to `run_bash`, `git`, and `web_fetch` from one configuration.
3. **Packaging.** `bin` entry, a prebuilt bundle (esbuild, already in the dependency tree), versioned releases, and a changelog.
4. **Performance.** Lazy-load the TUI and MCP. Measure `tsx` cost against a bundled build and ship the faster one.
5. **Editor integration.** Agent Client Protocol server mode. Prototype with one editor first.
6. **Security review.** Threat model covering prompt injection through files and web content, malicious MCP servers, and malicious project settings. Fix or document each finding.
7. **Docs.** Documentation site generated from the README and command help. Tutorial for a local-only setup.
8. **Benchmark.** Publish results on a fixed subset of a public coding benchmark with the local models used, and rerun on each release.

Risks: sandbox behaviour varies between macOS versions and Linux distributions. Keep the sandbox opt-out explicit and tested on each supported platform, or do not ship it as the default.

## Metrics

| Metric | Q4 2026 | Q1 2027 | Q2 2027 | Q3 2027 |
| --- | --- | --- | --- | --- |
| Eval pass rate, `gemma4:31b`, fixed suite | recorded | 80% | 85% | 90% |
| Known high-severity defects open | 0 | 0 | 0 | 0 |
| Test coverage of commands and tools | recorded | 70% | 80% | 85% |
| Median time from prompt to first tool call | recorded | no regression | no regression | no regression |
| Tool-call failures recovered without user input | recorded | 50% | 70% | 85% |

## Immediate next steps

These are the first items for Q4 2026, in order:

1. Fix D1 (positional prompt) and D3 (`/load` error handling). Add tests for both.
2. Make the shell guard argv-aware (D2) and add a test table of commands that must be blocked.
3. Block loopback and link-local addresses in `web_fetch` (D4).
4. Set `auto` mode behind an explicit flag (D5).
5. Build the fake-model harness and the first 10 eval tasks.

## Decisions needed

These affect scope. The plan assumes the defaults shown.

1. **Audience.** Default assumes a single developer on their own machine. If the target is a team, Q2 gets much heavier on shared config and audit logging.
2. **Cloud providers.** Default assumes local models stay the primary target and cloud providers are secondary adapters. If cloud is primary, the eval suite and cost tracking move earlier.
3. **Self-editing.** Default keeps it, gated behind the eval suite. If you want it removed, Q4 loses the self-edit workstream and gains time for the split.
4. **Distribution.** Default is npm. A standalone binary changes the Q3 packaging work.

## Decisions taken

Recorded on 2026-10-22 when the plan was executed.

1. **Self-editing loop removed.** `auto.ts`, `AUTO.md`, `ROADMAP.md`, and the self-edit guard are gone from the new code. The old files still exist on disk until removal is approved (see Status).
2. **Standalone binary.** Built with `bun build --compile`. Node SEA and `pkg` were not evaluated.
3. **Bun is the toolchain.** Dev, tests, and the binary all use Bun. The code uses only Node-compatible APIs.
4. **No new dependencies.** No ESLint or Prettier. Type checking is `tsc --strict`, and tests use `bun:test`. Lint and format are deferred until a team wants them.
5. **Single tool registry.** Every tool call goes through `src/execute.ts`: argument validation, permission decision, approval, pre-tool hooks, then the tool. The old per-tool special cases are gone.
6. **Shell guard is analysed, not pattern-matched.** `src/shell-guard.ts` tokenizes commands. The 24-case test table in `tests/guards.test.ts` covers bypasses found in the audit.
7. **Project settings need trust.** Keys that can run code or widen permissions (`mcpServers`, `hooks`, `verifyCommand`, `permissions`, `sandbox`) are ignored in untrusted projects.
8. **Sandbox on by default where available.** macOS uses `sandbox-exec`. Linux uses `bwrap` if installed. The Linux path is untested here.
9. **Cost is user-configured.** Prices live in config. Without them, `--max-cost` is a no-op and `/usage` shows tokens only.
10. **Subagents are read-only.** The `task` tool runs with read tools only, one level deep.
11. **Eval suite is 30 tasks**, judged by files on disk. Reference solutions pass their checks (`tests/evals-tasks.test.ts`).

## Status

Done (187 tests passing in `bun test`):

| Quarter | Item | State |
| --- | --- | --- |
| Q4 2026 | D1 to D5 fixed, each with a test | Done |
| Q4 2026 | Diff preview and approval for edits | Done |
| Q4 2026 | Permission rules, layered config, `AGENTS.md` | Done |
| Q4 2026 | Split into modules | Done |
| Q4 2026 | Command, fake-model, and end-to-end tests | Done |
| Q4 2026 | 30-task eval suite | Suite done; baseline run not done (see Blocked) |
| Q4 2026 | Behavioural roadmap checks (D9) | Done (the roadmap is removed) |
| Q4 2026 | CI workflow | Written; not yet run on GitHub |
| Q1 2027 | Checkpoints and `/undo` | Done |
| Q1 2027 | Automatic compaction | Done |
| Q1 2027 | Repo map | Done (regex symbols for TS, JS, Python, Go, Rust) |
| Q1 2027 | `rg` search | Done |
| Q1 2027 | Anthropic provider | Done (fake-server tests only) |
| Q1 2027 | Text tool-call fallback | Done |
| Q1 2027 | Cost and usage | Done (configured prices) |
| Q1 2027 | Resume with `--continue` and `--resume` | Done |
| Q1 2027 | Markdown rendering | Not done; diffs are coloured, prose is plain |
| Q2 2027 | Headless JSON and stream-JSON, exit codes | Done |
| Q2 2027 | Custom commands | Done |
| Q2 2027 | Hooks (`pre_tool`, `post_tool`, `on_stop`) | Done |
| Q2 2027 | Subagents (`task`) | Done |
| Q2 2027 | MCP reconnect, resources, prompts, timeouts, allowlists | Done (reconnect retries once) |
| Q2 2027 | Background processes | Done |
| Q2 2027 | Verify loop | Done |
| Q2 2027 | CI example that fixes a failing test | Not done |
| Q3 2027 | macOS sandbox | Done and tested |
| Q3 2027 | Linux sandbox | Written, untested |
| Q3 2027 | Network policy | Done |
| Q3 2027 | Standalone binary | Build script written; not run |
| Q3 2027 | Editor integration (ACP) | Not done |
| Q3 2027 | Performance measurement | Not done |
| Q3 2027 | Security review | Self-review only; the external review is not done |
| Q3 2027 | Public benchmark | Not done |

Blocked in this session (the auto-mode classifier denied these actions):
- `bun run build` and running the binary.
- `npm install`, so `@types/bun` is not installed and `package-lock.json` is out of date.
- The baseline eval run against `gemma4:31b`.
- Deleting `auto.ts`, `AUTO.md`, `ROADMAP.md`, the legacy `llmcli.ts`, `llmcli.ts.bak`, and the `logs/` and `snapshots/` directories.

Known issues found while testing:
- A live model miscounted words in a four-word file (it said seven). The eval suite exists to track this kind of error.
- The full-screen TUI has not been exercised interactively.

