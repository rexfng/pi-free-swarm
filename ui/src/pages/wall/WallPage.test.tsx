import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommentView, PostSummary, SwarmEvent } from "../../../../src/api-types";
import { SwarmStreamProvider } from "../../api/SwarmStream";
import { installFakeApi, type FakeApi } from "../../test/fakeApi";
import { installFakeEventSource, type FakeEventSource } from "../../test/fakeEventSource";
import { detail, eventBase } from "../agents/testFixtures";
import { WallPage } from "./WallPage";

const AT = new Date().setHours(10, 24, 0, 0);
const post = (id: number, author: string, title: string, commentCount: number): PostSummary => ({
  id,
  swarmId: 3,
  author,
  title,
  text: `Body of ${title}, see docs/prd.md`,
  commentCount,
  createdAt: AT - id * 60_000,
});
const comment = (id: number, postId: number, author: string, text: string): CommentView => ({
  id,
  postId,
  swarmId: 3,
  author,
  text,
  createdAt: AT + id * 60_000,
});

const plan = post(1, "Oliver", "Plan: split OAuth work", 2);
const scopes = post(2, "Maria", "Scopes for v1", 0);
const planComments = [
  comment(10, 1, "John", "I'll take provider config."),
  comment(11, 1, "User", "Keep the UI small."),
];

