export interface ShellVerdict {
  safe: boolean;
  reasons: string[];
}

interface Segment {
  words: string[];
  writes: string[];
}

interface Tokenized {
  segments: Segment[];
  ok: boolean;
}

const SEPARATORS = new Set(["\n", ";", "&", "|", "(", ")"]);

function tokenize(src: string): Tokenized {
  const segments: Segment[] = [];
  let cur: Segment = { words: [], writes: [] };
  let word: string | null = null;
  let quote: "'" | '"' | null = null;
  let ok = true;

  const endWord = () => {
    if (word !== null) cur.words.push(word);
    word = null;
  };
  const endSegment = () => {
    endWord();
    if (cur.words.length || cur.writes.length) segments.push(cur);
    cur = { words: [], writes: [] };
  };

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quote === "'") {
      if (c === "'") quote = null;
      else word = (word ?? "") + c;
      continue;
    }
    if (quote === '"') {
      if (c === '"') { quote = null; continue; }
      if (c === "\\" && i + 1 < src.length) { word = (word ?? "") + src[++i]; continue; }
      if (c === "`" || (c === "$" && src[i + 1] === "(")) {
        endSegment();
        if (c === "$") i++;
        continue;
      }
      word = (word ?? "") + c;
      continue;
    }
    if (c === "\\") {
      if (i + 1 < src.length) word = (word ?? "") + src[++i];
      continue;
    }
    if (c === "'" || c === '"') { quote = c; word ??= ""; continue; }
    if (c === "$" && src[i + 1] === "(") { endSegment(); i++; continue; }
    if (c === "`") { endSegment(); continue; }
    if (c === "#" && word === null) {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === " " || c === "\t") { endWord(); continue; }
    if (SEPARATORS.has(c)) { endSegment(); continue; }
    if (c === ">" || c === "<") {
      const fdNumber = word !== null && /^\d+$/.test(word);
      if (fdNumber) word = null;
      endWord();
      let j = i + 1;
      const isOutput = c === ">";
      if (src[j] === ">") j++;
      if (src[j] === "|") j++;
      if (src[j] === "&") {
        j++;
        i = j - 1;
        continue;
      }
      while (src[j] === " " || src[j] === "\t") j++;
      let target = "";
      let q: string | null = null;
      for (; j < src.length; j++) {
        const t = src[j];
        if (q) {
          if (t === q) q = null;
          else target += t;
        } else if (t === "'" || t === '"') q = t;
        else if (t === " " || t === "\t" || SEPARATORS.has(t) || t === ">" || t === "<") break;
        else target += t;
      }
      if (q) ok = false;
      if (isOutput) cur.writes.push(target);
      i = j - 1;
      continue;
    }
    word = (word ?? "") + c;
  }
  endSegment();
  if (quote) ok = false;
  return { segments, ok };
}

const SAFE_COMMANDS = new Set([
  "ls", "cat", "head", "tail", "wc", "pwd", "echo", "printf", "cut", "tr", "diff", "file",
  "stat", "du", "df", "which", "date", "uname", "basename", "dirname", "realpath", "true",
  "false", "test", "[", "cmp", "shasum", "sha256sum", "md5", "id", "whoami", "cd", "export",
  "grep", "rg",
]);

