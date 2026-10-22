// Drives one agent's pi process through pending → starting → working ⇄ idle → crashed | stopped.
// DB-free: everything the runner records arrives through SupervisorHooks.
import type { AgentActivity, ParticipantStatus } from "../api-types.js";
import { systemClock, type Clock, type TimerHandle } from "../clock.js";
import { EXTENSION_LOAD_FAILURE_MARKER, STARTUP_RETRY_BASE_BACKOFF_MS } from "../constants.js";
import type { UsageSample } from "../runtime-types.js";
import { AgentProcess, type AgentExitInfo } from "./agent-process.js";
import type { AgentLaunchSpec } from "./launch.js";
import { createProtocolHandler } from "./protocol.js";
import { dialogRequestId, headerMessageIds, type RpcRecord } from "./rpc-events.js";
import { StallWatchdog, watchdogConfigFromEnv, type StallKind, type WatchdogConfig } from "./watchdog.js";

export interface PromptPayload {
  text: string;
  messageIds: readonly number[];
}

export type DeliveryOutcome = { accepted: true } | { accepted: false; error: string };

export interface AgentCrash {
  reason: "exit" | "startup_timeout" | "inactivity" | "spawn_error" | "extension_load_failed" | "prompt_rejected";
  /** true for extension_load_failed and prompt_rejected: the caller must not revive. */
  fatal: boolean;
  message: string;
  exitCode: number | null;
  signal: string | null;
  stderrTail: string;
}

export interface SupervisorHooks {
  /** Every transition, never the initial "pending". */
  onStatus(status: ParticipantStatus): void;
  /** `[swarm message #id]` markers in a user message_start. */
  onMessagesRead(messageIds: number[]): void;
  onUsage(sample: UsageSample): void;
  onActivity(activity: AgentActivity | null): void;
  /** After onStatus("crashed"); never for stop(). */
  onCrash(crash: AgentCrash): void;
}

/** One spawn of the agent's process and the state that dies with it. */
interface Life {
  proc: AgentProcess;
  watchdog: StallWatchdog;
  handle(event: RpcRecord): void;
  stall: { kind: StallKind; message: string } | null;
  promptsInFlight: number;
  deferredSettle: boolean;
  runStarts: number;
}

export class AgentSupervisor {
  readonly name: string;
  readonly #hooks: SupervisorHooks;
  readonly #clock: Clock;
  readonly #config: WatchdogConfig;
  #status: ParticipantStatus = "pending";
  #life: Life | null = null;
  #launch: { spec: AgentLaunchSpec; prompt: PromptPayload | null; retriesUsed: number } | null = null;
  #resolveLaunch: ((outcome: DeliveryOutcome) => void) | null = null;
  #retryTimer: TimerHandle | undefined;
  #activityKey = "null";
  #deliveryTail: Promise<unknown> = Promise.resolve();
  readonly #sentIds = new Set<number>();
  #stopped: Promise<void> | null = null;

  constructor(options: { name: string; hooks: SupervisorHooks; clock?: Clock; watchdog?: WatchdogConfig }) {
    this.name = options.name;
    this.#hooks = options.hooks;
    this.#clock = options.clock ?? systemClock;
    this.#config = options.watchdog ?? watchdogConfigFromEnv();
  }

  get status(): ParticipantStatus {
    return this.#status;
  }

  /** Null prompt boots idle without a model call; otherwise resolves with the prompt's outcome. */
  launch(spec: AgentLaunchSpec, prompt: PromptPayload | null): Promise<DeliveryOutcome> {
    if (this.#stopped || (this.#status !== "pending" && this.#status !== "crashed")) {
      return Promise.resolve({ accepted: false, error: `${this.name} is ${this.#status}.` });
    }
    this.#launch = { spec, prompt, retriesUsed: 0 };
    this.#setStatus("starting");
    return new Promise((resolve) => {
      this.#resolveLaunch = resolve;
      void this.#spawn();
    });
  }

  /** Only while working|idle. Queued as steering while working, starts a run while idle. */
  deliver(prompt: PromptPayload): Promise<DeliveryOutcome> {
    return this.#serialize(() => this.#deliver(prompt));
  }

