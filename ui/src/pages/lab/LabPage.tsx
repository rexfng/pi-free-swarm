import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { LabSnapshot } from "../../../../src/lab/service";
import styles from "./Lab.module.css";

type DashboardSnapshot = LabSnapshot & { preview?: { recordedAt: string; description: string } };

const dollars = (micro: number) => `$${(micro / 1_000_000).toFixed(6)}`;
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const time = (ms: number) => new Date(ms).toLocaleTimeString();

export function LabPage() {
  const [data, setData] = useState<DashboardSnapshot>();
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let recorded = false;
    async function refresh() {
      try {
        const response = await fetch("/api/lab/status", { signal: controller.signal });
        if (!response.ok) throw new Error(`Status ${response.status}`);
        const next: DashboardSnapshot = await response.json();
        recorded = Boolean(next.preview);
        if (!controller.signal.aborted) {
          setData(next);
          setError("");
        }
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (!controller.signal.aborted && !recorded) timer = setTimeout(() => void refresh(), 1000);
      }
    }
    void refresh();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, []);
  const coordination = data?.coordination;
  const budget = data?.budget;
  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>ATOM SWARM LAB</p>
          <h1>{data?.preview ? "Three agents built this scene." : "What is the swarm doing?"}</h1>
        </div>
        <div>
          <div>{data?.preview ? <a href="/raytracer/">Open ray tracer ↗</a> : <Link to="/">Pi board</Link>}</div>
          <p>
            {data?.preview
              ? `Recorded ${new Date(data.preview.recordedAt).toLocaleString()}`
              : coordination
                ? `Updated ${time(coordination.now)}`
                : "Connecting…"}
          </p>
        </div>
      </header>
      {data?.preview && (
        <section className={styles.preview} aria-label="Recorded experiment">
          <strong>Recorded experiment</strong>
          <p>
            {data.preview.description} This page shows a saved run. It does not poll for updates or provide live agent
            control.
          </p>
        </section>
      )}
      {error && <p role="alert">Run data unavailable: {error}. Displayed values may be stale.</p>}
      {!data && !error && <p>Loading durable run history…</p>}
      {coordination && budget && (
        <>
          <section className={styles.tiles} aria-label="Run overview">
            <Tile
              label="Tasks complete"
              value={`${coordination.metrics.completedTasks} / ${coordination.metrics.totalTasks}`}
            />
            <Tile label="Peer completion" value={coordination.complete ? "Complete" : "In progress"} />
            <Tile
              label="Coordination / active time"
              value={`${(coordination.metrics.coordinationOverheadRatio * 100).toFixed(1)}%`}
            />
            <Tile label="Throughput" value={`${coordination.metrics.completedTasksPerMinute.toFixed(2)} tasks/min`} />
            <Tile label="File conflicts" value={String(coordination.metrics.fileConflicts)} />
            <Tile
              label="Task retries / tool failures"
              value={`${coordination.metrics.taskRetries} / ${coordination.metrics.toolFailures}`}
            />
          </section>
          <section className={styles.panel}>
            <h2>Agents and time allocation</h2>
            <p>
              Activity inferred from tools carries confidence. Time between events inherits the last state; it is an
              estimate.
            </p>
            <table>
              <thead>
                <tr>
                  <th>Agent</th>
                  <th>State</th>
                  <th>Current activity</th>
                  <th>Active</th>
                  <th>Idle / blocked</th>
                  <th>Tool calls</th>
                </tr>
              </thead>
              <tbody>
                {coordination.agents.map((agent) => {
                  const metrics = coordination.metrics.byAgent.find((entry) => entry.agentId === agent.id);
                  const current = coordination.activities.find(
                    (entry) => entry.agentId === agent.id && entry.endedAt === null,
                  );
                  return (
                    <tr key={agent.id}>
                      <td>{agent.id}</td>
                      <td>{agent.state}</td>
                      <td>
                        {current
                          ? `${current.category} · ${Math.round(current.confidence * 100)}% (${current.source})`
                          : "—"}
                      </td>
                      <td>{seconds(metrics?.activeMs ?? 0)}</td>
                      <td>{seconds((metrics?.idleMs ?? 0) + (metrics?.blockedMs ?? 0))}</td>
                      <td>{metrics?.toolCalls ?? 0}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {coordination.agents.length === 0 && <p>No registered agents.</p>}
          </section>
          <div className={styles.columns}>
            <section className={styles.panel}>
              <h2>Task discovery and completion evidence</h2>
              <p>Completion is peer-attested. Integration and independent tests must verify the output.</p>
              <table>
                <thead>
                  <tr>
                    <th>Task</th>
                    <th>Status / owner</th>
                    <th>Dependencies</th>
                    <th>Execution</th>
                    <th>Evidence</th>
                  </tr>
                </thead>
                <tbody>
                  {coordination.tasks.map((task) => (
                    <tr key={task.id}>
                      <td>
                        <strong>{task.id}</strong>
                        <p>{task.title}</p>
                      </td>
                      <td>
                        {task.status}
                        <p>{task.owner ?? "Unclaimed"}</p>
                      </td>
                      <td>{task.dependencies.join(", ") || "—"}</td>
                      <td>{seconds(task.executionMs)}</td>
                      <td>{task.evidence ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
            <section className={styles.panel}>
              <h2>File ownership</h2>
              <table>
                <thead>
                  <tr>
                    <th>Path</th>
                    <th>Owner</th>
                    <th>Lease expires</th>
                  </tr>
                </thead>
                <tbody>
                  {coordination.claims.map((claim) => (
                    <tr key={claim.path}>
                      <td>{claim.path}</td>
                      <td>{claim.agentId}</td>
                      <td>{time(claim.expiresAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {coordination.claims.length === 0 && <p>No active file claims.</p>}
              <h3>Recent ownership events</h3>
              {coordination.fileHistory
                .slice(-8)
                .reverse()
                .map((event) => (
                  <p key={event.id}>
                    {event.agentId} · {event.operation} · {event.path}
                  </p>
                ))}
            </section>
          </div>
          <section className={styles.panel}>
            <h2>Budget and usage</h2>
            <p>
              {budget.frozen
                ? "Frozen: a request exceeded its declared bound."
                : "Reservations include pending requests."}{" "}
              Only requests routed through the bounded gateway are accounted here. External clients' model bills are not
              captured.
            </p>
            <table>
              <thead>
                <tr>
                  <th>Scope</th>
                  <th>Limit</th>
                  <th>Accounted</th>
                  <th>Reserved</th>
                  <th>Available</th>
                </tr>
              </thead>
              <tbody>
                {budget.scopes.map((scope) => (
                  <tr key={scope.scope}>
                    <td>{scope.scope}</td>
                    <td>{dollars(scope.limitMicroUsd)}</td>
                    <td>{dollars(scope.spentMicroUsd)}</td>
                    <td>{dollars(scope.reservedMicroUsd)}</td>
                    <td>{dollars(scope.remainingMicroUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {budget.scopes.length === 0 && <p>No budgets configured: gateway requests are blocked.</p>}
            <p>
              {budget.requests} gateway requests · {budget.inputTokens} input / {budget.outputTokens} output tokens ·{" "}
              {budget.cacheReadTokens} cache read / {budget.cacheWriteTokens} cache write · {budget.failures} failures ·{" "}
              {budget.retries} retries · {budget.unknownUsage} unknown usage
            </p>
            {budget.models.map((model) => (
              <p key={model.agentId}>
                {model.agentId}: {model.provider} / {model.model} · request bound{" "}
                {dollars(model.maxRequestCostMicroUsd)}
              </p>
            ))}
          </section>
          <div className={styles.columns}>
            <section className={styles.panel}>
              <h2>Activity timeline</h2>
              <table>
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Agent</th>
                    <th>Activity</th>
                    <th>Duration</th>
                    <th>Evidence</th>
                  </tr>
                </thead>
                <tbody>
                  {coordination.activities
                    .slice(-30)
                    .reverse()
                    .map((activity) => (
                      <tr key={activity.id}>
                        <td>{time(activity.startedAt)}</td>
                        <td>{activity.agentId}</td>
                        <td>{activity.category}</td>
                        <td>{seconds(activity.durationMs)}</td>
                        <td>
                          {activity.source} · {Math.round(activity.confidence * 100)}%
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </section>
            <section className={styles.panel}>
              <h2>Shared discussion</h2>
              {coordination.messages
                .slice(-30)
                .reverse()
                .map((message) => (
                  <article key={message.id} className={styles.message}>
                    <small>
                      {time(message.createdAt)} · {message.agentId} → {message.to ?? "board"}
                    </small>
                    <p>{message.body}</p>
                  </article>
                ))}
              {coordination.messages.length === 0 && <p>No messages yet.</p>}
            </section>
          </div>
        </>
      )}
    </main>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.tile}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
