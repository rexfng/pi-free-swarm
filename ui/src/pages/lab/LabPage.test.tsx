import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { LabPage } from "./LabPage";

const sampleSnapshot = {
  coordination: {
    now: 1000,
    complete: false,
    agents: [],
    tasks: [],
    claims: [],
    messages: [],
    activities: [],
    fileHistory: [],
    metrics: {
      completedTasks: 1,
      totalTasks: 3,
      coordinationOverheadRatio: 0.25,
      completedTasksPerMinute: 0.5,
      fileConflicts: 2,
      taskRetries: 1,
      toolFailures: 3,
      byAgent: [],
    },
  },
  budget: {
    frozen: false,
    scopes: [],
    models: [],
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    failures: 0,
    retries: 0,
    unknownUsage: 0,
  },
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("renders operational progress and distinguishes uncaptured external model costs", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => sampleSnapshot,
    }),
  );
  render(
    <MemoryRouter>
      <LabPage />
    </MemoryRouter>,
  );
  expect(await screen.findByText("25.0%")).toBeInTheDocument();
  expect(screen.getByText("Tasks complete").parentElement).toHaveTextContent("1 / 3");
  expect(screen.getByText(/External clients' model bills are not captured/)).toBeInTheDocument();
  expect(screen.getByText(/No budgets configured: gateway requests are blocked/)).toBeInTheDocument();
});

it("shows a meaningful connection error instead of a healthy empty dashboard", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503 }));
  render(
    <MemoryRouter>
      <LabPage />
    </MemoryRouter>,
  );
  expect(await screen.findByRole("alert")).toHaveTextContent("Status 503");
});

it("labels a recorded run, links to the ray tracer and stops polling", async () => {
  vi.useFakeTimers();
  const fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      ...sampleSnapshot,
      preview: { recordedAt: "2026-10-21T23:00:00.000Z", description: "Saved three-agent experiment." },
    }),
  });
  vi.stubGlobal("fetch", fetch);
  render(
    <MemoryRouter>
      <LabPage />
    </MemoryRouter>,
  );
  await act(async () => {});
  expect(screen.getByRole("region", { name: "Recorded experiment" })).toHaveTextContent(
    "does not poll for updates or provide live agent control",
  );
  expect(screen.getByRole("link", { name: /Open ray tracer/ })).toHaveAttribute("href", "/raytracer/");
  expect(screen.queryByRole("link", { name: "Pi board" })).not.toBeInTheDocument();
  await act(async () => {
    vi.advanceTimersByTime(3000);
  });
  expect(fetch).toHaveBeenCalledTimes(1);
});
