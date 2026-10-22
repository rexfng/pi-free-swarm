import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { WorkspaceManager } from "../../src/lab/workspace.js";

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
  }).trim();
}

function setup() {
  const base = mkdtempSync(join(tmpdir(), "swarm-workspace-"));
  temporary.push(base);
  const repo = join(base, "repo");
  mkdirSync(repo);
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "Swarm test");
  git(repo, "config", "user.email", "swarm-test@example.invalid");
  writeFileSync(join(repo, "original.txt"), "original\n");
  git(repo, "add", "original.txt");
  git(repo, "commit", "-m", "Initial");
  const manager = new WorkspaceManager(repo, join(base, "agents"));
  return { base, repo, manager };
}

function commit(cwd: string, path: string, content: string): string {
  writeFileSync(join(cwd, path), content);
  git(cwd, "add", "--", path);
  git(cwd, "commit", "-m", "Agent implementation");
  return git(cwd, "rev-parse", "HEAD");
}

const allowed = () => {};

describe("isolated agent workspaces", () => {
  it("fails closed when another Git metadata mutation owns the shared lock", () => {
    const { manager } = setup();
    mkdirSync(join(manager.rootPath, ".integration-lock"));
    assert.throws(() => manager.create("one"), /EEXIST/);
    assert.deepEqual(manager.list(), []);
  });
  it("creates separate branches and source trees and reloads registrations", () => {
    const { repo, manager } = setup();
    const one = manager.create("one");
    const two = manager.create("two");
    manager.writeFile(one, "original.txt", "first agent\n", allowed);
    manager.writeFile(two, "original.txt", "second agent\n", allowed);
    assert.equal(readFileSync(join(one.path, "original.txt"), "utf8"), "first agent\n");
    assert.equal(readFileSync(join(two.path, "original.txt"), "utf8"), "second agent\n");
    assert.equal(readFileSync(join(repo, "original.txt"), "utf8"), "original\n");
    assert.deepEqual(new WorkspaceManager(repo, manager.rootPath).list(), [one, two]);
  });

  it("rejects dirty or detached integration repositories and existing workspaces", () => {
    const { repo, manager } = setup();
    const workspace = manager.create("one");
    assert.throws(() => manager.create("one"), /already exists/);
    writeFileSync(join(repo, "untracked.txt"), "keep");
    assert.throws(() => manager.create("two"), /clean/);
    rmSync(join(repo, "untracked.txt"));
    git(repo, "checkout", "--detach");
    assert.throws(() => manager.create("two"));
    assert.equal(readFileSync(join(workspace.path, "original.txt"), "utf8"), "original\n");
  });

  it("rejects injected references, invalid identities, and nested workspace roots", () => {
    const { repo, manager } = setup();
    assert.throws(() => manager.create("../outside"), /identity/);
    assert.throws(() => manager.create("one", "--orphan"), /reference/);
    assert.throws(() => manager.create("one", "HEAD; touch owned"), /reference/);
    assert.throws(() => new WorkspaceManager(repo, join(repo, "agents")), /outside/);
  });

  it("rejects forged workspace records and switched workspace branches", () => {
    const { manager } = setup();
    const workspace = manager.create("one");
    assert.throws(
      () => manager.writeFile({ ...workspace, path: manager.repoPath }, "original.txt", "bad", allowed),
      /registration/,
    );
    git(workspace.path, "checkout", "-b", "different");
    assert.throws(() => manager.writeFile(workspace, "original.txt", "bad", allowed), /branch/);
  });
});

