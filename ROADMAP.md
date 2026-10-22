# llmcli roadmap

Work top to bottom. One item per run. Each item line has the form:

    - [ ] Title | check: <shell command, run from ~/llmcli, must exit 0>

The check is run independently by auto.sh after you mark an item done. If it fails, the mark is undone.
In checks, always use `./node_modules/.bin/tsx llmcli.ts` (not npx). Slash commands are tested by piping them in.

Code layout (llmcli.ts): TOOLS (tool schemas) + HANDLERS (tool code) + COMMANDS (slash commands) + main() (flags).
Tests of tools use the headless flag: `./node_modules/.bin/tsx llmcli.ts --tool <name> '<json args>'`.

- [x] /model command | check: printf '/model foo\n/exit\n' | ./node_modules/.bin/tsx llmcli.ts 2>&1 | grep -q 'model set to foo'
  Add a `model` entry to COMMANDS. `/model <name>` sets MODEL (it is a `let`) and returns `model set to <name>`. With no argument it returns `model: <current>`.

- [x] /context command | check: printf '/context\n/exit\n' | ./node_modules/.bin/tsx llmcli.ts 2>&1 | grep -q 'system: You are llmcli'
  Add a `context` entry to COMMANDS. It returns one line per history entry: `<role>: <first 80 chars of content, newlines replaced by spaces>`.

- [x] Project instructions file and --show-system flag | check: d=$(mktemp -d); echo MAGICWORD123 > $d/LLMCLI.md; (cd $d && ~/llmcli/node_modules/.bin/tsx ~/llmcli/llmcli.ts --show-system) | grep -q MAGICWORD123
  If `LLMCLI.md` exists in process.cwd() at startup, append its content to the system prompt under the heading `# Project instructions`. Add a `--show-system` flag in main() (next to --selftest) that prints history[0].content and exits. Hint: SYSTEM is a const used to build `history`; build the final system text before `history` is created.

- [x] Config file ~/.llmcli/config.json and --show-config flag | check: h=$(mktemp -d); mkdir -p $h/.llmcli; echo '{"model":"cfgmodel123"}' > $h/.llmcli/config.json; HOME=$h ./node_modules/.bin/tsx llmcli.ts --show-config | grep -q cfgmodel123
  Read `$HOME/.llmcli/config.json` at startup if it exists (fields: model, url). Env vars LLMCLI_MODEL / LLMCLI_URL override the file; the file overrides the defaults. Ignore a missing or invalid file. BASE_URL becomes a `let` or is computed from the config. Add a `--show-config` flag in main() that prints JSON `{"model":...,"url":...}` and exits.

- [x] @file mentions and --expand flag | check: echo FILEBODY456 > /tmp/llmcli-at.txt; ./node_modules/.bin/tsx llmcli.ts --expand 'look at @/tmp/llmcli-at.txt please' | grep -q FILEBODY456
  Write `expandMentions(text: string): string`. For every token `@<path>` where path starts with `/`, `~/` or `./`, and the file exists, prepend `[File: <path>]\n<content>\n\n` to the message (clip content to 8000 chars). Unknown paths are left as they are. Use it in repl's `send` before pushing the user message. Add an `--expand <text>` flag in main() that prints expandMentions(text) and exits.

- [x] Sessions: /save /load /sessions | check: h=$(mktemp -d); printf '/save t1\n/sessions\n/exit\n' | HOME=$h ./node_modules/.bin/tsx llmcli.ts 2>&1 | grep -q 't1' && test -f $h/.llmcli/sessions/t1.json
  Add COMMANDS `save`, `load`, `sessions`. `/save <name>` writes history without the system message (history.slice(1)) as JSON to `$HOME/.llmcli/sessions/<name>.json` (create the dir) and returns `saved <name>`. `/load <name>` reads it and replaces history after the system message, returns `loaded <name> (<n> messages)`. `/sessions` lists the names. Reject names with `/` or `..`.

