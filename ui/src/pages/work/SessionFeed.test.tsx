import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionFeed } from "./SessionFeed";
import { FakeIntersectionObserver, fakeStream, mockSessionServer, sessionAppended } from "./testSession";

const BLOCK_HEIGHT = 100;

const entries = () => screen.getAllByText(/^Entry \d+$/).map((element) => element.textContent);

/** jsdom has no layout: give the feed a scroll position and a height of BLOCK_HEIGHT per block. */
function scrollableFeed() {
  const feed = screen.getByRole("feed");
  let top = 0;
  Object.defineProperty(feed, "scrollTop", {
    get: () => top,
    set: (value: number) => (top = value),
    configurable: true,
  });
  Object.defineProperty(feed, "scrollHeight", { get: () => feed.querySelectorAll("article").length * BLOCK_HEIGHT });
  for (const article of feed.querySelectorAll("article")) {
    vi.spyOn(article, "getBoundingClientRect").mockImplementation(() => {
      const index = [...feed.querySelectorAll("article")].indexOf(article);
      return new DOMRect(0, index * BLOCK_HEIGHT - top, 100, BLOCK_HEIGHT);
    });
  }
  return {
    get top() {
      return top;
    },
    scrollTo(value: number) {
      top = value;
      fireEvent.scroll(feed);
    },
  };
}