describe("controlled writes", () => {
  it("creates nested files and replaces contents after checking the lease twice", () => {
    const { manager } = setup();
    const workspace = manager.create("one");
    let authorizations = 0;
    manager.writeFile(workspace, "src/nested/file.ts", "export const answer = 42;\n", () => {
      authorizations += 1;
    });
    assert.equal(authorizations, 2);
    assert.equal(readFileSync(join(workspace.path, "src/nested/file.ts"), "utf8"), "export const answer = 42;\n");
  });

  it("leaves existing files unchanged if the lease expires before replacement", () => {
    const { manager } = setup();
    const workspace = manager.create("one");
    let calls = 0;
    assert.throws(
      () =>
        manager.writeFile(workspace, "original.txt", "bad", () => {
          if (++calls === 2) throw new Error("Lease expired");
        }),
      /Lease expired/,
    );
    assert.equal(readFileSync(join(workspace.path, "original.txt"), "utf8"), "original\n");
    assert.deepEqual(readdirSync(workspace.path).sort(), [".git", "original.txt"]);
  });

  it("preserves the original file when a writer process exits before replacement", () => {
    const { repo, manager } = setup();
    const workspace = manager.create("one");
    const source = new URL("../../src/lab/workspace.ts", import.meta.url).href;
    const script = `import { WorkspaceManager } from ${JSON.stringify(source)};
      const manager = new WorkspaceManager(${JSON.stringify(repo)}, ${JSON.stringify(manager.rootPath)});
      let calls = 0;
      manager.writeFile(${JSON.stringify(workspace)}, "original.txt", "partial replacement", () => {
        if (++calls === 2) process.exit(73);
      });`;
    const child = spawnSync(process.execPath, ["--import", "tsx/esm", "--input-type=module", "-e", script], {
      timeout: 10_000,
    });
    assert.equal(child.status, 73);
    assert.equal(readFileSync(join(workspace.path, "original.txt"), "utf8"), "original\n");
    // A crash may leave a harmless temporary file; recovery never deletes unknown user files.
    assert.ok(readdirSync(workspace.path).some((name) => name.startsWith(".swarm-write-")));
  });

  it("rejects traversal, Git internals, Windows aliases and malformed paths", () => {
    const { manager } = setup();
    const workspace = manager.create("one");
    for (const path of [
      "../outside",
      "/tmp/absolute",
      "a/../../bad",
      "a\\bad",
      ".git/config",
      ".GiT/config",
      ".git /config",
      ".git./config",
      "GIT~1/config",
      ".g\u200cit/config",
      "C:/escape",
      "original.txt:stream",
      "nul.txt",
      "COM1",
      "file.",
      "a//b",
      "a/./b",
      "",
      "e\u0301.txt",
    ]) {
      assert.throws(() => manager.writeFile(workspace, path, "bad", allowed), /Unsafe/, path);
    }
  });

  it("rejects existing and dangling symlinks without touching their targets", () => {
    const { base, manager } = setup();
    const workspace = manager.create("one");
    const outside = join(base, "outside.txt");
    writeFileSync(outside, "safe");
    symlinkSync(outside, join(workspace.path, "linked.txt"));
    symlinkSync(base, join(workspace.path, "directory"));
    symlinkSync(join(base, "missing"), join(workspace.path, "dangling"));
    for (const path of ["linked.txt", "directory/outside.txt", "dangling"]) {
      assert.throws(() => manager.writeFile(workspace, path, "bad", allowed), /Unsafe/);
    }
    assert.equal(readFileSync(outside, "utf8"), "safe");
  });

  it("rejects case aliases and nested repository boundaries", () => {
    const { manager } = setup();
    const workspace = manager.create("one");
    assert.throws(() => manager.writeFile(workspace, "ORIGINAL.txt", "bad", allowed), /alias/);
    mkdirSync(join(workspace.path, "nested"));
    mkdirSync(join(workspace.path, "nested/.git"));
    assert.throws(() => manager.writeFile(workspace, "nested/source.ts", "bad", allowed), /repository boundary/);
  });

  it("rejects asynchronous authorization", () => {
    const { manager } = setup();
    const workspace = manager.create("one");
    assert.throws(() => manager.writeFile(workspace, "original.txt", "bad", async () => {}), /synchronous/);
    assert.equal(readFileSync(join(workspace.path, "original.txt"), "utf8"), "original\n");
  });
});

describe("controlled integration", () => {
  it("integrates a committed agent change while preserving the workspace", () => {
    const { repo, manager } = setup();
    const workspace = manager.create("one");
    const change = commit(workspace.path, "agent.txt", "finished\n");
    const integrated = manager.integrate(workspace, change);
    assert.equal(git(repo, "rev-parse", "HEAD"), integrated);
    assert.equal(readFileSync(join(repo, "agent.txt"), "utf8"), "finished\n");
    assert.equal(readFileSync(join(workspace.path, "agent.txt"), "utf8"), "finished\n");
    assert.equal(git(repo, "status", "--porcelain"), "");
  });

  it("aborts conflicts and restores the original clean target", () => {
    const { repo, manager } = setup();
    const workspace = manager.create("one");
    const change = commit(workspace.path, "original.txt", "agent\n");
    const originalHead = commit(repo, "original.txt", "integration\n");
    assert.throws(() => manager.integrate(workspace, change), /restored/);
    assert.equal(git(repo, "rev-parse", "HEAD"), originalHead);
    assert.equal(git(repo, "status", "--porcelain"), "");
    assert.equal(readFileSync(join(repo, "original.txt"), "utf8"), "integration\n");
    assert.equal(readFileSync(join(workspace.path, "original.txt"), "utf8"), "agent\n");
  });

  it("rejects unknown commits, other branches, dirty targets and dirty sources", () => {
    const { repo, manager } = setup();
    const workspace = manager.create("one");
    const other = manager.create("two");
    const otherCommit = commit(other.path, "other.txt", "other");
    assert.throws(() => manager.integrate(workspace, "HEAD"), /explicit/);
    assert.throws(() => manager.integrate(workspace, workspace.baseCommit), /explicit/);
    assert.throws(() => manager.integrate(workspace, otherCommit));
    const change = commit(workspace.path, "agent.txt", "finished");
    writeFileSync(join(repo, "untracked.txt"), "keep");
    assert.throws(() => manager.integrate(workspace, change), /clean/);
    assert.equal(readFileSync(join(repo, "untracked.txt"), "utf8"), "keep");
    rmSync(join(repo, "untracked.txt"));
    writeFileSync(join(workspace.path, "dirty.txt"), "keep");
    assert.throws(() => manager.integrate(workspace, change), /clean/);
  });

  it("preserves ignored files that a cherry-pick could otherwise overwrite", () => {
    const { repo, manager } = setup();
    commit(repo, ".gitignore", "local.txt\n");
    const workspace = manager.create("one");
    writeFileSync(join(workspace.path, "local.txt"), "agent");
    git(workspace.path, "add", "-f", "local.txt");
    git(workspace.path, "commit", "-m", "Add local file");
    const change = git(workspace.path, "rev-parse", "HEAD");
    writeFileSync(join(repo, "local.txt"), "user data");
    assert.throws(() => manager.integrate(workspace, change), /ignored local data/);
    assert.equal(readFileSync(join(repo, "local.txt"), "utf8"), "user data");
  });
});
