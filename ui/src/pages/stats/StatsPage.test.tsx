import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentStats, StatsResponse, SwarmEvent } from "../../../../src/api-types";
import { SwarmStreamProvider } from "../../api/SwarmStream";
import { installFakeApi, type FakeApi } from "../../test/fakeApi";
import { installFakeEventSource, type FakeEventSource } from "../../test/fakeEventSource";
import { STATS_REFRESH_MS, STATS_CLOCK_MS, StatsPage } from "./StatsPage";

const agentStats = (name: string, patch: Partial<AgentStats>): AgentStats => ({
  name,
  status: "working",
  activeTimeMs: 0,
  reviveCount: 0,
  posts: 0,
  comments: 0,
  messagesSent: 0,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  turns: 0,
  ...patch,
});

const stats: StatsResponse = {
  swarmId: 3,
  computedAt: 0,
  agents: [
    agentStats("Liam", { cost: 0.6, input: 1_900_000, output: 1_000, activeTimeMs: 3_840_000 }),
    agentStats("Ava", { cost: 0.4, input: 412_000, output: 3_000, status: "idle", activeTimeMs: 750_000 }),
    agentStats("Zoe", { cost: 0.23, input: 950, output: 2_000, status: "crashed", cacheRead: 5_000 }),
  ],
  totals: {
    input: 2_312_950,
    output: 6_000,
    cacheRead: 5_000,
    cacheWrite: 0,
    cost: 1.23,
    turns: 3,
    wallTimeMs: 750_000,
    activeTimeMs: 4_590_000,
    runCount: 2,
    posts: 14,
    comments: 3,
    messages: 128,
  },
};

const usageUpdated: SwarmEvent = {
  id: 7,
  swarmId: 3,
  createdAt: 0,
  type: "usage.updated",
  payload: { agent: "Liam", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.7, turns: 1 } },
};

let source: () => FakeEventSource;
let api: FakeApi;