beforeEach(() => {
  FakeIntersectionObserver.instances = [];
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("SessionFeed", () => {
  it("drains bursts larger than 120 entries, including after reconnect", async () => {
    const server = mockSessionServer(10);
    const stream = fakeStream();
    const view = render(<SessionFeed swarmId="3" agent="John" stream={stream} />);
    await screen.findByText("Entry 9");
    server.append(135);
    act(() => stream.emit(sessionAppended("John")));
    await screen.findByText("Entry 144");
    await waitFor(() => expect(server.requests.at(-1)?.get("after")).toBe("144"));
    expect(entries()).toHaveLength(145);
    server.append(125);
    view.rerender(<SessionFeed swarmId="3" agent="John" stream={{ ...stream, openCount: 2 }} />);
    await screen.findByText("Entry 269");
    expect(entries()).toEqual(Array.from({ length: 270 }, (_, index) => `Entry ${269 - index}`));
  });

  it("coalesces events during an in-flight burst and stops on a stationary cursor", async () => {
    const server = mockSessionServer(10);
    const stream = fakeStream();
    render(<SessionFeed swarmId="3" agent="John" stream={stream} />);
    await screen.findByText("Entry 9");
    const release = server.hold();
    server.append(70);
    act(() => stream.emit(sessionAppended("John")));
    server.append(70);
    act(() => stream.emit(sessionAppended("John")));
    release();
    await screen.findByText("Entry 149");
    await waitFor(() => expect(server.requests).toHaveLength(5));
    expect(server.requests.map((query) => query.get("after"))).toEqual([null, "9", "59", "109", "149"]);
    expect(new Set(entries()).size).toBe(150);
  });

  it("ignores a catch-up response after switching agents", async () => {
    const server = mockSessionServer(10);
    const stream = fakeStream();
    const view = render(<SessionFeed swarmId="3" agent="John" stream={stream} />);
    await screen.findByText("Entry 9");
    const release = server.hold();
    server.append(130);
    act(() => stream.emit(sessionAppended("John")));
    view.rerender(<SessionFeed swarmId="3" agent="Maria" stream={stream} />);
    const signal = server.fetch.mock.calls[1]?.[1]?.signal;
    expect(signal?.aborted).toBe(true);
    release();
    await screen.findByText("Entry 139");
    expect(entries()).toHaveLength(50);
  });
  it("shows the newest page first and appends older pages without duplicates", async () => {
    const server = mockSessionServer(120, { overlap: true });
    render(<SessionFeed swarmId="3" agent="John" stream={fakeStream()} />);
    await screen.findByText("Entry 119");
    expect(entries()).toHaveLength(50);
    expect(entries()[0]).toBe("Entry 119");

    const release = server.hold();
    act(() => FakeIntersectionObserver.intersect());
    expect(screen.getByLabelText("Loading")).toBeInTheDocument();
    release();
    await screen.findByText("Entry 20");
    expect(screen.queryByLabelText("Loading")).toBeNull();
    expect(entries()).toHaveLength(100);
    expect(new Set(entries()).size).toBe(100);

    act(() => FakeIntersectionObserver.intersect());
    await screen.findByText("Entry 0");
    expect(entries()).toHaveLength(120);
    expect(entries()).toEqual(Array.from({ length: 120 }, (_, index) => `Entry ${119 - index}`));
    expect(server.requests.map((query) => query.get("before"))).toEqual([null, "70", "20"]);
    // The oldest page is in: nothing is left to observe.
    act(() => FakeIntersectionObserver.intersect());
    expect(server.requests).toHaveLength(3);
  });

  it("loads older entries at the bottom without moving the view", async () => {
    mockSessionServer(120);
    render(<SessionFeed swarmId="3" agent="John" stream={fakeStream()} />);
    await screen.findByText("Entry 119");
    const feed = scrollableFeed();
    feed.scrollTo(500);
    act(() => FakeIntersectionObserver.intersect());
    await screen.findByText("Entry 20");
    expect(feed.top).toBe(500);
    expect(entries()[0]).toBe("Entry 119");
    expect(entries().at(-1)).toBe("Entry 20");
  });

  it("anchors live prepends independently of concurrent older pages", async () => {
    const server = mockSessionServer(120);
    const stream = fakeStream();
    render(<SessionFeed swarmId="3" agent="John" stream={stream} />);
    await screen.findByText("Entry 119");
    const feed = scrollableFeed();
    feed.scrollTo(500);
    const release = server.hold();
    server.append(3);
    act(() => {
      stream.emit(sessionAppended("John"));
      FakeIntersectionObserver.intersect();
    });
    release();
    await screen.findByText("Entry 122");
    await screen.findByText("Entry 20");
    expect(feed.top).toBe(500 + 3 * BLOCK_HEIGHT);
    expect(entries()[0]).toBe("Entry 122");
    expect(entries().at(-1)).toBe("Entry 20");
    expect(new Set(entries()).size).toBe(103);
  });

  it("puts new entries in place while the user is at the top", async () => {
    const server = mockSessionServer(10);
    const stream = fakeStream();
    render(<SessionFeed swarmId="3" agent="John" stream={stream} />);
    await screen.findByText("Entry 9");
    const feed = scrollableFeed();
    feed.scrollTo(10);

    server.append(2);
    act(() => stream.emit(sessionAppended("Maria")));
    act(() => stream.emit(sessionAppended("John")));
    await screen.findByText("Entry 11");
    expect(entries().slice(0, 3)).toEqual(["Entry 11", "Entry 10", "Entry 9"]);
    expect(feed.top).toBe(0);
    expect(server.requests.map((query) => query.get("after"))).toEqual([null, "9", "11"]);
    expect(screen.queryByRole("button", { name: /new/ })).toBeNull();
  });

  it("keeps the scroll position and offers an 'N new' pill while scrolled down", async () => {
    const server = mockSessionServer(10);
    const stream = fakeStream();
    render(<SessionFeed swarmId="3" agent="John" stream={stream} />);
    await screen.findByText("Entry 9");
    const feed = scrollableFeed();
    feed.scrollTo(500);

    server.append(3);
    act(() => stream.emit(sessionAppended("John")));
    const pill = await screen.findByRole("button", { name: "3 new" });
    expect(entries()[0]).toBe("Entry 12");
    expect(feed.top).toBe(500 + 3 * BLOCK_HEIGHT);

    await userEvent.click(pill);
    expect(feed.top).toBe(0);
    expect(screen.queryByRole("button", { name: /new/ })).toBeNull();
  });

  it("clears the pill once the user scrolls back to the top", async () => {
    const server = mockSessionServer(10);
    const stream = fakeStream();
    render(<SessionFeed swarmId="3" agent="John" stream={stream} />);
    await screen.findByText("Entry 9");
    const feed = scrollableFeed();
    feed.scrollTo(500);
    server.append(1);
    act(() => stream.emit(sessionAppended("John")));
    await screen.findByRole("button", { name: "1 new" });
    feed.scrollTo(0);
    expect(screen.queryByRole("button", { name: /new/ })).toBeNull();
  });

  it("shows the empty state until the first entry arrives", async () => {
    const server = mockSessionServer(0);
    const stream = fakeStream();
    render(<SessionFeed swarmId="3" agent="John" stream={stream} />);
    await screen.findByText("No session entries yet");
    server.append(1);
    act(() => stream.emit(sessionAppended("John")));
    await screen.findByText("Entry 0");
    expect(server.requests.map((query) => query.get("after"))).toEqual([null, null, "0"]);
  });

  it("offers a retry when the first page fails", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response('{"error":"internal","message":"Disk on fire"}', {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }),
    );
    render(<SessionFeed swarmId="3" agent="John" stream={fakeStream()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load the session: Disk on fire");
    fetch.mockRestore();
    mockSessionServer(1);
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByText("Entry 0")).toBeInTheDocument());
  });
});