/** Node's own experimental `localStorage` hides jsdom's in Vitest, so the tests bring their own. */
class MemoryStorage {
  private readonly items = new Map<string, string>();
  get length() {
    return this.items.size;
  }
  clear() {
    this.items.clear();
  }
  getItem(key: string) {
    return this.items.get(key) ?? null;
  }
  key(index: number) {
    return [...this.items.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.items.delete(key);
  }
  setItem(key: string, value: string) {
    this.items.set(key, value);
  }
}

let api: FakeApi;
let source: () => FakeEventSource;

beforeEach(() => {
  vi.stubGlobal("localStorage", new MemoryStorage());
  source = installFakeEventSource();
  api = installFakeApi();
  api.on("GET", "/api/swarms/3", () => detail());
  api.on("GET", "/api/swarms/3/posts", () => ({ posts: [plan, scopes], total: 2 }));
  api.on("GET", "/api/swarms/3/posts/1", () => ({ post: plan, comments: planComments }));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function renderWall(path = "/s/3/wall") {
  render(
    <MemoryRouter initialEntries={[path]}>
      <SwarmStreamProvider swarmId="3">
        <Routes>
          <Route path="/s/:id/wall/:postId?" element={<WallPage />} />
        </Routes>
      </SwarmStreamProvider>
    </MemoryRouter>,
  );
  act(() => source().open());
  await within(postList()).findByText("Scopes for v1");
}

const postList = () => screen.getByRole("region", { name: "Wall" });
const seen = () => JSON.parse(window.localStorage.getItem("pi-swarm:wall-seen:3") ?? "{}");
const emit = (event: SwarmEvent) => act(() => source().emit(event));

describe("WallPage", () => {
  it("uses the configured allowance for new posts and comments", async () => {
    api.on("GET", "/api/swarms/3", () => ({ ...detail(), bodyMaxChars: 8000 }));
    await renderWall("/s/3/wall/new");
    const user = userEvent.setup();
    const body = within(postList()).getByRole("textbox", { name: "Body" });
    await user.click(body);
    await user.paste("x".repeat(6400));
    expect(screen.getByText("6400/8000")).toBeInTheDocument();
    await user.click(within(postList()).getByText("Plan: split OAuth work"));
    const commentBox = await screen.findByRole("textbox", { name: "Write a comment…" });
    await user.click(commentBox);
    await user.paste("x".repeat(6400));
    expect(screen.getByText("6400/8000")).toBeInTheDocument();
  });
  it("lists posts with author, nonzero comment counts and unread badges from localStorage", async () => {
    window.localStorage.setItem("pi-swarm:wall-seen:3", JSON.stringify({ 1: 1 }));
    await renderWall();
    const list = postList();
    expect(within(list).getByText("Oliver").closest("[data-agent-row]")).toHaveTextContent("Oliver · 10:23 AM");
    expect(within(list).getByRole("button", { name: "Open work: Oliver" })).toBeInTheDocument();
    expect(within(list).getByTitle("2 comments")).toHaveTextContent("2");
    expect(within(list).getByText("1 new comments")).toBeInTheDocument();
    expect(within(list).queryByTitle("0 comments")).not.toBeInTheDocument();
    expect(screen.getByText("Select a post")).toBeInTheDocument();
    // A post seen for the first time counts as read.
    await waitFor(() => expect(seen()).toEqual({ 1: 1, 2: 0 }));
  });

  it("opens a post with its comments, marks the user's own and clears the badge", async () => {
    window.localStorage.setItem("pi-swarm:wall-seen:3", JSON.stringify({ 1: 0, 2: 0 }));
    await renderWall("/s/3/wall/1");
    expect(await screen.findByRole("heading", { level: 1, name: "Plan: split OAuth work" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Post" }).querySelector("header")).toHaveTextContent("Oliver · 10:23 AM");
    expect(screen.getByRole("heading", { level: 2, name: "2 comments" })).toBeInTheDocument();
    const own = screen.getByText("Keep the UI small.").closest("li");
    const other = screen.getByText("I'll take provider config.").closest("li");
    expect(own?.className).toMatch(/own/);
    expect(other?.className).not.toMatch(/own/);
    if (!own || !other) throw new Error("Expected both comments");
    expect(own.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(
      screen
        .getByRole("region", { name: "Post" })
        .compareDocumentPosition(screen.getByRole("region", { name: "Compose" })) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    await waitFor(() => expect(within(postList()).queryByText("2 new comments")).not.toBeInTheDocument());
    expect(seen()).toEqual({ 1: 2, 2: 0 });
    expect(screen.getByRole("textbox", { name: "Write a comment…" })).toBeEnabled();
  });

  it("posts a comment and shows it right away", async () => {
    const created = comment(12, 1, "User", "Signed state it is.");
    api.on("POST", "/api/swarms/3/posts/1/comments", () => ({ comment: created, commentCount: 3 }));
    await renderWall("/s/3/wall/1");
    const box = await screen.findByRole("textbox", { name: "Write a comment…" });
    await userEvent.type(box, "Signed state it is.");
    expect(screen.queryByText("19/200")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Comment" }));

    expect(await screen.findByText("Signed state it is.")).toBeInTheDocument();
    expect(screen.getByText("Signed state it is.").closest("ol")?.firstElementChild).toHaveTextContent(
      "Signed state it is.",
    );
    expect(box).toHaveValue("");
    expect(api.callsTo("POST", "/api/swarms/3/posts/1/comments")[0].body).toEqual({ text: "Signed state it is." });
    expect(screen.getByRole("heading", { level: 2, name: "3 comments" })).toBeInTheDocument();
    expect(within(postList()).getByTitle("3 comments")).toBeInTheDocument();
  });

  it("validates the new post form with counters and opens the created post", async () => {
    const created = post(3, "User", "Priorities", 0);
    api.on("POST", "/api/swarms/3/posts", () => ({ post: created }));
    api.on("GET", "/api/swarms/3/posts/3", () => ({ post: created, comments: [] }));
    await renderWall();
    await userEvent.click(screen.getByRole("button", { name: "New post" }));

    const title = screen.getByRole("textbox", { name: "Title" });
    const body = screen.getByRole("textbox", { name: "Body" });
    const submit = screen.getByRole("button", { name: "Post" });
    expect(screen.queryByText("0/60")).not.toBeInTheDocument();
    expect(within(postList()).getByRole("region", { name: "New post" })).toContainElement(body);
    await userEvent.type(title, "x".repeat(61));
    await userEvent.type(body, "Ship login first.");
    expect(screen.getByText("61/60")).toBeInTheDocument();
    expect(screen.queryByText("17/200")).not.toBeInTheDocument();
    expect(submit).toBeDisabled();

    await userEvent.clear(title);
    await userEvent.type(title, "Priorities");
    expect(submit).toBeEnabled();
    await userEvent.click(submit);
    expect(await screen.findByRole("heading", { level: 1, name: "Priorities" })).toBeInTheDocument();
    expect(api.callsTo("POST", "/api/swarms/3/posts")[0].body).toEqual({
      title: "Priorities",
      text: "Ship login first.",
    });
    expect(within(postList()).getByText("You").closest("[data-agent-row]")).toHaveTextContent("You · 10:21 AM");
  });

  it("applies new posts and comments from the stream", async () => {
    await renderWall("/s/3/wall/1");
    await screen.findByRole("heading", { level: 2, name: "2 comments" });

    emit({
      ...eventBase,
      type: "post.created",
      payload: { post: { ...post(4, "Ava", "Logout flow", 0), createdAt: AT + 60_000 } },
    });
    const titles = within(postList())
      .getAllByText(/Logout flow|Plan: split OAuth work|Scopes for v1/)
      .map((node) => node.textContent);
    expect(titles).toEqual(["Logout flow", "Plan: split OAuth work", "Scopes for v1"]);

    emit({
      ...eventBase,
      type: "comment.created",
      payload: { comment: comment(20, 2, "Liam", "Agreed."), commentCount: 1 },
    });
    expect(within(postList()).getByText("1 new comments")).toBeInTheDocument();

    const live = comment(21, 1, "Noah", "CI is green again.");
    emit({ ...eventBase, type: "comment.created", payload: { comment: live, commentCount: 3 } });
    expect(screen.getByText("CI is green again.")).toBeInTheDocument();
    expect(screen.getByText("CI is green again.").closest("ol")?.firstElementChild).toHaveTextContent(
      "CI is green again.",
    );
    expect(screen.getByRole("heading", { level: 2, name: "3 comments" })).toBeInTheDocument();
    await waitFor(() => expect(seen()[1]).toBe(3));
  });

  it("explains an unknown post", async () => {
    await renderWall("/s/3/wall/99");
    expect(await screen.findByText("Post not found")).toBeInTheDocument();
  });
});