  recoverUnread(prompt: PromptPayload): Promise<DeliveryOutcome> {
    return this.#serialize(async () => {
      const life = this.#life;
      if (!life || this.#stopped || this.#status !== "idle") {
        return { accepted: false, error: `${this.name} is ${this.#status}.` };
      }
      life.promptsInFlight++;
      life.watchdog.rearm();
      try {
        const response = await life.proc.send({ type: "clear_queue" });
        if (response.success !== true) {
          life.watchdog.disarm();
          return { accepted: false, error: "Could not clear the steering queue." };
        }
        if (life !== this.#life || this.#stopped) return { accepted: false, error: `${this.name} exited.` };
        return (await this.#sendPrompt(life, prompt)) ?? { accepted: false, error: `${this.name} exited.` };
      } catch (error) {
        return { accepted: false, error: error instanceof Error ? error.message : String(error) };
      } finally {
        life.promptsInFlight--;
        if (life.promptsInFlight === 0 && life.deferredSettle) {
          life.deferredSettle = false;
          this.#applySettle(life);
        }
      }
    });
  }

  #serialize(operation: () => Promise<DeliveryOutcome>): Promise<DeliveryOutcome> {
    const result = this.#deliveryTail.then(operation);
    this.#deliveryTail = result.catch(() => undefined);
    return result;
  }

  async #deliver(prompt: PromptPayload): Promise<DeliveryOutcome> {
    const life = this.#life;
    if (!life || this.#stopped || (this.#status !== "working" && this.#status !== "idle")) {
      return { accepted: false, error: `${this.name} is ${this.#status}.` };
    }
    return (await this.#sendPrompt(life, prompt)) ?? { accepted: false, error: `${this.name} exited.` };
  }

  /** → stopped (crashed stays crashed): SIGTERM the group, SIGKILL after 5 s; resolves once gone. Idempotent. */
  stop(): Promise<void> {
    if (!this.#stopped) {
      this.#retryTimer?.cancel();
      const life = this.#life;
      life?.watchdog.disarm();
      if (this.#status !== "crashed") this.#setStatus("stopped");
      this.#settleLaunch({ accepted: false, error: `${this.name} was stopped.` });
      this.#stopped = life ? life.proc.stop() : Promise.resolve();
    }
    return this.#stopped;
  }

  async #spawn(): Promise<void> {
    const launch = this.#launch;
    if (!launch || this.#stopped) return;
    // Events and exits only arrive asynchronously, after `life` is assigned below.
    let life: Life;
    let proc: AgentProcess;
    try {
      proc = AgentProcess.spawn(
        launch.spec,
        { onEvent: (event) => this.#onEvent(life, event), onExit: (info) => this.#onExit(life, info) },
        this.#clock,
      );
    } catch (error) {
      // A bad command override throws before any child exists.
      const message = error instanceof Error ? error.message : String(error);
      this.#crash({ reason: "spawn_error", fatal: false, message, exitCode: null, signal: null, stderrTail: "" });
      return;
    }
    const watchdog = new StallWatchdog(this.#config, this.#clock, (kind, message) => {
      life.stall = { kind, message };
      void proc.stop();
    });
    const handle = createProtocolHandler(watchdog, {
      onRunStart: () => {
        life.runStarts++;
        life.deferredSettle = false;
        this.#setStatus("working");
      },
      onSettled: () => {
        // Settle gap: a stale agent_settled can arrive between a prompt and its response.
        if (life.promptsInFlight > 0) life.deferredSettle = true;
        else this.#applySettle(life);
      },
      onUserMessage: (text) => {
        const ids = headerMessageIds(text).filter((id) => this.#sentIds.has(id));
        if (ids.length > 0) this.#hooks.onMessagesRead(ids);
      },
      onUsage: (sample) => this.#hooks.onUsage(sample),
      onActivity: (activity) => this.#setActivity(activity),
    });
    life = { proc, watchdog, handle, stall: null, promptsInFlight: 0, deferredSettle: false, runStarts: 0 };
    this.#life = life;
    watchdog.armStartup();

    // pi handles commands concurrently; the mode must be set before the prompt can queue anything.
    const steering = await proc.send({ type: "set_steering_mode", mode: "all" }).catch(() => null);
    if (!steering || this.#stopped) return;
    if (launch.prompt === null) {
      watchdog.disarm();
      this.#setStatus("idle");
      this.#settleLaunch({ accepted: true });
      return;
    }
    const outcome = await this.#sendPrompt(life, launch.prompt);
    if (!outcome || this.#stopped) return;
    if (outcome.accepted) {
      this.#settleLaunch(outcome);
      return;
    }
    // Deterministic (e.g. no usable model), so a revive would fail the same way.
    watchdog.disarm();
    const message = `The launch prompt was rejected: ${outcome.error}`;
    this.#crash({ reason: "prompt_rejected", fatal: true, message, exitCode: null, signal: null, stderrTail: "" });
    void proc.stop();
  }

  /** null when the process exited before answering; the exit path reports that. */
  async #sendPrompt(life: Life, prompt: PromptPayload): Promise<DeliveryOutcome | null> {
    life.promptsInFlight++;
    const runStarts = life.runStarts;
    for (const id of prompt.messageIds) this.#sentIds.add(id);
    try {
      const response = await life.proc.send({ type: "prompt", message: prompt.text, streamingBehavior: "steer" });
      if (life !== this.#life || this.#stopped) return null;
      if (response.success !== true) {
        return { accepted: false, error: typeof response.error === "string" ? response.error : "Prompt rejected." };
      }
      // Reserve accepted work before agent_start arrives, so delivery cannot mistake it for an unread idle queue.
      // A fast new turn can also settle in the same batch as its prompt response.
      if (life.runStarts === runStarts) {
        life.deferredSettle = false;
        this.#setStatus("working");
      }
      life.watchdog.rearm();
      return { accepted: true };
    } catch {
      return null;
    } finally {
      life.promptsInFlight--;
      if (life.promptsInFlight === 0 && life.deferredSettle) {
        life.deferredSettle = false;
        this.#applySettle(life);
      }
    }
  }

  #onEvent(life: Life, event: RpcRecord): void {
    if (life !== this.#life || this.#stopped || this.#status === "crashed") return;
    const dialogId = dialogRequestId(event);
    if (dialogId) life.proc.write({ type: "extension_ui_response", id: dialogId, cancelled: true });
    // Dialogs included: every record is liveness for the watchdog.
    life.handle(event);
  }

  #applySettle(life: Life): void {
    if (life === this.#life && this.#status === "working") {
      life.watchdog.disarm();
      this.#setStatus("idle");
    }
  }

  #onExit(life: Life, info: AgentExitInfo): void {
    if (life !== this.#life) return;
    this.#life = null;
    life.watchdog.disarm();
    if (this.#stopped || this.#status === "crashed") return;
    const launch = this.#launch;
    const common = { exitCode: info.code, signal: info.signal, stderrTail: info.stderrTail };
    if (info.spawnError !== null) {
      this.#crash({ ...common, reason: "spawn_error", fatal: false, message: info.spawnError });
    } else if (this.#status === "starting" && info.stderrTail.includes(EXTENSION_LOAD_FAILURE_MARKER)) {
      const message = firstLineWith(info.stderrTail, EXTENSION_LOAD_FAILURE_MARKER);
      this.#crash({ ...common, reason: "extension_load_failed", fatal: true, message });
    } else if (life.stall?.kind === "startup" && launch && launch.retriesUsed < this.#config.startupRetries) {
      // Almost always a transient cold-start stall: respawn a clean child, staying `starting`.
      const backoffMs = STARTUP_RETRY_BASE_BACKOFF_MS * 2 ** launch.retriesUsed;
      launch.retriesUsed++;
      this.#retryTimer = this.#clock.after(backoffMs, () => void this.#spawn());
    } else if (life.stall) {
      const reason = life.stall.kind === "startup" ? "startup_timeout" : "inactivity";
      this.#crash({ ...common, reason, fatal: false, message: life.stall.message });
    } else {
      const how = info.signal ? `from signal ${info.signal}` : `with code ${info.code ?? "null"}`;
      this.#crash({ ...common, reason: "exit", fatal: false, message: `Agent process exited ${how}.` });
    }
  }

  #crash(crash: AgentCrash): void {
    this.#setStatus("crashed");
    this.#hooks.onCrash(crash);
    this.#settleLaunch({ accepted: false, error: crash.message });
  }

  #settleLaunch(outcome: DeliveryOutcome): void {
    const resolve = this.#resolveLaunch;
    this.#resolveLaunch = null;
    resolve?.(outcome);
  }

  #setStatus(status: ParticipantStatus): void {
    if (status === this.#status) return;
    this.#status = status;
    if (status !== "working") this.#activityKey = "null";
    this.#hooks.onStatus(status);
  }

  #setActivity(activity: AgentActivity | null): void {
    const key = JSON.stringify(activity);
    if (key === this.#activityKey) return;
    this.#activityKey = key;
    this.#hooks.onActivity(activity);
  }
}

function firstLineWith(text: string, marker: string): string {
  return (
    text
      .split("\n")
      .find((line) => line.includes(marker))
      ?.trim() ?? marker
  );
}