const DELETE_FLAGS = new Set(["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls"]);
const SAFE_GIT = new Set(["status", "diff", "log", "show", "rev-parse", "ls-files", "blame", "shortlog", "describe", "grep", "cat-file", "ls-tree", "version", "help"]);
const GIT_GLOBAL_WITH_ARG = new Set(["-C", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--super-prefix"]);
const GIT_DANGEROUS_FLAGS = new Set(["-d", "-D", "-m", "-M", "-c", "-C", "-f", "--delete", "--move", "--copy", "--force", "-u", "--set-upstream-to", "--unset-upstream"]);

function analyzeGit(args: string[]): string[] {
  let i = 0;
  while (i < args.length && args[i].startsWith("-")) {
    if (args[i] === "-c") return ["git -c runs configured commands"];
    if (GIT_GLOBAL_WITH_ARG.has(args[i])) i += 2;
    else i += 1;
  }
  const sub = args[i];
  const rest = args.slice(i + 1);
  if (sub === undefined) return [];
  if (sub.startsWith("-")) return SAFE_GIT.has(sub) || sub === "--version" ? [] : [`git ${sub}`];
  if (SAFE_GIT.has(sub)) return [];
  const positional = rest.filter((a) => !a.startsWith("-"));
  const hasFlag = (set: Set<string>) => rest.some((a) => set.has(a));
  switch (sub) {
    case "branch":
      return !positional.length && !hasFlag(GIT_DANGEROUS_FLAGS) ? [] : ["git branch changes branches"];
    case "tag":
      return !positional.length && !hasFlag(new Set(["-d", "--delete", "-f", "--force"])) ? [] : ["git tag changes tags"];
    case "remote":
      return rest.length === 0 || (rest.length === 1 && rest[0] === "-v") ? [] : ["git remote changes remotes"];
    case "stash":
      return ["list", "show"].includes(rest[0] ?? "") ? [] : ["git stash changes the stash"];
    case "config":
      return rest.some((a) => a === "--get" || a === "--get-all" || a === "--list" || a === "-l") ? [] : ["git config changes configuration"];
    case "reflog":
      return rest.length === 0 || rest[0] === "show" ? [] : ["git reflog rewrites history"];
    case "worktree":
      return rest[0] === "list" ? [] : ["git worktree changes worktrees"];
    case "submodule":
      return rest[0] === "status" ? [] : ["git submodule changes submodules"];
    case "push": return ["git push publishes commits"];
    case "clean": return ["git clean deletes untracked files"];
    case "reset":
      return rest.includes("--hard") ? ["git reset --hard discards changes"] : ["git reset changes the index or HEAD"];
    case "checkout":
    case "restore":
    case "switch":
      return [`git ${sub} can discard changes`];
    default:
      return [`git ${sub} changes the repository`];
  }
}

function analyzeSegment(words: string[]): string[] {
  let w = words.slice();
  while (w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0])) w.shift();
  for (;;) {
    if (!w.length) return [];
    const prog = w[0].split("/").pop() ?? w[0];
    if (["sudo", "doas", "su"].includes(prog)) return ["requires privilege escalation"];
    if (["command", "builtin", "nohup", "time", "nice"].includes(prog)) { w.shift(); continue; }
    if (prog === "env") {
      w.shift();
      while (w.length && (w[0].startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0]))) w.shift();
      continue;
    }
    if (prog === "timeout") {
      w.shift();
      while (w.length && w[0].startsWith("-")) w.shift();
      w.shift();
      continue;
    }
    if (prog === "xargs") return ["xargs runs commands"];
    break;
  }
  const prog = w[0].split("/").pop() ?? w[0];
  const args = w.slice(1);
  if (prog === "rm") {
    const end = args.indexOf("--");
    const flags = (end >= 0 ? args.slice(0, end) : args).filter((a) => a.startsWith("-"));
    const recursive = flags.some((f) => f.startsWith("--") ? f === "--recursive" || f === "--force" : /[rRf]/.test(f));
    return [recursive ? "recursive or forced delete" : "deletes files"];
  }
  if (["kill", "killall", "pkill"].includes(prog)) return ["terminates processes"];
  if (["dd", "mkfs", "shutdown", "reboot", "halt", "launchctl", "osascript", "eval", "exec", "source"].includes(prog) || prog.startsWith("mkfs.")) {
    return [`${prog} is a system-level command`];
  }
  if (prog === "find") {
    return args.some((a) => DELETE_FLAGS.has(a)) ? ["find can delete files or run commands"] : [];
  }
  if (prog === "rg") {
    return args.some((a) => a === "--pre" || a.startsWith("--pre=")) ? ["rg --pre runs a command"] : [];
  }
  if (prog === "git") return analyzeGit(args);
  if (prog === "chmod" || prog === "chown") {
    return args.some((a) => a === "-R" || a === "--recursive") ? [`${prog} -R changes many files`] : [`${prog} changes file permissions`];
  }
  if (SAFE_COMMANDS.has(prog)) return [];
  return [`runs ${prog}`];
}

export function analyzeShell(command: string): ShellVerdict {
  const { segments, ok } = tokenize(command);
  if (!ok) return { safe: false, reasons: ["could not parse the command safely"] };
  const reasons: string[] = [];
  for (const seg of segments) {
    reasons.push(...analyzeSegment(seg.words));
    for (const target of seg.writes) {
      if (target !== "/dev/null") reasons.push(`writes to ${target}`);
    }
  }
  return { safe: reasons.length === 0, reasons: [...new Set(reasons)] };
}

export function hasShellOperators(command: string): boolean {
  return /[;&|<>`\n]|\$\(/.test(command);
}
