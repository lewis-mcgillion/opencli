# Migration from LLMCLI to OpenCLI

The modular `src/` implementation is now OpenCLI. Run `bun install` and `bun run build` to produce `dist/opencli`, or use `bun run src/main.ts` directly. Update aliases, scripts, and binary paths that invoke `llmcli`.

## Configuration and saved state

| Legacy | Preferred |
| --- | --- |
| `~/.llmcli/` | `~/.opencli/` |
| Project `.llmcli/` | Project `.opencli/` |
| `LLMCLI_MODEL` | `OPENCLI_MODEL` |
| `LLMCLI_URL` | `OPENCLI_URL` |
| `LLMCLI_PROVIDER` | `OPENCLI_PROVIDER` |
| `LLMCLI_API_KEY` | `OPENCLI_API_KEY` |
| Project `LLMCLI.md` | Project `OPENCLI.md` |

Legacy directories still work when the corresponding OpenCLI directory does not exist. Selection is per directory, not per file: even an empty `~/.opencli/` hides `~/.llmcli/`, and an empty project `.opencli/` hides its `.llmcli/`. User and project directory selection are independent.

Back up the legacy directories, then rename each one if the new destination does not exist. Move the whole user directory to retain `config.json`, `sessions/`, `commands/`, and `trust.json`; move the whole project directory to retain `settings.json`, `settings.local.json`, and `commands/`. If both old and new directories exist, merge their contents deliberately into the OpenCLI directory before retiring the legacy copy. Keep local settings and API keys out of version control.

Each supported `OPENCLI_*` variable takes precedence over its matching `LLMCLI_*` variable. Generic `OPENCLI_API_KEY`, then `LLMCLI_API_KEY`, take precedence over the selected provider's `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or `AZURE_OPENAI_API_KEY`. Update shell profiles and CI secrets together to avoid an old generic key overriding a provider key.

Project instructions are read from all existing `AGENTS.md`, `OPENCLI.md`, and `LLMCLI.md` files in that order. Rename `LLMCLI.md` rather than keeping identical copies under both names. Check the effective instructions with `opencli --show-system` and configuration with `opencli --show-config` after migrating.

## Removed prototype entry points

The single-file `llmcli.ts`, self-editing loop `auto.ts`, its `AUTO.md`, historical `ROADMAP.md`, and old `tests/run.ts` are removed. Replace scripts that invoke them with `bun run src/main.ts` (or `dist/opencli`) and `bun test`. The current CLI's `--mode auto --allow-auto` is an approval mode, not the deleted self-editing loop.

See the [README](../README.md#provider-profiles) for provider setup and retry behavior. [PLAN.md](../PLAN.md) tracks current work; [COMPREHENSIVE_PLAN.md](../COMPREHENSIVE_PLAN.md) records future product goals.
