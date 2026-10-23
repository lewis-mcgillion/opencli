# OpenCLI multi-quarter product plan

Date: 2026-10-23

OpenCLI should become a provider-neutral terminal coding agent: local-first, cloud-capable, safe by default, scriptable in CI, and extensible enough to match the daily workflows developers expect from Codex CLI, Claude Code, GitHub Copilot CLI, Gemini CLI, and Aider.

This plan assumes OpenCLI keeps its current strengths: a modular TypeScript codebase, OpenAI-compatible and Anthropic providers, MCP support, permissions, sandbox policy, hooks, custom commands, sessions, checkpoints, repo maps, headless output, and a TUI. The roadmap below focuses on turning those pieces into a reliable product with provider breadth, strong safety, polished UX, team features, and measurable quality.

This is a roadmap, not a list of currently supported features. The public name is now OpenCLI; legacy configuration compatibility and the removed prototype entry points are covered in [migration notes](docs/migration.md). Use [README.md](README.md) for current provider setup and [PLAN.md](PLAN.md) for the active execution plan.

## Competitive baseline

Reference sources for the competitive baseline (features and URLs may change):

- OpenAI Codex CLI: https://learn.chatgpt.com/docs/codex/cli
- Claude Code feature overview and hooks: https://code.claude.com/docs/en/features-overview and https://code.claude.com/docs/en/hooks
- GitHub Copilot CLI: https://docs.github.com/en/copilot/how-tos/copilot-cli and https://docs.github.com/copilot/concepts/agents/about-copilot-cli
- Gemini CLI: https://docs.cloud.google.com/gemini/docs/codeassist/gemini-cli and https://geminicli.com/docs/
- Aider: https://aider.chat/docs/ and https://aider.chat/docs/repomap.html

Feature themes to match or exceed:

| Area | Competitor pattern | OpenCLI target |
| --- | --- | --- |
| Provider choice | Model switching, external providers, local models, per-model profiles | Any OpenAI-compatible endpoint, Anthropic, Gemini, OpenRouter, Bedrock, Azure OpenAI, Ollama, LM Studio, llama.cpp, and BYOK |
| Agent loop | Inspect files, edit, run commands, test, summarize | One consistent tool execution pipeline with permissions, sandboxing, retries, telemetry, and reviewable diffs |
| Control | Plan mode, approval modes, allow/deny tools, sandboxing | Clear modes for plan, regular, auto, CI; explicit permission policies; repeatable audits |
| Context | Project memory files, repo maps, compaction, sessions | `AGENTS.md`, `OPENCLI.md`, provider-specific memory import, repo map, symbol index, auto compaction, resumable sessions |
| Extensibility | MCP, skills, plugins, hooks, custom commands, subagents | Skills and plugin packaging, MCP tools/resources/prompts, hooks, custom commands, local and remote subagents |
| Automation | Headless prompt mode, JSON output, CI use, issue/PR workflows | Stable noninteractive API, GitHub/GitLab issue-to-PR flows, generated reports, exit codes, cost caps |
| UX | TUI, IDE handoff, checkpoints, undo, slash commands | Fast TUI, streaming diffs, command palette, checkpoint timeline, VS Code/ACP integration |
| Quality | Evals, self-review, lint/test loops, benchmarks | Public eval suite, local benchmark harness, provider matrix, release gates |

## Q4 2026: Product foundation

Goal: make the existing implementation trustworthy, installable, and easy to evaluate.

Exit criteria:

- `opencli` can be installed and run from a documented package or standalone binary.
- The CLI passes a release gate: unit tests, type checks, fake-model end-to-end tests, sandbox tests where supported, and a 30-task eval suite.
- Users can choose models from at least OpenAI-compatible, Anthropic, Ollama, LM Studio, and Azure OpenAI profiles.
- Project trust, permissions, sandboxing, web/network rules, hooks, and MCP behavior are documented with examples.
- The old prototype surface is either removed or explicitly labeled legacy.

Workstreams:

1. **Naming and packaging.** The public surface is renamed to `opencli` and `bun run build` produces `dist/opencli`. The package is currently private. Establish a publishable npm package name and release process, and retain the standalone binary path for users who do not want Node or Bun installed.
2. **Provider profiles.** Normalize model profiles with fields for provider, endpoint, API key env var, context window, max output, tool-call support, streaming support, image support, web support, pricing, and known quirks. Add `opencli models list`, `opencli models test`, and `/model`.
3. **Release-quality config.** Finalize layered config: user, project, local, environment, and CLI flags. Add `opencli doctor` to explain provider reachability, sandbox status, config source, MCP health, and missing dependencies.
4. **Safety docs and tests.** Document permissions, trust, sandbox modes, network policy, web fetch rules, and auto mode. Add regression tests for command parsing, tool allow/deny rules, private-network blocking, and project trust.
5. **Eval baseline.** Run the 30-task eval suite across one local model and one cloud model. Record task-level pass/fail, token use, elapsed time, and tool failures.
6. **Docs refresh.** Keep `PLAN.md` as the short execution plan. The README now covers quickstart, local and cloud setup, and bounded retry behavior, with a separate migration guide. Expand MCP setup, CI setup, and troubleshooting as those workstreams stabilize.

