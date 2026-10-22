// Runs llmcli over ROADMAP.md one item per fresh process, verifying each item independently.
// Usage: npm run auto [-- max_iterations]
import * as fs from "fs";
import { spawn, spawnSync } from "child_process";

process.chdir(__dirname);

const MAX = Number(process.argv[2] ?? 30);
const ROADMAP = process.env.ROADMAP ?? "ROADMAP.md";
const PROMPT_FILE = process.env.PROMPT_FILE ?? "AUTO.md";
const TSX = "./node_modules/.bin/tsx";
const RUN = (process.env.LLMCLI_RUN ?? `${TSX} llmcli.ts`).split(" ");
process.env.LLMCLI_MODEL = process.env.LLMCLI_MODEL ?? "gemma4:31b";

const readLines = () => fs.readFileSync(ROADMAP, "utf-8").split("\n");
const setLine = (n: number, text: string) => {
  const lines = readLines();
  lines[n] = text;
  fs.writeFileSync(ROADMAP, lines.join("\n"));
};
const selftestOk = () => spawnSync(TSX, ["llmcli.ts", "--selftest"], { encoding: "utf-8" }).stdout?.includes("selftest ok") ?? false;

function runLogged(logFile: string): Promise<void> {
  return new Promise((resolve) => {
    const log = fs.createWriteStream(logFile);
    const child = spawn(RUN[0], [...RUN.slice(1), "--file", PROMPT_FILE], { env: process.env });
    for (const stream of [child.stdout, child.stderr]) {
      stream.on("data", (d) => {
        process.stdout.write(d);
        log.write(d);
      });
    }
    child.on("close", () => log.end(() => resolve()));
  });
}

async function main() {
  fs.mkdirSync("snapshots", { recursive: true });
  fs.mkdirSync("logs", { recursive: true });
  fs.copyFileSync("llmcli.ts", "snapshots/good.ts");
  let fails = 0;

  for (let i = 1; i <= MAX; i++) {
    const n = readLines().findIndex((l) => l.startsWith("- [ ]"));
    if (n < 0) {
      console.log("No unchecked items left.");
      break;
    }
    const orig = readLines()[n];
    console.log(`\n=== iteration ${i}: ${orig.split(" | check:")[0]}`);

    await runLogged(`logs/iter-${i}.log`);

    if (!selftestOk()) {
      console.log("!! llmcli.ts is broken after this iteration; restoring last good version");
      fs.copyFileSync("snapshots/good.ts", "llmcli.ts");
    }

    if (readLines()[n].startsWith("- [x]")) {
      const check = orig.slice(orig.indexOf("| check: ") + "| check: ".length);
      const r = spawnSync("/bin/zsh", ["-c", check], { encoding: "utf-8", timeout: 180000 });
      fs.writeFileSync(`logs/check-${i}.log`, `${r.stdout}\n${r.stderr}`);
      if (r.status === 0) {
        console.log(`VERIFIED: ${orig.split(" | check:")[0]}`);
        fs.copyFileSync("llmcli.ts", "snapshots/good.ts");
        fs.copyFileSync("llmcli.ts", `snapshots/llmcli.${i}.ts`);
        fails = 0;
        continue;
      }
      console.log(`!! the model marked the item done but its check FAILED (see logs/check-${i}.log); un-checking it`);
      setLine(n, orig);
    }

    if (++fails >= 2) {
      console.log("!! giving up on this item after 2 failed attempts; marking [!] and restoring last good llmcli.ts");
      setLine(n, orig.replace("[ ]", "[!]"));
      fs.copyFileSync("snapshots/good.ts", "llmcli.ts");
      fails = 0;
    }
  }

  console.log("\n--- roadmap status ---");
  for (const l of readLines().filter((l) => /^- \[(x|!| )\]/.test(l))) console.log(l.slice(0, 80));
}

main();
