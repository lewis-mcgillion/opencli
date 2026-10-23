# OpenCLI evals

Measures how reliably the agent finishes real coding tasks with a given model, so regressions show as a pass-rate drop.

## Run

```sh
bun run evals/run.ts --model gemma4:31b                  # all 30 tasks
bun run evals/run.ts --model gemma4:e4b --filter bugfix  # subset by id substring
bun run evals/run.ts --help                              # all flags
```

Flags: `--url`, `--provider openai|anthropic|azure` (passed only when given), `--max-turns` (40), `--timeout` seconds per task (600), `--out <path>`, `--keep`. Each task runs in a fresh temp dir.

For hosted providers, set the API key in the environment and pass the provider and base URL explicitly. For Azure OpenAI / Foundry OpenAI, use the deployment name as `--model`:

```sh
OPENCLI_API_KEY="$AZURE_OPENAI_API_KEY" bun run evals/run.ts \
  --provider azure --url https://YOUR-RESOURCE.openai.azure.com/openai/v1 \
  --model YOUR_DEPLOYMENT_NAME --filter edit-rename
```

See [provider setup](../README.md#provider-profiles) for other endpoints. Evals make real model requests and may incur charges. Tasks run sequentially; parallel eval runs or agents still share deployment quota. Model HTTP requests use bounded retries and `Retry-After` handling as described in the README. The per-task timeout includes retry waits, so a rate-limited task can time out before retries complete.

## Output

Per task: `PASS|FAIL|TIMEOUT  id  turns  seconds  reason`, then pass count, pass rate, median turns, total tokens.

- Pass or fail comes only from `check(dir)` on disk, never from the model's reply. A throwing check is a failure.
- Full JSON goes to `--out` (default `evals/results/<timestamp>.json`). Agent stderr goes to `evals/results/<timestamp>/<id>.log`.
- Exit 0 after a measurement run, 2 for bad arguments, 1 if the runner crashes.

An exit code of 0 does not mean every task passed. Check the pass rate and JSON results when using evals as a release gate. `--filter` matches ID substrings, not named suites; a filter matching no tasks produces no baseline.

## Add a task

Append to the `tasks` array in `evals/tasks.ts`:

```ts
{
  id: "edit-example",
  category: "edit",
  prompt: "In a.ts, rename x to y.",
  files: { "a.ts": "let x = 1;\n" },
  check: (dir) => fs.readFileSync(path.join(dir, "a.ts"), "utf8").includes("let y = 1;"),
}
```

Checks must be deterministic. To run code, use `Bun.spawnSync([process.execPath, ...], { cwd: dir })` and check the exit code. Name test files with a path (`./test.ts`); bare `bun test test.ts` does not discover them.

Then add a solution to `tests/evals-tasks.test.ts` and run `bun test tests/evals-tasks.test.ts`, which makes no model call.
