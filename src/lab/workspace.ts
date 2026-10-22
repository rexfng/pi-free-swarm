import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { inside, writeWorkspaceFile } from "./workspace-paths.js";

export interface Workspace {
  agentId: string;
  path: string;
  branch: string;
  baseCommit: string;
}

const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER = 8 * 1024 * 1024;
const COMMIT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "commit.gpgSign=false", ...args],
    {
      cwd,
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    },
  ).trim();
}

function cleanAttached(cwd: string): void {
  if (!git(cwd, "symbolic-ref", "--quiet", "HEAD")) throw new Error("Repository must have an attached branch");
  if (git(cwd, "status", "--porcelain", "--untracked-files=all")) throw new Error("Repository must be clean");
  for (const operation of ["CHERRY_PICK_HEAD", "MERGE_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"]) {
    if (existsSync(resolve(cwd, git(cwd, "rev-parse", "--git-path", operation)))) {
      throw new Error(`Repository has an unfinished Git operation: ${operation}`);
    }
  }
}

function isWorkspace(value: unknown): value is Workspace {
  return (
    typeof value === "object" &&
    value !== null &&
    "agentId" in value &&
    typeof value.agentId === "string" &&
    "path" in value &&
    typeof value.path === "string" &&
    "branch" in value &&
    typeof value.branch === "string" &&
    "baseCommit" in value &&
    typeof value.baseCommit === "string"
  );
}

/** Git worktrees provide source isolation. They do not sandbox commands, credentials or the host. */
export class WorkspaceManager {
  readonly repoPath: string;
  readonly rootPath: string;

  constructor(repoPath: string, rootPath: string) {
    this.repoPath = realpathSync(repoPath);
    if (realpathSync(git(this.repoPath, "rev-parse", "--show-toplevel")) !== this.repoPath) {
      throw new Error("repoPath must be the repository root");
    }
    mkdirSync(rootPath, { recursive: true });
    this.rootPath = realpathSync(rootPath);
    if (this.rootPath === this.repoPath || inside(this.repoPath, this.rootPath)) {
      throw new Error("Workspace root must be outside the integration repository");
    }
  }

  create(agentId: string, baseRef = "HEAD"): Workspace {
    this.validateAgent(agentId);
    if (!/^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(baseRef)) throw new Error("Invalid Git base reference");
    cleanAttached(this.repoPath);
    const baseCommit = git(this.repoPath, "rev-parse", "--verify", "--end-of-options", `${baseRef}^{commit}`);
    if (!COMMIT_ID.test(baseCommit)) throw new Error("Git base did not resolve to a commit");
    const workspace = { agentId, path: join(this.rootPath, agentId), branch: `atom-swarm/${agentId}`, baseCommit };
    // Git may inspect partially-created metadata for other worktrees; serialize all mutations.
    const lock = join(this.rootPath, ".integration-lock");
    mkdirSync(lock);
    try {
      if (existsSync(workspace.path) || existsSync(this.recordPath(agentId)))
        throw new Error("Workspace already exists");
      git(this.repoPath, "worktree", "add", "-b", workspace.branch, "--", workspace.path, baseCommit);
      // A failed metadata write intentionally leaves the worktree intact for manual recovery.
      writeFileSync(this.recordPath(agentId), JSON.stringify(workspace, null, 2), { flag: "wx", mode: 0o600 });
      return workspace;
    } finally {
      rmdirSync(lock);
    }
  }

  list(): Workspace[] {
    return readdirSync(this.rootPath)
      .filter((name) => /^\.workspace-[a-z0-9][a-z0-9_-]{0,63}\.json$/.test(name))
      .map((name) => this.readRecord(name.slice(".workspace-".length, -".json".length)));
  }

  writeFile(workspace: Workspace, relativePath: string, content: string, authorize: () => void): void {
    this.validateWorkspace(workspace);
    writeWorkspaceFile(workspace.path, relativePath, content, authorize);
  }

