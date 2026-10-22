import type { SwarmDb } from "../store/db.js";
import type { ClaimResult, FileClaim } from "./lab-types.js";
import {
  claims,
  DEFAULT_LEASE_TTL_MS,
  fencingToken,
  liveAgent,
  logicalPath,
  positiveDuration,
} from "./coordination-store.js";

export function fileEvent(
  db: SwarmDb,
  path: string,
  agentId: string,
  token: string | null,
  operation: string,
  now: number,
  previousOwner: string | null = null,
): void {
  db.sql
    .prepare(
      `INSERT INTO lab_file_events (path, agent_id, token, operation, previous_owner, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(path, agentId, token, operation, previousOwner, now);
}

export function expireFiles(db: SwarmDb, now: number, agentId?: string): void {
  for (const claim of claims(db)) {
    if (agentId ? claim.agentId !== agentId : claim.expiresAt > now) continue;
    fileEvent(db, claim.path, claim.agentId, claim.token, "expired", Math.min(now, claim.expiresAt));
    db.sql.prepare("DELETE FROM lab_file_claims WHERE token = ?").run(claim.token);
  }
}

export function acquireFile(
  db: SwarmDb,
  agentId: string,
  filename: string,
  now: number,
  ttlMs = DEFAULT_LEASE_TTL_MS,
): ClaimResult | undefined {
  const path = logicalPath(filename);
  const agent = liveAgent(db, agentId, now);
  positiveDuration(ttlMs);
  const prior = db.sql.prepare("SELECT agent_id FROM lab_file_claims WHERE path = ?").get(path);
  if (prior) {
    fileEvent(db, path, agentId, null, "conflict", now, String(prior.agent_id));
    return undefined;
  }
  const token = fencingToken(db);
  const expiresAt = Math.min(now + ttlMs, agent.expiresAt);
  db.sql
    .prepare(
      `INSERT INTO lab_file_claims (path, agent_id, token, acquired_at, expires_at)
    VALUES (?, ?, ?, ?, ?)`,
    )
    .run(path, agentId, token, now, expiresAt);
  fileEvent(db, path, agentId, token, "acquired", now);
  return { token, expiresAt };
}

export function assertLease(db: SwarmDb, agentId: string, filename: string, token: string, now: number): FileClaim {
  liveAgent(db, agentId, now);
  const path = logicalPath(filename);
  const row = db.sql
    .prepare("SELECT * FROM lab_file_claims WHERE path = ? AND agent_id = ? AND token = ?")
    .get(path, agentId, token);
  if (!row || Number(row.expires_at) <= now) throw new Error(`Valid file lease required: ${path}`);
  return { path, agentId, token, acquiredAt: Number(row.acquired_at), expiresAt: Number(row.expires_at) };
}

export function renewFile(
  db: SwarmDb,
  agentId: string,
  filename: string,
  token: string,
  now: number,
  ttlMs = DEFAULT_LEASE_TTL_MS,
): ClaimResult {
  const claim = assertLease(db, agentId, filename, token, now);
  const agent = liveAgent(db, agentId, now);
  positiveDuration(ttlMs);
  const expiresAt = Math.min(now + ttlMs, agent.expiresAt);
  db.sql.prepare("UPDATE lab_file_claims SET expires_at = ? WHERE token = ?").run(expiresAt, token);
  fileEvent(db, claim.path, agentId, token, "renewed", now);
  return { token, expiresAt };
}

export function releaseFile(db: SwarmDb, agentId: string, filename: string, token: string, now: number): void {
  const claim = assertLease(db, agentId, filename, token, now);
  db.sql.prepare("DELETE FROM lab_file_claims WHERE token = ?").run(token);
  fileEvent(db, claim.path, agentId, token, "released", now);
}