- [x] Tool test script and npm test | check: npm test --silent
  Create `tests/run.ts` (TypeScript, no shell scripts, runs from ~/llmcli). Use child_process `execFileSync("./node_modules/.bin/tsx", ["llmcli.ts", "--tool", name, jsonArgs])` to test write_file, read_file, insert_lines, replace_lines, edit_file, glob_files and grep_files against a temp dir made with fs.mkdtempSync, and assert outputs with `includes`. Also run `--selftest`. Add `"test": "tsx tests/run.ts"` to the scripts in package.json. Call process.exit(1) on any failure.

- [x] web_fetch tool | check: ./node_modules/.bin/tsx llmcli.ts --tool web_fetch '{"url":"http://localhost:11434/"}' | grep -q 'Ollama is running'
  Add `tool("web_fetch", ...)` to TOOLS and a `web_fetch` handler to HANDLERS. It fetches the url (GET, 15s timeout via AbortSignal.timeout), strips <script>/<style> blocks and HTML tags if the body looks like HTML, collapses whitespace, and returns clip(text). Only http and https URLs.

- [x] todo_write tool | check: ./node_modules/.bin/tsx llmcli.ts --tool todo_write '{"todos":["a","b"]}' | grep -q 'b'
  Add tool `todo_write` with parameter `todos` (array of strings; use `{type:"array",items:{type:"string"}}`) and a handler that stores the list in a module-level variable and returns it as a numbered list. Mention in the tool description that it is for tracking steps of a multi-step task.

- [x] git tool | check: ./node_modules/.bin/tsx llmcli.ts --tool git '{"args":"--version"}' | grep -q 'git version'
  Add tool `git` with parameter `args` (string). Handler runs `git <args>` through the same code path as run_bash (so the DANGEROUS check still applies) and returns the output.

- [x] Show token usage | check: grep -q include_usage llmcli.ts && ./node_modules/.bin/tsx llmcli.ts --selftest | grep -q 'selftest ok'
  Add `stream_options: { include_usage: true }` to the request body in callLLM. The final stream chunk then has a `usage` object with prompt_tokens and completion_tokens. streamDeltas currently only yields deltas; make it also surface usage (for example yield `{ usage }` objects) and have callLLM print a dim line `[tokens: N in / N out]` after the reply.

- [x] Spinner while waiting for the first token | check: grep -q setInterval llmcli.ts && ./node_modules/.bin/tsx llmcli.ts --selftest | grep -q 'selftest ok'
  In callLLM, before the first delta arrives show a spinner on stderr using the frames ⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏ (setInterval every 80ms, `\r` to redraw). Clear the line and stop the interval when the first delta arrives or on error. Only show it when process.stderr.isTTY.

- [x] Retry transient model errors | check: grep -q 'attempt' llmcli.ts && ./node_modules/.bin/tsx llmcli.ts --selftest | grep -q 'selftest ok'
  In callLLM, if the initial fetch throws (connection refused) or returns status 429/500/502/503, retry up to 3 attempts with 1s, 2s backoff and print a dim `[retrying: attempt N]` line. Do not retry on 4xx other than 429.

- [x] /compact command | check: grep -q compact llmcli.ts && ./node_modules/.bin/tsx llmcli.ts --selftest | grep -q 'selftest ok'
  Add COMMANDS `compact`. It sends the history (without the system message) to the model with a user instruction to summarise the conversation so far in under 200 words (use a separate call with no tools: a small helper that POSTs to /chat/completions with stream false). Then it replaces history after the system message with one user message `Summary of earlier conversation: <summary>`. Returns `compacted: <n> messages -> 1`.

- [x] Ctrl-C cancels the current model request | check: grep -q AbortController llmcli.ts && ./node_modules/.bin/tsx llmcli.ts --selftest | grep -q 'selftest ok'
  Use an AbortController for the fetch in callLLM. In repl, on rl "SIGINT": if a request is in flight, abort it and print `[cancelled]` and return to the prompt; if idle, exit. Keep a module-level `let currentAbort: AbortController | null`.
