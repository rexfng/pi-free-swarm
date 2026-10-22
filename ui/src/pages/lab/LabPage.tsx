import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { LabSnapshot } from "../../../../src/lab/service";
import { LabTable } from "./LabTable";
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
            <LabTable
              label="Agents and time allocation"
              rows={coordination.agents.map((agent) => ({
                ...agent,
                metrics: coordination.metrics.byAgent.find((entry) => entry.agentId === agent.id),
                current: coordination.activities.find((entry) => entry.agentId === agent.id && entry.endedAt === null),
              }))}
              rowKey={(agent) => agent.id}
              columns={[
                { label: "Agent", render: (agent) => <strong>{agent.id}</strong> },
                { label: "State", render: (agent) => agent.state },
                {
                  label: "Current activity",
                  render: ({ current }) =>
                    current
                      ? `${current.category} · ${Math.round(current.confidence * 100)}% (${current.source})`
                      : "—",
                },
                { label: "Active", render: ({ metrics }) => seconds(metrics?.activeMs ?? 0) },
                {
                  label: "Idle / blocked",
                  render: ({ metrics }) => seconds((metrics?.idleMs ?? 0) + (metrics?.blockedMs ?? 0)),
                },
                { label: "Tool calls", render: ({ metrics }) => metrics?.toolCalls ?? 0 },
              ]}
            />
            {coordination.agents.length === 0 && <p>No registered agents.</p>}
          </section>
          <div className={styles.columns}>
            <section className={styles.panel}>
              <h2>Task discovery and completion evidence</h2>
              <p>Completion is peer-attested. Integration and independent tests must verify the output.</p>
              <LabTable
                label="Tasks"
                rows={coordination.tasks}
                rowKey={(task) => task.id}
                columns={[
                  {
                    label: "Task",
                    fullWidth: true,
                    render: (task) => (
                      <>
                        <strong>{task.id}</strong>
                        <p>{task.title}</p>
                      </>
                    ),
                  },
                  {
                    label: "Status / owner",
                    render: (task) => (
                      <>
                        {task.status}
                        <p>{task.owner ?? "Unclaimed"}</p>
                      </>
                    ),
                  },
                  { label: "Dependencies", render: (task) => task.dependencies.join(", ") || "—" },
                  { label: "Execution", render: (task) => seconds(task.executionMs) },
                  {
                    label: "Evidence",
                    fullWidth: true,
                    render: (task) =>
                      task.evidence ? (
                        <details>
                          <summary>View completion evidence</summary>
                          <p>{task.evidence}</p>
                        </details>
                      ) : (
                        "—"
                      ),
                  },
                ]}
              />
            </section>
            <section className={styles.panel}>
              <h2>File ownership</h2>
              <LabTable
                label="File ownership"
                rows={coordination.claims}
                rowKey={(claim) => claim.path}
                columns={[
                  { label: "Path", fullWidth: true, render: (claim) => claim.path },
                  { label: "Owner", render: (claim) => claim.agentId },
                  { label: "Lease expires", render: (claim) => time(claim.expiresAt) },
                ]}
              />
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
            <LabTable
              label="Budget and usage"
              rows={budget.scopes}
              rowKey={(scope) => scope.scope}
              columns={[
                { label: "Scope", render: (scope) => scope.scope },
                { label: "Limit", render: (scope) => dollars(scope.limitMicroUsd) },
                { label: "Accounted", render: (scope) => dollars(scope.spentMicroUsd) },
                { label: "Reserved", render: (scope) => dollars(scope.reservedMicroUsd) },
                { label: "Available", render: (scope) => dollars(scope.remainingMicroUsd) },
              ]}
            />
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
              <LabTable
                label="Activity timeline"
                rows={coordination.activities.slice(-30).reverse()}
                rowKey={(activity) => activity.id}
                columns={[
                  { label: "Time", render: (activity) => time(activity.startedAt) },
                  { label: "Agent", render: (activity) => activity.agentId },
                  { label: "Activity", render: (activity) => activity.category },
                  { label: "Duration", render: (activity) => seconds(activity.durationMs) },
                  {
                    label: "Evidence",
                    render: (activity) => `${activity.source} · ${Math.round(activity.confidence * 100)}%`,
                  },
                ]}
              />
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