beforeEach(() => {
  source = installFakeEventSource();
  api = installFakeApi();
  api.on("GET", "/api/swarms/3/stats", () => stats);
  api.on("GET", "/api/swarms/3", () => ({ swarm: { id: 3, status: "running" }, participants: [] }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function renderStats(path = "/s/3/stats") {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="/s/:id/stats"
          element={
            <SwarmStreamProvider swarmId="3">
              <StatsPage />
            </SwarmStreamProvider>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
  act(() => source().open());
  await screen.findByRole("table");
}

// Row header names by accessible name: the avatar initial is aria-hidden but still in textContent.
const bodyNames = () =>
  within(screen.getAllByRole("rowgroup")[1])
    .getAllByRole("row")
    .map((row) => stats.agents.find(({ name }) => within(row).queryByRole("rowheader", { name }))?.name);

describe("StatsPage", () => {
  it("highlights and scrolls to the agent query after loading", async () => {
    const scroll = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scroll });
    await renderStats("/s/3/stats?agent=zoe");
    const row = screen.getByRole("rowheader", { name: "Zoe" }).closest("tr");
    expect(row).toHaveAttribute("aria-current", "true");
    expect(row?.className).toMatch(/selected/);
    await waitFor(() => expect(scroll).toHaveBeenCalledWith({ block: "center" }));
    expect(scroll.mock.instances[0]).toBe(row);
    expect(screen.queryByRole("button", { name: "Show stats: Zoe" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Agent" }));
    expect(screen.getByRole("rowheader", { name: "Zoe" }).closest("tr")).toHaveAttribute("aria-current", "true");
  });

  it("refreshes elapsed durations while running, but not after finishing", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await renderStats();
    const count = () => api.callsTo("GET", "/api/swarms/3/stats").length;
    const before = count();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STATS_CLOCK_MS);
    });
    expect(count()).toBe(before + 1);
    api.on("GET", "/api/swarms/3", () => ({ swarm: { id: 3, status: "finished" }, participants: [] }));
    act(() =>
      source().emit({
        id: 9,
        swarmId: 3,
        createdAt: 0,
        type: "swarm.updated",
        payload: {
          swarm: {
            id: 3,
            name: "test",
            status: "finished",
            acceptsMessages: false,
            taskPrompt: "test",
            agentAmount: 3,
            agentsWorking: 0,
            runCount: 1,
            runnerPid: null,
            createdAt: 0,
            startedAt: 0,
            finishedAt: 1,
          },
        },
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STATS_REFRESH_MS);
    });
    const finished = count();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STATS_CLOCK_MS * 2);
    });
    expect(count()).toBe(finished);
  });

  it("invalidates counts on posts, comments and messages", async () => {
    await renderStats();
    vi.useFakeTimers();
    const events: SwarmEvent[] = [
      {
        id: 1,
        swarmId: 3,
        createdAt: 0,
        type: "post.created",
        payload: { post: { id: 1, swarmId: 3, author: "Ava", title: "t", text: "x", commentCount: 0, createdAt: 0 } },
      },
      {
        id: 2,
        swarmId: 3,
        createdAt: 0,
        type: "comment.created",
        payload: { comment: { id: 1, postId: 1, swarmId: 3, author: "Ava", text: "x", createdAt: 0 }, commentCount: 1 },
      },
      {
        id: 3,
        swarmId: 3,
        createdAt: 0,
        type: "message.created",
        payload: {
          message: {
            id: 1,
            threadId: 1,
            swarmId: 3,
            sender: "Ava",
            senderKind: "agent",
            text: "x",
            createdAt: 0,
            recipients: [],
          },
          unread: {},
        },
      },
    ];
    for (const event of events) {
      const before = api.callsTo("GET", "/api/swarms/3/stats").length;
      act(() => source().emit(event));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(STATS_REFRESH_MS);
      });
      expect(api.callsTo("GET", "/api/swarms/3/stats")).toHaveLength(before + 1);
    }
  });
  it("shows the swarm totals as formatted tiles, cost in accent", async () => {
    await renderStats();
    const tile = (label: string) => screen.getByText(label, { selector: "dt" }).nextElementSibling;
    expect(tile("Cost")).toHaveTextContent("$1.23");
    expect(tile("Cost")?.className).toMatch(/accent/);
    expect(tile("Wall time")).toHaveTextContent("12m 30s");
    expect(tile("Wall time")?.className).not.toMatch(/accent/);
    expect(tile("Agent time")).toHaveTextContent("1h 16m");
    expect(tile("Tokens in")).toHaveTextContent("2.3M");
    expect(tile("Tokens out")).toHaveTextContent("6k");
    expect(tile("Messages · Posts")).toHaveTextContent("128 · 14");
  });

  it("sorts by cost first and by any column on click", async () => {
    await renderStats();
    expect(bodyNames()).toEqual(["Liam", "Ava", "Zoe"]);
    expect(screen.getByRole("columnheader", { name: "Cost" })).toHaveAttribute("aria-sort", "descending");

    await userEvent.click(screen.getByRole("button", { name: "Agent" }));
    expect(bodyNames()).toEqual(["Ava", "Liam", "Zoe"]);
    expect(screen.getByRole("columnheader", { name: "Agent" })).toHaveAttribute("aria-sort", "ascending");
    expect(screen.getByRole("columnheader", { name: "Cost" })).toHaveAttribute("aria-sort", "none");

    await userEvent.click(screen.getByRole("button", { name: "Agent" }));
    expect(bodyNames()).toEqual(["Zoe", "Liam", "Ava"]);

    await userEvent.click(screen.getByRole("button", { name: "Tokens out" }));
    expect(bodyNames()).toEqual(["Ava", "Zoe", "Liam"]);
  });

  it("formats the rows, draws cost shares and pins the total row", async () => {
    await renderStats();
    const [liam] = within(screen.getAllByRole("rowgroup")[1]).getAllByRole("row");
    expect(liam).toHaveTextContent("Working");
    for (const text of ["1h 04m", "1.9M", "1k", "$0.60"]) expect(within(liam).getByText(text)).toBeInTheDocument();
    const share = within(liam).getByRole("img", { name: "49% of the cost" });
    expect(share.firstElementChild).toHaveStyle({ width: "49%" });
    expect(screen.getByRole("img", { name: "19% of the cost" })).toBeInTheDocument();

    const footer = screen.getAllByRole("rowgroup")[2];
    const total = within(footer).getByRole("row");
    expect(within(total).getByRole("rowheader")).toHaveTextContent("Total");
    for (const text of ["1h 16m", "2.3M", "6k", "5k", "$1.23"])
      expect(within(total).getByText(text)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Agent" }));
    expect(screen.getAllByRole("row").at(-1)).toBe(total);
  });

  it("refetches at most once per interval on usage and participant events", async () => {
    await renderStats();
    const statsCalls = () => api.callsTo("GET", "/api/swarms/3/stats").length;
    const before = statsCalls();
    vi.useFakeTimers();
    act(() => {
      source().emit(usageUpdated);
      source().emit(usageUpdated);
      source().emit({
        ...usageUpdated,
        type: "post.created",
        payload: { post: { id: 1, swarmId: 3, author: "Ava", title: "t", text: "x", commentCount: 0, createdAt: 0 } },
      });
    });
    act(() => vi.advanceTimersByTime(STATS_REFRESH_MS - 1));
    expect(statsCalls()).toBe(before);
    act(() => vi.advanceTimersByTime(1));
    expect(statsCalls()).toBe(before + 1);
  });
});
