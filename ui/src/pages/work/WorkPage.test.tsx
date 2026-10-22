import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Outlet, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acceptance } from "../../test/acceptanceFixture";
import type { AgentParticipantView, SwarmDetailResponse, SwarmEvent } from "../../../../src/api-types";
import { SwarmStreamProvider } from "../../api/SwarmStream";
import { installFakeApi } from "../../test/fakeApi";
import { installFakeEventSource, type FakeEventSource } from "../../test/fakeEventSource";
import { FakeIntersectionObserver } from "./testSession";
import { WorkPage } from "./WorkPage";

const agent = (name: string, patch: Partial<AgentParticipantView> = {}): AgentParticipantView => ({
  kind: "agent",
  name,
  status: "working",
  launchOrder: 1,
  reviveCount: 0,
  activity: null,
  unread: 0,
  cost: 0,
  joinedAt: 0,
  lastActivityAt: 0,
  ...patch,
});

const detail: SwarmDetailResponse = {
  acceptance,
  bodyMaxChars: 200,
  swarm: {
    id: 3,
    name: "auth-refactor",
    taskPrompt: "Implement OAuth",
    status: "running",
    acceptsMessages: true,
    agentAmount: 2,
    agentsWorking: 2,
    runCount: 2,
    runnerPid: 1,
    createdAt: 0,
    startedAt: 0,
    finishedAt: null,
  },
  participants: [
    { kind: "user", name: "User", unread: 1, joinedAt: 0, lastActivityAt: 0 },
    agent("John", { activity: { kind: "tool", toolName: "bash" }, cost: 1.23 }),
    agent("Maria", { launchOrder: 2, activity: { kind: "thinking" }, cost: 0.5 }),
  ],
};

const participantUpdated = (participant: AgentParticipantView): SwarmEvent => ({
  id: 1,
  swarmId: 3,
  createdAt: 0,
  type: "participant.updated",
  payload: { participant },
});

const usageUpdated = (name: string, cost: number): SwarmEvent => ({
  id: 2,
  swarmId: 3,
  createdAt: 0,
  type: "usage.updated",
  payload: { agent: name, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost, turns: 1 } },
});

let source: () => FakeEventSource;

beforeEach(() => {
  source = installFakeEventSource();
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  const api = installFakeApi();
  api.on("GET", "/api/swarms/3", () => detail);
  for (const name of ["John", "Maria"]) {
    api.on("GET", `/api/swarms/3/agents/${name}/session`, () => ({
      agent: name,
      items: [{ kind: "user", id: "e0:0", timestamp: 0, text: `Hello ${name}` }],
      olderCursor: null,
      newestCursor: "0",
    }));
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function renderWork(path = "/s/3/work") {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="/s/:id"
          element={
            <SwarmStreamProvider swarmId="3">
              <Outlet />
            </SwarmStreamProvider>
          }
        >
          <Route path="work/:name?" element={<WorkPage />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
  act(() => source().open());
}

describe("WorkPage", () => {
  it("opens a deep-linked agent rather than the first agent", async () => {
    renderWork("/s/3/work/maria");
    expect(await screen.findByText("Hello Maria")).toBeInTheDocument();
    expect(screen.getByRole("feed", { name: "Session of Maria" })).toBeInTheDocument();
    expect(screen.queryByText("Hello John")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open work: Maria" })).not.toBeInTheDocument();
  });

  it("lists agents with activity and cost, and opens the first agent's session", async () => {
    renderWork();
    expect(await screen.findByRole("feed", { name: "Session of John" })).toBeInTheDocument();
    expect(screen.getByText("working")).toBeInTheDocument();
    expect(screen.queryByText(/Session · run/)).not.toBeInTheDocument();
    expect(await screen.findByText("Hello John")).toBeInTheDocument();
    const rows = screen.getAllByRole("button", { name: /John|Maria/ }).filter((row) => row.hasAttribute("data-row"));
    expect(rows).toHaveLength(2);
    expect(screen.queryByText("User")).toBeNull();
    expect(rows[0].parentElement).toHaveTextContent("running bash…");
    expect(rows[1].parentElement).toHaveTextContent("thinking…");
    expect(screen.getByText("$1.23")).toBeInTheDocument();
  });

  it("follows participant and usage events", async () => {
    renderWork();
    await screen.findByText("Hello John");
    act(() => {
      source().emit(participantUpdated(agent("Maria", { launchOrder: 2, status: "idle" })));
      source().emit(usageUpdated("John", 2.5));
    });
    expect(screen.getByText("idle")).toBeInTheDocument();
    expect(screen.getByText("$2.50")).toBeInTheDocument();
  });

  it("switches the session when another agent is selected", async () => {
    renderWork();
    await screen.findByText("Hello John");
    await userEvent.click(screen.getByText("Maria"));
    expect(await screen.findByText("Hello Maria")).toBeInTheDocument();
    expect(screen.queryByText("Hello John")).toBeNull();
    expect(screen.getByRole("feed", { name: "Session of Maria" })).toBeInTheDocument();
  });
});
