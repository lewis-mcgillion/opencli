# OpenCLI implementation plan

Date: 2026-10-23

This file is the current short-form execution plan. The broader product roadmap lives in `COMPREHENSIVE_PLAN.md`.

## Current verdict

Proceed with implementation in focused slices. The old prototype roadmap and self-editing loop have been removed from the active surface, and the repository now centers on the modular `src/` implementation.

## Completed in this pass

- Renamed the public package/build target from `llmcli` to `opencli`.
- Added `.opencli` user/project config paths with `.llmcli` fallback for existing users.
- Added `OPENCLI_*` environment variables with `LLMCLI_*` fallback.
- Added `OPENCLI.md` project instructions support while keeping `LLMCLI.md` compatibility.
- Added built-in provider profiles and `opencli models list`.
- Added explicit Azure OpenAI provider mode using the OpenAI-compatible chat adapter with `api-key` authentication.
- Removed legacy prototype files: `auto.ts`, `AUTO.md`, `ROADMAP.md`, and the old single-file `llmcli.ts`.
- Documented provider setup, bounded model-request retries, and the [migration path](docs/migration.md) for legacy configuration, instructions, and prototype entry points.

## Next fan-out order

1. **Providers and model profiles**
   Add persisted custom model profiles, provider-specific fake-server tests, and capability checks before switching models mid-session.

2. **Safety and sandbox verification**
   Add Linux `bwrap` tests or mark Linux sandbox as experimental at runtime, and cover network policy across shell, git, and web fetch.

3. **CI and eval baseline**
   Run `bun test`, `bun run check`, and the 30-task eval suite in CI. Record baseline results for one local model and one cloud model.

4. **Documentation**
   Keep the README setup examples and migration notes aligned with the provider, safety, and CI changes as they land. Basic local, Anthropic, and Azure setup and legacy migration are documented; add measured live-provider baselines when available.

## Verification gate

Before merging a workstream:

```sh
bun test
bun run check
bun run eval -- --model gemma4:31b --filter edit-rename
```

The eval filter matches task ID substrings; `edit-rename` selects an existing task. Evals require a running model endpoint and may incur charges. The runner exits 0 after a measurement run even when tasks fail, so inspect the reported pass rate and JSON results before accepting a baseline. Documentation-only changes need link, example, and stale-reference checks rather than model evals.

Run the full eval baseline before a release candidate. Keep concurrent model requests within deployment quota; current HTTP retries are bounded and do not guarantee recovery from rate limits.