  integrate(workspace: Workspace, commit: string): string {
    this.validateWorkspace(workspace);
    if (!COMMIT_ID.test(commit) || commit === workspace.baseCommit)
      throw new Error("Expected an explicit workspace commit ID");
    cleanAttached(workspace.path);
    git(workspace.path, "merge-base", "--is-ancestor", workspace.baseCommit, commit);
    git(workspace.path, "merge-base", "--is-ancestor", commit, "HEAD");
    const parents = git(workspace.path, "rev-list", "--parents", "-n", "1", commit).split(" ");
    if (parents.length !== 2) throw new Error("Only single-parent commits can be integrated");
    const lock = join(this.rootPath, ".integration-lock");
    mkdirSync(lock);
    try {
      cleanAttached(this.repoPath);
      this.rejectIgnoredCollisions(commit);
      try {
        git(this.repoPath, "cherry-pick", "--", commit);
      } catch (error) {
        const marker = resolve(this.repoPath, git(this.repoPath, "rev-parse", "--git-path", "CHERRY_PICK_HEAD"));
        if (existsSync(marker)) git(this.repoPath, "cherry-pick", "--abort");
        cleanAttached(this.repoPath);
        throw new Error("Integration failed; target restored to its original clean state", { cause: error });
      }
      return git(this.repoPath, "rev-parse", "HEAD");
    } finally {
      rmdirSync(lock);
    }
  }

  private rejectIgnoredCollisions(commit: string): void {
    const changed = git(this.repoPath, "diff-tree", "--no-commit-id", "--name-only", "-r", "-z", commit)
      .split("\0")
      .filter(Boolean)
      .map((path) => path.normalize("NFC").toLowerCase());
    const ignored = git(this.repoPath, "ls-files", "--others", "--ignored", "--exclude-standard", "-z")
      .split("\0")
      .filter(Boolean)
      .map((path) => path.normalize("NFC").toLowerCase());
    if (
      changed.some((path) =>
        ignored.some((file) => file === path || file.startsWith(`${path}/`) || path.startsWith(`${file}/`)),
      )
    ) {
      throw new Error("Integration would overwrite ignored local data");
    }
  }

  private validateAgent(agentId: string): void {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(agentId)) throw new Error("Invalid agent identity");
  }

  private recordPath(agentId: string): string {
    this.validateAgent(agentId);
    return join(this.rootPath, `.workspace-${agentId}.json`);
  }

  private readRecord(agentId: string): Workspace {
    const record = this.recordPath(agentId);
    if (!lstatSync(record).isFile()) throw new Error("Workspace metadata must be a regular file");
    const parsed: unknown = JSON.parse(readFileSync(record, "utf8"));
    if (
      !isWorkspace(parsed) ||
      parsed.agentId !== agentId ||
      parsed.path !== join(this.rootPath, agentId) ||
      parsed.branch !== `atom-swarm/${agentId}` ||
      !COMMIT_ID.test(parsed.baseCommit)
    ) {
      throw new Error("Invalid workspace metadata");
    }
    return parsed;
  }

  private validateWorkspace(workspace: Workspace): void {
    const expected = this.readRecord(workspace.agentId);
    if (Object.keys(expected).some((key) => Reflect.get(expected, key) !== Reflect.get(workspace, key))) {
      throw new Error("Workspace does not match its registration");
    }
    if (lstatSync(workspace.path).isSymbolicLink() || realpathSync(workspace.path) !== workspace.path) {
      throw new Error("Workspace path is no longer canonical");
    }
    if (git(workspace.path, "symbolic-ref", "--short", "HEAD") !== workspace.branch) {
      throw new Error("Workspace branch changed");
    }
    const shared = realpathSync(resolve(workspace.path, git(workspace.path, "rev-parse", "--git-common-dir")));
    const original = realpathSync(resolve(this.repoPath, git(this.repoPath, "rev-parse", "--git-common-dir")));
    if (shared !== original) throw new Error("Workspace belongs to another repository");
  }
}