Risks:

- Provider-neutrality can become a lowest-common-denominator API. Keep provider adapters thin, but expose per-model capabilities clearly.
- Local models may fail tool calls often. Treat fallback handling as product behavior, not an edge case.

## Q1 2027: Daily-driver agent

Goal: make OpenCLI comfortable for real repository work across several hours and multiple sessions.

Exit criteria:

- Resume, checkpoints, undo, and compaction work without losing task state.
- Repo understanding includes file tree, symbols, references, and dependency hints within a token budget.
- The TUI supports reviewable diffs, markdown, command discovery, model switching, permission changes, and session status.
- Provider switching works mid-session when models share required capabilities.
- The eval suite reaches a documented target for at least two local models and two cloud models.

Workstreams:

1. **Context engine.** Upgrade repo map from regex symbols to tree-sitter or LSP-backed symbols where available. Cache by mtime and hash. Include relevance scoring based on open files, recent edits, imports, and prompt mentions.
2. **Compaction and memory.** Auto-compact before context pressure. Preserve current goal, constraints, changed files, tests run, todos, unresolved errors, model/provider, and permission state. Support `AGENTS.md`, `OPENCLI.md`, `CLAUDE.md`, `GEMINI.md`, and `.github/copilot-instructions.md` import with precedence rules.
3. **Diff and checkpoint UX.** Add a checkpoint timeline, per-file diff review, staged acceptance, undo to any checkpoint, and a clear record of commands run.
4. **Model fallback.** Extend the current bounded HTTP retry handling to detect missing tool-call support, malformed tool calls, context overflow, and provider outages. Add quota-aware concurrency and automatic downgrade or local fallback according to config; these are future work, not guarantees of the current backoff behavior.
5. **TUI polish.** Add searchable slash-command help, `/status`, `/permissions`, `/model`, `/tools`, `/mcp`, `/context`, `/usage`, and `/resume`. Keep keyboard paths short and discoverable.
6. **Verification loop.** Let projects define verify commands. Feed failures back to the model with a turn cap, and stop with a concise failure report when the cap is reached.

Risks:

- LSP/tree-sitter integration can slow startup. Build it as an optional cache with lazy loading.
- Cross-provider session switching can confuse tool semantics. Require capability compatibility checks before switching.

## Q2 2027: Extensibility and team workflows

Goal: make OpenCLI programmable by users and safe for teams.

Exit criteria:

- Skills, custom commands, hooks, MCP servers, and subagents are first-class and documented.
- Teams can share project policy while keeping local secrets and preferences private.
- Headless mode has a stable JSON and stream-JSON schema.
- OpenCLI can run in CI to inspect, modify, verify, and report on a task.
- GitHub and GitLab integrations support issue context, branch creation, PR/MR summaries, and review comments.

Workstreams:

1. **Skills.** Add a skill format for reusable instructions, scripts, assets, and activation metadata. Support global, project, and plugin-provided skills. Load only relevant skill content to control context cost.
2. **Plugins.** Package skills, MCP server config, hooks, commands, and docs as installable bundles. Add trust prompts, versioning, checksums, and uninstall.
3. **Subagents.** Support read-only research agents, implementation agents in isolated worktrees, and reviewer agents. Return structured summaries with files inspected, claims, risks, and citations when web research is used.
4. **MCP completeness.** Support tools, resources, prompts, server reconnect, OAuth where practical, per-server allowlists, timeouts, and clear health diagnostics.
5. **Headless contract.** Stabilize `--output-format json` and `stream-json`, exit codes, `--max-turns`, `--max-cost`, `--allowed-tools`, `--deny-tools`, `--cwd`, and `--resume`.
6. **VCS workflows.** Add native GitHub and GitLab connectors through MCP or CLI adapters: issue summarization, branch naming, PR/MR body generation, review response, and CI failure triage.
7. **Team policy.** Support checked-in policy files for allowed tools, sandbox rules, hooks, providers, and required verification. Local files hold secrets and personal defaults.

