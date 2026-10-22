import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";

export function inside(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return suffix !== "" && suffix !== ".." && !suffix.startsWith(`..${sep}`) && !suffix.startsWith(sep);
}

export function pathParts(path: string): string[] {
  const parts = path.split("/");
  for (const part of parts) {
    const portable = part.normalize("NFC");
    const gitName = portable.replace(/[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/g, "");
    if (
      !part ||
      part === "." ||
      part === ".." ||
      part !== portable ||
      /[\\:\x00-\x1f\x7f]/.test(part) ||
      /[. ]$/.test(part) ||
      /^(?:\.git|git~[1-9])$/i.test(gitName) ||
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
    ) {
      throw new Error(`Unsafe workspace path: ${path}`);
    }
  }
  return parts;
}

function checkChild(parent: string, name: string, directory: boolean): void {
  const folded = name.normalize("NFC").toLowerCase();
  const aliases = readdirSync(parent).filter((entry) => entry.normalize("NFC").toLowerCase() === folded);
  if (aliases.some((entry) => entry !== name)) throw new Error(`Case or Unicode path alias: ${name}`);
  const child = join(parent, name);
  if (!existsSync(child)) {
    // lstat also detects dangling symlinks, which existsSync follows and misses.
    try {
      lstatSync(child);
      throw new Error(`Unsafe workspace path: ${child}`);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    return;
  }
  const stat = lstatSync(child);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) {
    throw new Error(`Unsafe workspace path: ${child}`);
  }
}

function resolveTarget(root: string, parts: string[], create: boolean): string {
  let parent = root;
  for (const name of parts.slice(0, -1)) {
    checkChild(parent, name, true);
    parent = join(parent, name);
    if (!existsSync(parent)) {
      if (!create) throw new Error("Workspace parent disappeared during write");
      mkdirSync(parent);
    }
    if (!inside(root, realpathSync(parent)) || existsSync(join(parent, ".git"))) {
      throw new Error("Workspace write crossed a repository boundary");
    }
  }
  const name = parts.at(-1);
  if (!name) throw new Error("A file path is required");
  checkChild(parent, name, false);
  return join(parent, name);
}

function authorizeSync(authorize: () => void): void {
  const result: unknown = authorize();
  if (typeof result === "object" && result !== null && "then" in result) {
    throw new Error("Write authorization must be synchronous");
  }
}

/** Atomic replacement protects existing content on denied leases or interrupted writes.
 * This is a cooperative write boundary, not protection from concurrent hostile filesystem changes. */
export function writeWorkspaceFile(root: string, path: string, content: string, authorize: () => void): void {
  const parts = pathParts(path);
  authorizeSync(authorize);
  const target = resolveTarget(root, parts, true);
  const temporary = join(dirname(target), `.swarm-write-${randomUUID()}`);
  let fd: number | undefined;
  try {
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    writeFileSync(fd, content, "utf8");
    if (existsSync(target)) fchmodSync(fd, lstatSync(target).mode & 0o777);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    resolveTarget(root, parts, false);
    authorizeSync(authorize);
    renameSync(temporary, target);
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
