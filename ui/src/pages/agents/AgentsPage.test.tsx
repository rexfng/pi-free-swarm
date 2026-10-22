import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RecipientView, SwarmEvent } from "../../../../src/api-types";
import { SwarmStreamProvider } from "../../api/SwarmStream";
import { SWARM_NOT_RUNNING_NOTICE } from "../../components/compose/ComposeBox";
import { installFakeApi, jsonResponse, type FakeApi } from "../../test/fakeApi";
import { installFakeEventSource, type FakeEventSource } from "../../test/fakeEventSource";
import { AgentsPage } from "./AgentsPage";
import { agent, detail, eventBase, mailbox, mailboxThread, message, thread } from "./testFixtures";

const scopesThread = thread(2, ["User", "John", "Maria"]);
const kickoff = message(
  2,
  "User",
  [
    ["John", "read"],
    ["Maria", "read"],
  ],
  "Please sync on scopes",
);
const scopes = message(
  2,
  "Maria",
  [
    ["John", "read"],
    ["User", "delivered"],
  ],
  "Scopes are merged.\nSee config.",
);
const stateThread = thread(5, ["Emma", "John"]);
const stateQuestion = message(5, "Emma", [["John", "delivered"]], "Signed state or nonce?");
const sentThread = thread(7, ["John", "Maria"]);
const sent = message(7, "John", [["Maria", "read"]], "Pushed the fix");

let api: FakeApi;
let source: () => FakeEventSource;

function serve(patch: Parameters<typeof detail>[0] = {}) {
  api.on("GET", "/api/swarms/3", () => detail(patch));
  api.on("GET", "/api/swarms/3/participants/John/messages", ({ query }) =>
    query.get("box") === "sent"
      ? mailbox("John", "sent", [mailboxThread(sentThread, [sent], "John")])
      : mailbox("John", "inbox", [
          mailboxThread(scopesThread, [kickoff, scopes], "John"),
          mailboxThread(stateThread, [stateQuestion], "John"),
        ]),
  );
  api.on("GET", "/api/swarms/3/threads/2", () => ({ thread: scopesThread, messages: [kickoff, scopes] }));
  api.on("POST", "/api/swarms/3/participants/User/read", () => ({ updated: 1, unread: 0 }));
}