Risks:

- Plugins and hooks can execute code. Require trust, signed metadata where feasible, and clear dry-run diagnostics.
- Subagents can multiply cost. Add per-task budgets and visible accounting.

## Q3 2027: IDE, cloud, and scaled automation

Goal: let developers move between terminal, editor, and hosted automation without changing mental models.

Exit criteria:

- OpenCLI exposes an Agent Client Protocol or equivalent server for editor integrations.
- VS Code integration can attach to a session, inspect diffs, approve actions, and resume terminal work.
- Remote work can run in an isolated worktree/container and return a branch or PR.
- Benchmarks and release quality metrics are public.
- Performance targets are met: warm startup under 500 ms for CLI help/status, first prompt under 1.5 s excluding model latency, and no avoidable full-repo scans on startup.

Workstreams:

1. **Editor bridge.** Implement ACP-compatible server mode, session attach/detach, diff review, command approval, and diagnostics streaming. Start with VS Code, then document integration points for other editors.
2. **Remote execution.** Add optional container/worktree execution for long tasks. Preserve the same permissions, hooks, and verify loop. Return patches, branches, or PRs.
3. **Parallel work.** Add `/fleet`-style execution for independent plans, model comparison, or reviewer agents. Merge only through reviewable patches.
4. **Benchmarking.** Publish a fixed coding benchmark, provider matrix, local-model matrix, cost/latency report, and failure taxonomy. Run it on release candidates.
5. **Performance.** Bundle the CLI for fast startup, lazy-load MCP and TUI dependencies, cache repo maps, and measure prompt-to-first-tool latency.
6. **Security review.** Threat-model prompt injection, malicious files, malicious MCP servers, hook/plugin supply chain, sandbox escapes, web content, and credential exposure. Close high-severity issues before broad release.

Risks:

- Remote execution can drift from local behavior. Keep the same policy engine and record all environment differences.
- Editor integration can sprawl. Keep terminal parity as the source of truth.

## Q4 2027: Mature ecosystem

Goal: make OpenCLI a dependable platform for provider-neutral coding agents.

Exit criteria:

- A plugin registry or curated index exists with trust metadata.
- Users can export and import sessions, skills, provider profiles, and eval results.
- Enterprise controls support allowed providers, audit logs, policy lock, secret handling, and offline/local-only mode.
- OpenCLI has documented compatibility with major local runtimes and cloud providers.
- The project publishes release notes, migration notes, and deprecation windows.

Workstreams:

1. **Registry.** Curated plugin and skill index with signatures, compatibility metadata, risk labels, and install/update commands.
2. **Enterprise controls.** Managed policy file, audit log, provider allowlist, disabled network mode, secret redaction, and admin-controlled defaults.
3. **Observability.** Local telemetry export for actions, tool calls, costs, latency, failures, and evals. Keep privacy local by default.
4. **Advanced planning.** Multi-plan comparison, plan review, acceptance criteria extraction, and automatic test-plan generation before edits.
5. **Provider marketplace.** Community-maintained model profiles with tests and known capability flags.
6. **Long-term maintenance.** Deprecation policy, migration commands, config schema versioning, and compatibility tests for old sessions.

Risks:

- A registry creates supply-chain responsibility. Start curated and explicit, then expand.
- Enterprise controls can distort the local-first product. Build them as policy layers over the same local primitives.

## Product principles

1. **Provider-neutral, capability-aware.** Do not hide model differences. Show what each model can do and route accordingly.
2. **Local-first.** Every core workflow should work with local files and local models unless the user opts into cloud services.
3. **Safe by default.** Writes, shell execution, network access, hooks, MCP servers, and plugins need clear policy and review.
4. **Measurable quality.** Every release should improve or explain changes in eval pass rate, latency, cost, and failure recovery.
5. **Reviewable work.** The user should be able to inspect the plan, commands, diffs, checkpoints, and final result.
6. **Composable automation.** Interactive TUI, headless CLI, CI, editor, and remote runs should share one engine.

## Immediate next steps

1. Establish publishing and release automation for the chosen OpenCLI name; select a scoped npm package if needed.
2. Keep README setup examples and migration notes aligned with the remaining implementation workstreams.
3. Run `bun test`, `bun run check`, and the existing eval suite to verify the current baseline.
4. Add `opencli doctor` or expand the current diagnostics so provider/network/sandbox issues are easy to understand.
5. Add provider-profile tests for Anthropic, OpenAI-compatible local, Azure OpenAI, Ollama, and LM Studio.
6. Update `PLAN.md` with completed work and measured baseline results while retaining this document as the longer-term roadmap.
