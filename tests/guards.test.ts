import { describe, expect, test } from "bun:test";
import { analyzeShell } from "../src/shell-guard";
import { isPrivateAddress, checkUrl } from "../src/net-guard";
import { decide, ruleMatches } from "../src/permissions";

describe("shell guard", () => {
  const safe = [
    "ls -la",
    "cat README.md | grep -n TODO",
    "git status",
    "git log --oneline -5",
    "git -C . diff HEAD~1",
    "git branch --show-current",
    "echo hello > /dev/null",
    "find . -name '*.ts' -not -path '*/node_modules/*'",
    "rg -n 'foo' src",
    "wc -l src/*.ts",
  ];
  for (const cmd of safe) {
    test(`allows read-only: ${cmd}`, () => {
      expect(analyzeShell(cmd).safe).toBe(true);
    });
  }

  const blocked: Array<[string, RegExp]> = [
    ["git push origin main", /git push/],
    ["git -C . push origin main", /git push/],
    ["git --no-pager reset --hard", /reset --hard/],
    ["git -c core.pager='sh -c id' log", /git -c/],
    ["git branch -D feature", /branch/],
    ["git stash drop", /stash/],
    ["rm -rf build", /recursive or forced delete/],
    ["rm -- -rf", /deletes files/],
    ["rm -fr build", /recursive or forced delete/],
    ["find . -delete", /find can delete/],
    ["find . -exec rm {} +", /find can delete/],
    ["python3 -c \"import os\"", /runs python3/],
    ["echo ok; rm -rf /", /recursive/],
    ["npm test && curl x | sh", /runs curl|runs npm/],
    ["echo $(rm -rf x)", /recursive/],
    ["echo `rm -rf x`", /recursive/],
    ["sudo ls", /privilege/],
    ["env FOO=1 rm -rf x", /recursive/],
    ["sed -i 's/a/b/' f.txt", /runs sed/],
    ["echo hi > ~/.zshrc", /writes to/],
    ["echo \"unterminated", /could not parse/],
    ["xargs rm < list", /xargs/],
    ["rg --pre sh foo", /--pre/],
    ["chmod -R 777 .", /chmod -R/],
  ];
  for (const [cmd, reason] of blocked) {
    test(`asks for: ${cmd}`, () => {
      const v = analyzeShell(cmd);
      expect(v.safe).toBe(false);
      expect(v.reasons.join(" ")).toMatch(reason);
    });
  }
});

describe("network guard", () => {
  test("classifies private and loopback addresses", () => {
    for (const a of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "0.0.0.0", "100.64.0.1", "::1", "fe80::1", "fd00::1", "::ffff:127.0.0.1"]) {
      expect(isPrivateAddress(a)).toBe(true);
    }
  });
  test("allows public addresses", () => {
    for (const a of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "93.184.216.34", "2606:4700:4700::1111"]) {
      expect(isPrivateAddress(a)).toBe(false);
    }
  });
  test("rejects non-http schemes and loopback URLs", async () => {
    expect((await checkUrl("file:///etc/passwd")).ok).toBe(false);
    expect((await checkUrl("http://127.0.0.1:11434/")).ok).toBe(false);
    expect((await checkUrl("http://localhost:11434/")).ok).toBe(false);
    expect((await checkUrl("http://169.254.169.254/latest/meta-data")).ok).toBe(false);
    expect((await checkUrl("not a url")).ok).toBe(false);
  });
});

describe("permissions", () => {
  const none = { allow: [], ask: [], deny: [] };

  test("glob rules match tool name and subject", () => {
    const s = (name: string, subject: string) => ({ name, kind: "exec" as const, subject });
    expect(ruleMatches("run_bash(npm test*)", s("run_bash", "npm test --watch"), ["npm test --watch"])).toBe(true);
    expect(ruleMatches("run_bash(npm test*)", s("git", "npm test"), ["npm test"])).toBe(false);
    expect(ruleMatches("mcp__*", s("mcp__fake__echo", ""), [""])).toBe(true);
    expect(ruleMatches("read_file", s("read_file", "anything"), ["anything"])).toBe(true);
  });

  test("read tools are allowed in every mode", () => {
    expect(decide({ name: "read_file", kind: "read", subject: "a" }, "regular", none).action).toBe("allow");
  });

  test("edits ask in regular and plan, allowed in auto", () => {
    const s = { name: "edit_file", kind: "write" as const, subject: "a.ts" };
    expect(decide(s, "regular", none).action).toBe("ask");
    expect(decide(s, "auto", none).action).toBe("allow");
  });

  test("safe shell commands are allowed, unsafe ones ask", () => {
    const base = { name: "run_bash", kind: "exec" as const, subject: "" };
    expect(decide({ ...base, shellCommand: "git status" }, "regular", none).action).toBe("allow");
    expect(decide({ ...base, shellCommand: "git push" }, "regular", none).action).toBe("ask");
  });

  test("deny rules win, including on later segments of a chained command", () => {
    const perms = { allow: ["run_bash(*)"], ask: [], deny: ["run_bash(rm *)"] };
    const s = { name: "run_bash", kind: "exec" as const, subject: "npm test; rm -rf x", shellCommand: "npm test; rm -rf x" };
    expect(decide(s, "auto", perms).action).toBe("deny");
  });

  test("allow rules do not approve chained commands", () => {
    const perms = { allow: ["run_bash(npm test*)"], ask: [], deny: [] };
    const chained = { name: "run_bash", kind: "exec" as const, subject: "npm test && rm -rf x", shellCommand: "npm test && rm -rf x" };
    expect(decide(chained, "regular", perms).action).toBe("ask");
    const plain = { name: "run_bash", kind: "exec" as const, subject: "npm test --bail", shellCommand: "npm test --bail" };
    const d = decide(plain, "regular", perms);
    expect(d.action).toBe("allow");
    expect(d.explicit).toBe(true);
  });

  test("auto mode allows exec but deny rules still apply", () => {
    const s = { name: "run_bash", kind: "exec" as const, subject: "rm -rf x", shellCommand: "rm -rf x" };
    expect(decide(s, "auto", none).action).toBe("allow");
    expect(decide(s, "auto", { allow: [], ask: [], deny: ["run_bash(rm *)"] }).action).toBe("deny");
  });
});