beforeEach(() => {
  source = installFakeEventSource();
  api = installFakeApi();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mount(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <SwarmStreamProvider swarmId="3">
        <Routes>
          <Route path="/s/:id/agents/:name?" element={<AgentsPage />} />
        </Routes>
      </SwarmStreamProvider>
    </MemoryRouter>,
  );
  act(() => source().open());
}

/** John's page once his inbox has loaded. */
async function renderAgents() {
  mount("/s/3/agents/John");
  await screen.findByText("Signed state or nonce?");
}

const participantList = () => screen.getByRole("region", { name: "Agents" });
const mailboxPanel = () => screen.getByRole("region", { name: "Mailbox" });
const textbox = () => screen.getByRole("textbox", { name: "Type a message…" });
const emit = (event: SwarmEvent) => act(() => source().emit(event));

async function expandScopes() {
  await userEvent.click(await within(mailboxPanel()).findByRole("button", { name: /Scopes are merged/ }));
  return screen.findByRole("list", { name: "Thread #2" });
}

describe("AgentsPage", () => {
  it("addresses and focuses a new message from a compose deep link", async () => {
    serve();
    mount("/s/3/agents/User?compose=maria");
    await waitFor(() => expect(screen.getByRole("button", { name: "Remove Maria" })).toBeInTheDocument());
    expect(textbox()).toHaveFocus();
    expect(screen.queryByRole("button", { name: "Remove John" })).not.toBeInTheDocument();
  });

  it("switches from a reply to a new message through a name action", async () => {
    serve();
    await renderAgents();
    await expandScopes();
    await userEvent.click(await screen.findByRole("button", { name: "Reply" }));
    await userEvent.type(textbox(), "Draft");
    await userEvent.click(within(participantList()).getByRole("button", { name: "Send message: Emma" }));
    await waitFor(() => expect(screen.queryByText("Replying in thread #2")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Remove Emma" })).toBeInTheDocument();
    expect(textbox()).toHaveValue("Draft");
    expect(textbox()).toHaveFocus();
    await userEvent.click(screen.getByRole("button", { name: "Remove Emma" }));
    await userEvent.click(within(participantList()).getByRole("button", { name: "Send message: Emma" }));
    expect(screen.getByRole("button", { name: "Remove Emma" })).toBeInTheDocument();
  });

  it("uses the server allowance for messages", async () => {
    serve();
    api.on("GET", "/api/swarms/3", () => ({ ...detail(), bodyMaxChars: 8000 }));
    mount("/s/3/agents/John");
    await screen.findByText("Signed state or nonce?");
    const user = userEvent.setup();
    await user.click(textbox());
    await user.paste("x".repeat(6400));
    expect(screen.getByText("6400/8000")).toBeInTheDocument();
  });
  it("keeps stable order for equal activity timestamps and shows unread badges", async () => {
    serve();
    await renderAgents();
    const list = participantList();
    const names = within(list)
      .getAllByText(/^(User|John|Maria|Emma)$/)
      .map((node) => node.textContent);
    expect(names).toEqual(["User", "John", "Maria", "Emma"]);
    expect(within(list).getByText("you")).toBeInTheDocument();
    expect(within(list).getByText("2 unread")).toBeInTheDocument();
    expect(within(list).getByText("9+")).toBeInTheDocument();
    expect(within(list).getByText("Crashed")).toBeInTheDocument();
    expect(within(list).queryByRole("button", { name: "Message User" })).not.toBeInTheDocument();
    expect(within(list).queryByRole("button", { name: /add agent/i })).not.toBeInTheDocument();
  });

  it("shows newest-first fallback messages before the full thread loads, then prepends live replies", async () => {
    serve();
    api.on("GET", "/api/swarms/3/threads/2", () => jsonResponse(500, { error: "internal", message: "Unavailable" }));
    await renderAgents();
    const messages = await expandScopes();
    expect(
      within(messages)
        .getAllByText(/Please sync on scopes|Scopes are merged/)
        .map((node) => node.textContent),
    ).toEqual(["Scopes are merged.\nSee config.", "Please sync on scopes"]);
    await screen.findByText("Unavailable");
    const reply = message(2, "Maria", [["John", "read"]], "Newest reply");
    emit({ ...eventBase, type: "message.created", payload: { message: reply, unread: {} } });
    expect(messages.firstElementChild).toHaveTextContent("Newest reply");
    expect(
      within(mailboxPanel())
        .getAllByRole("button")
        .filter((row) => row.hasAttribute("data-row"))[0],
    ).toHaveAccessibleName(/Newest reply/);
  });

  it("shows the inbox with the unread count and switches to sent", async () => {
    serve();
    await renderAgents();
    expect(screen.getByRole("radio", { name: "Inbox (2)" })).toBeChecked();

    await userEvent.click(screen.getByRole("radio", { name: "Sent" }));
    expect(await within(mailboxPanel()).findByText("Pushed the fix")).toBeInTheDocument();
    expect(within(mailboxPanel()).queryByText("Signed state or nonce?")).not.toBeInTheDocument();
    const sentCall = api.callsTo("GET", "/api/swarms/3/participants/John/messages").at(-1);
    expect(sentCall?.query.get("box")).toBe("sent");
  });

  it("expands the whole thread newest first with Reply above it and marks unread messages read", async () => {
    serve();
    await renderAgents();
    const messages = await expandScopes();
    await waitFor(() => expect(within(messages).getAllByRole("listitem").length).toBeGreaterThan(1));
    const texts = within(messages)
      .getAllByText(/Please sync on scopes|Scopes are merged/)
      .map((node) => node.textContent);
    expect(texts).toEqual(["Scopes are merged.\nSee config.", "Please sync on scopes"]);
    expect(
      screen.getByRole("button", { name: "Reply" }).compareDocumentPosition(messages) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      mailboxPanel().compareDocumentPosition(screen.getByRole("region", { name: "Compose" })) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    await waitFor(() => expect(api.callsTo("POST", "/api/swarms/3/participants/User/read")).toHaveLength(1));
    expect(api.callsTo("POST", "/api/swarms/3/participants/User/read")[0].body).toEqual({ messageIds: [scopes.id] });
    const newest = message(2, "Maria", [["John", "read"]], "Live reply");
    emit({ ...eventBase, type: "message.created", payload: { message: newest, unread: {} } });
    expect(messages.firstElementChild).toHaveTextContent("Live reply");
  });

  it("replies in thread mode and restores the selected agent afterwards", async () => {
    serve();
    api.on("POST", "/api/swarms/3/threads/2/reply", () => ({ message: scopes }));
    await renderAgents();
    await expandScopes();
    await userEvent.click(await screen.findByRole("button", { name: "Reply" }));

    expect(screen.getByText("Replying in thread #2")).toBeInTheDocument();
    expect(textbox()).toHaveFocus();
    expect(screen.queryByRole("button", { name: "Remove John" })).not.toBeInTheDocument();
    await userEvent.type(textbox(), "Thanks both");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(textbox()).toHaveValue(""));
    expect(api.callsTo("POST", "/api/swarms/3/threads/2/reply")[0].body).toEqual({ text: "Thanks both" });

    await userEvent.click(screen.getByRole("button", { name: "Cancel reply" }));
    expect(screen.queryByText("Replying in thread #2")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove John" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove Maria" })).not.toBeInTheDocument();
  });

  it("pre-fills To from the envelope button and sends a new thread", async () => {
    serve();
    api.on("POST", "/api/swarms/3/messages", () => ({ message: sent }));
    await renderAgents();
    await userEvent.click(within(participantList()).getByRole("button", { name: "Send message: Maria" }));
    expect(textbox()).toHaveFocus();
    expect(screen.queryByRole("button", { name: "Remove John" })).not.toBeInTheDocument();
    await userEvent.type(textbox(), "Status?");
    await userEvent.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(api.callsTo("POST", "/api/swarms/3/messages")).toHaveLength(1));
    expect(api.callsTo("POST", "/api/swarms/3/messages")[0].body).toEqual({ to: ["Maria"], text: "Status?" });
  });

  it("disables compose and Reply while the swarm does not accept messages", async () => {
    serve({ status: "finished", acceptsMessages: false });
    await renderAgents();
    expect(textbox()).toHaveAttribute("placeholder", SWARM_NOT_RUNNING_NOTICE);
    expect(textbox()).toBeDisabled();
    await expandScopes();
    expect(await screen.findByRole("button", { name: "Reply" })).toBeDisabled();
  });

  it("shows the not-running notice when the server answers 409", async () => {
    serve();
    api.on("POST", "/api/swarms/3/messages", () =>
      jsonResponse(409, { error: "swarm_not_running", message: "The swarm is not running." }),
    );
    await renderAgents();
    await userEvent.type(textbox(), "Anyone there?");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(textbox()).toHaveAttribute("placeholder", SWARM_NOT_RUNNING_NOTICE));
    expect(textbox()).toBeDisabled();
    expect(textbox()).toHaveValue("Anyone there?");
    expect(screen.queryByText(/Message not sent/)).not.toBeInTheDocument();
  });

  it("applies participant and message events without reloading known threads", async () => {
    serve();
    await renderAgents();
    const mailboxFetches = () => api.callsTo("GET", "/api/swarms/3/participants/John/messages").length;
    const before = mailboxFetches();

    emit({ ...eventBase, type: "participant.updated", payload: { participant: agent("Maria", 2) } });
    expect(within(participantList()).getAllByText("Working")).toHaveLength(2);

    const followUp = message(5, "Emma", [["John", "pending"]], "Any news on the state param?");
    emit({ ...eventBase, type: "message.created", payload: { message: followUp, unread: { John: 3 } } });
    expect(within(mailboxPanel()).getByText("Any news on the state param?")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Inbox (3)" })).toBeInTheDocument();
    expect(mailboxFetches()).toBe(before);

    const recipient: RecipientView = { name: "John", status: "read", deliveredAt: 1, readAt: 2 };
    emit({
      ...eventBase,
      type: "message.status",
      payload: { messageId: followUp.id, threadId: 5, recipient, unread: { John: 2 } },
    });
    expect(within(participantList()).getByText("2 unread")).toBeInTheDocument();

    const fresh = message(9, "Maria", [["John", "pending"]], "New topic");
    emit({ ...eventBase, type: "message.created", payload: { message: fresh, unread: { John: 3 } } });
    await waitFor(() => expect(mailboxFetches()).toBe(before + 1));
  });

  it("explains an unknown participant name", async () => {
    serve();
    mount("/s/3/agents/Nobody");
    expect(await screen.findByText("Participant not found")).toBeInTheDocument();
  });
});
