import { describe, expect, mock, test } from "bun:test";
import type { Effort } from "../src/effort";
import type { Answer, LookupService, Source } from "../src/parallel";
import { LookupSession, type Entry, type FollowUpTarget } from "../src/session";

function setup(initialEffort: Effort = "low") {
  const source: Source = {
    title: "Source",
    url: "https://example.org/source",
    excerpts: ["Original passage"],
  };
  let nextId = 0;
  const search = mock<LookupService["search"]>(async () => ({
    responseId: `response-${++nextId}`,
    text: "Answer.¹",
    sources: [source],
  }));
  const extract = mock<LookupService["extract"]>(async (selected) => ({
    ...selected,
    excerpts: ["Expanded passage"],
  }));
  const session = new LookupSession({ search, extract }, initialEffort);
  return { session, search, extract, source };
}

function targetFor(entry: Entry): FollowUpTarget {
  return {
    responseId: entry.responseId!,
    term: entry.term,
    context: entry.context,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

// Deliberately ignore AbortSignal to exercise the session's generation guards.
function startPending(
  fixture: ReturnType<typeof setup>,
  operation: "search" | "extract",
) {
  const { session, search, extract } = fixture;
  const pending = deferred<Source>();
  let task: Promise<void>;
  let signal: AbortSignal;
  if (operation === "search") {
    search.mockReturnValueOnce(
      pending.promise.then((source) => ({
        responseId: "late-response",
        text: "Late answer.¹",
        sources: [source],
      })),
    );
    task = session.search("pending question", "ignored context");
    signal = search.mock.calls.at(-1)![2]!;
  } else {
    extract.mockReturnValueOnce(pending.promise);
    task = session.toggleCitation(0);
    signal = extract.mock.calls.at(-1)![3]!;
  }
  expect(signal.aborted).toBe(false);
  return { ...pending, task, signal };
}

describe("LookupSession follow-ups", () => {
  test("chains native turns only when explicitly advancing the current answer", async () => {
    const { session, search, extract } = setup("medium");
    expect(session.state.followUp).toBeNull();
    const idle = session.state;
    expect(session.startFollowUp()).toBe(false);
    expect(session.state).toBe(idle);
    expect(search).not.toHaveBeenCalled();

    await session.search(" root question ", " root context ");
    expect(search).toHaveBeenLastCalledWith(
      "root question",
      "root context",
      expect.any(AbortSignal),
      "medium",
    );
    expect(session.state.followUp).toBeNull();
    expect(session.state.entry).not.toHaveProperty("previousResponseId");
    expect(session.state.entry).not.toHaveProperty("followUpTo");
    await session.toggleCitation(0);
    await session.search("");
    const root = session.state.entry!;
    expect(session.state.openCitation).toBe(0);
    expect(session.state.error).not.toBeNull();

    expect(session.startFollowUp()).toBe(true);
    const anchor = session.state.followUp;
    expect(anchor).toEqual(targetFor(root));
    expect(session.state).toMatchObject({
      entry: root,
      error: null,
      errorKind: null,
      openCitation: null,
    });
    expect(session.state.entry).toBe(root);
    expect(search).toHaveBeenCalledTimes(1);
    expect(extract).toHaveBeenCalledTimes(1);

    await session.search(" \x1b[31mWhy?\x1b[0m ", "ignored context");
    const child = session.state.entry!;
    expect(search).toHaveBeenLastCalledWith(
      "Why?",
      "root context",
      expect.any(AbortSignal),
      "medium",
      root.responseId,
    );
    expect(child).toMatchObject({
      responseId: "response-2",
      previousResponseId: root.responseId,
      followUpTo: root.term,
      context: root.context,
      effort: "medium",
    });
    expect(session.state.followUp).toBe(anchor);
    await session.search("Why?", "another ignored context");
    expect(session.state.entry).toBe(child);
    expect(search).toHaveBeenCalledTimes(2);
    expect(session.state.followUp).toBe(anchor);

    expect(session.startFollowUp()).toBe(true);
    expect(session.state.followUp).toEqual(targetFor(child));
    await session.search("What else?");
    expect(search).toHaveBeenLastCalledWith(
      "What else?",
      "root context",
      expect.any(AbortSignal),
      "medium",
      child.responseId,
    );
    expect(session.state.entry).toMatchObject({
      responseId: "response-3",
      previousResponseId: child.responseId,
      followUpTo: "Why?",
    });
    expect(session.state.followUp).toEqual(targetFor(child));
    expect(extract).toHaveBeenCalledTimes(1);
  });

  test("failed retries and successful branch edits keep the submitted question's parent", async () => {
    const { session, search, extract } = setup();
    await session.search("root", "context");
    const root = session.state.entry!;
    session.startFollowUp();
    const anchor = session.state.followUp;
    search.mockRejectedValueOnce(new Error("Follow-up unavailable"));
    await session.search("question");
    expect(session.state.entry).toBe(root);
    expect(session.state.followUp).toBe(anchor);
    expect(session.state.errorKind).toBe("search");
    expect(search).toHaveBeenCalledTimes(2);
    expect(extract).not.toHaveBeenCalled();

    await session.search("question");
    const child = session.state.entry!;
    expect(session.state.error).toBeNull();
    expect(search).toHaveBeenLastCalledWith(
      "question",
      "context",
      expect.any(AbortSignal),
      "low",
      root.responseId,
    );
    await session.search("edited question", "ignored");
    expect(search).toHaveBeenLastCalledWith(
      "edited question",
      "context",
      expect.any(AbortSignal),
      "low",
      root.responseId,
    );
    expect(session.state.followUp).toBe(anchor);
    expect(session.state.entry?.followUpTo).toBe("root");
    expect(search).toHaveBeenCalledTimes(4);
    expect(session.back()).toBe(child);
    expect(session.state.followUp).toEqual(targetFor(root));
    expect(session.back()).toBe(root);
    expect(session.state.followUp).toBeNull();
    expect(session.back()).toBeNull();
  });

  test("isolates root, different threads and repeated turns, including extracted passages", async () => {
    const { session, search, extract, source } = setup();
    await session.search("same question", "context");
    extract.mockResolvedValueOnce({ ...source, excerpts: ["Root passage"] });
    await session.readSelected();
    const root = session.state.entry!;
    session.startFollowUp();
    await session.search("same question");
    expect(session.state.entry?.expanded).toEqual([]);
    extract.mockResolvedValueOnce({ ...source, excerpts: ["Child passage"] });
    await session.readSelected();
    const child = session.state.entry!;
    session.startFollowUp();
    await session.search("same question");
    const grandchild = session.state.entry!;
    expect(grandchild.expanded).toEqual([]);

    session.startNewLookup();
    await session.search("other root", "context");
    session.startFollowUp();
    await session.search("same question");
    expect(session.state.entry?.expanded).toEqual([]);
    extract.mockResolvedValueOnce({ ...source, excerpts: ["Other thread"] });
    await session.readSelected();
    const otherChild = session.state.entry!;
    expect(search).toHaveBeenCalledTimes(5);
    expect(extract).toHaveBeenCalledTimes(3);

    session.startNewLookup();
    await session.search("same question", "context");
    expect(session.state.entry).toBe(root);
    await session.readSelected();
    session.startFollowUp();
    await session.search("same question");
    expect(session.state.entry).toBe(child);
    await session.readSelected();
    session.startFollowUp();
    await session.search("same question");
    expect(session.state.entry).toBe(grandchild);
    session.startNewLookup();
    await session.search("other root", "context");
    session.startFollowUp();
    await session.search("same question");
    expect(session.state.entry).toBe(otherChild);
    await session.readSelected();
    expect(search).toHaveBeenCalledTimes(5);
    expect(extract).toHaveBeenCalledTimes(3);
  });

  test("back uses the latest expanded cache entry for the correct parent ID", async () => {
    const { session, search, extract } = setup();
    await session.search("question", "context");
    const root = session.state.entry!;
    session.startFollowUp();
    await session.search("question");
    const originalChild = session.state.entry!;
    session.startFollowUp();
    await session.search("question");
    const grandchild = session.state.entry!;
    session.startNewLookup();
    await session.search("question", "context");
    session.startFollowUp();
    await session.search("question");
    await session.readSelected();
    const expandedChild = session.state.entry!;
    expect(expandedChild).not.toBe(originalChild);
    session.startFollowUp();
    await session.search("question");

    expect(session.back()).toBe(expandedChild);
    expect(session.state.followUp).toEqual(targetFor(root));
    expect(session.back()).toBe(root);
    expect(session.state.followUp).toBeNull();
    expect(session.back()).toBe(grandchild);
    expect(session.state.followUp).toEqual(targetFor(originalChild));
    expect(session.back()).toBe(expandedChild);
    expect(session.state.followUp).toEqual(targetFor(root));
    expect(session.back()).toBe(root);
    expect(session.back()).toBeNull();
    expect(search).toHaveBeenCalledTimes(3);
    expect(extract).toHaveBeenCalledTimes(1);
  });

  test("back(true) closes drafts without consuming history and restores effort and parent", async () => {
    const { session, search } = setup();
    await session.search("root", "context");
    const root = session.state.entry!;
    session.startFollowUp();
    session.setEffort("high");
    await session.search("child");
    const child = session.state.entry!;
    session.startFollowUp();
    expect(session.state.followUp).toEqual(targetFor(child));
    expect(session.back(true)).toBe(child);
    expect(session.state.effort).toBe("high");
    expect(session.state.followUp).toEqual(targetFor(root));

    session.startFollowUp();
    session.setEffort("medium");
    expect(session.state.entry).toBeNull();
    expect(session.back(true)).toBe(child);
    expect(session.state.effort).toBe("high");
    expect(session.state.followUp).toEqual(targetFor(root));
    expect(session.back()).toBe(root);
    expect(session.state.effort).toBe("low");
    expect(session.state.followUp).toBeNull();
    session.startFollowUp();
    expect(session.back(true)).toBe(root);
    expect(session.state.followUp).toBeNull();
    expect(session.back()).toBeNull();
    expect(search).toHaveBeenCalledTimes(2);
  });

  test("effort changes retain the anchor after clearing the entry and separate follow-up caches", async () => {
    const { session, search } = setup("medium");
    await session.search("root", "context");
    const root = session.state.entry!;
    session.startFollowUp();
    const anchor = session.state.followUp;
    expect(session.setEffort("high")).toBe(true);
    expect(session.state.entry).toBeNull();
    expect(session.state.followUp).toBe(anchor);
    expect(session.startFollowUp()).toBe(false);
    expect(session.state.followUp).toBe(anchor);
    expect(search).toHaveBeenCalledTimes(1);
    await session.search("question", "ignored");
    const high = session.state.entry!;
    expect(search).toHaveBeenLastCalledWith(
      "question",
      "context",
      expect.any(AbortSignal),
      "high",
      root.responseId,
    );
    session.setEffort("low");
    expect(session.state.followUp).toBe(anchor);
    await session.search("question");
    expect(session.state.cached).toBe(false);
    expect(session.state.entry?.previousResponseId).toBe(root.responseId!);
    session.setEffort("high");
    await session.search("question");
    expect(session.state.entry).toBe(high);
    expect(session.state.cached).toBe(true);
    expect(session.state.followUp).toBe(anchor);
    expect(search).toHaveBeenCalledTimes(3);
  });

  test.each([
    "missing ID",
    "empty ID",
    "blank ID",
    "empty text",
    "blank text",
    "no sources",
  ])("follow-up is unavailable with %s", async (reason) => {
    const { session, search, extract, source } = setup();
    const answer: Answer = {
      text:
        reason === "empty text"
          ? ""
          : reason === "blank text"
            ? " \n "
            : "Answer.¹",
      sources: reason === "no sources" ? [] : [source],
      ...(reason === "missing ID"
        ? {}
        : {
            responseId:
              reason === "empty ID" ? "" : reason === "blank ID" ? " " : "id",
          }),
    };
    search.mockResolvedValueOnce(answer);
    await session.search("root");
    const state = session.state;
    const listener = mock(() => {});
    session.subscribe(listener);
    expect(session.startFollowUp()).toBe(false);
    expect(session.state).toBe(state);
    expect(listener).not.toHaveBeenCalled();
    expect(search).toHaveBeenCalledTimes(1);
    expect(extract).not.toHaveBeenCalled();
  });

  test.each(["search", "extract"] as const)(
    "cannot advance the parent while %s is pending",
    async (operation) => {
      const fixture = setup();
      const { session, source } = fixture;
      await session.search("root", "context");
      session.startFollowUp();
      const anchor = session.state.followUp;
      const pending = startPending(fixture, operation);
      const state = session.state;
      const listener = mock(() => {});
      session.subscribe(listener);
      expect(session.startFollowUp()).toBe(false);
      expect(session.state).toBe(state);
      expect(session.state.followUp).toBe(anchor);
      expect(listener).not.toHaveBeenCalled();
      expect(pending.signal.aborted).toBe(false);
      pending.resolve(source);
      await pending.task;
      expect(session.state.followUp).toBe(anchor);
    },
  );

  test("starting a new lookup clears draft linkage and errors but retains the answer for history", async () => {
    const { session, search, extract } = setup();
    await session.search("root", "context");
    const root = session.state.entry!;
    session.startFollowUp();
    await session.search("child");
    session.startFollowUp();
    await session.toggleCitation(0);
    await session.search("");
    const child = session.state.entry!;
    expect(session.state.error).not.toBeNull();
    expect(session.state.openCitation).toBe(0);
    session.startNewLookup();
    expect(session.state.entry).toBe(child);
    expect(session.state).toMatchObject({
      followUp: null,
      error: null,
      errorKind: null,
      openCitation: null,
      busy: null,
    });
    expect(search).toHaveBeenCalledTimes(2);
    expect(extract).toHaveBeenCalledTimes(1);
    await session.search("new root", "new context");
    expect(search).toHaveBeenLastCalledWith(
      "new root",
      "new context",
      expect.any(AbortSignal),
      "low",
    );
    expect(session.state.entry).not.toHaveProperty("previousResponseId");
    expect(session.state.entry).not.toHaveProperty("followUpTo");
    expect(session.back()).toBe(child);
    expect(session.state.followUp).toEqual(targetFor(root));
    expect(session.back()).toBe(root);
    expect(session.state.followUp).toBeNull();
    expect(session.back()).toBeNull();
  });

  for (const action of ["new lookup", "back", "effort change"] as const) {
    test.each([
      ["search", "resolve"],
      ["search", "reject"],
      ["extract", "resolve"],
      ["extract", "reject"],
    ] as const)(
      `${action} cancels follow-up %s and ignores late %s without fallback`,
      async (operation, outcome) => {
        const fixture = setup();
        const { session, search, extract, source } = fixture;
        await session.search("root", "context");
        const root = session.state.entry!;
        session.startFollowUp();
        await session.search("child");
        const child = session.state.entry!;
        session.startFollowUp();
        const anchor = session.state.followUp;
        const pending = startPending(fixture, operation);
        const searchCalls = search.mock.calls.length;
        const extractCalls = extract.mock.calls.length;
        if (action === "new lookup") session.startNewLookup();
        else if (action === "back") expect(session.back(true)).toBe(child);
        else session.setEffort("high");
        expect(pending.signal.aborted).toBe(true);
        expect(session.state.busy).toBeNull();
        expect(session.state.error).toBeNull();
        expect(session.state.openCitation).toBeNull();
        if (action === "new lookup") {
          expect(session.state.entry).toBe(child);
          expect(session.state.followUp).toBeNull();
        } else if (action === "back") {
          expect(session.state.followUp).toEqual(targetFor(root));
        } else {
          expect(session.state.entry).toBeNull();
          expect(session.state.followUp).toBe(anchor);
        }
        expect(search).toHaveBeenCalledTimes(searchCalls);
        expect(extract).toHaveBeenCalledTimes(extractCalls);

        const current = deferred<Answer>();
        search.mockReturnValueOnce(current.promise);
        const task = session.search("current", "new context");
        const parentId =
          action === "new lookup"
            ? undefined
            : action === "back"
              ? root.responseId
              : child.responseId;
        expect(search).toHaveBeenLastCalledWith(
          "current",
          parentId ? "context" : "new context",
          expect.any(AbortSignal),
          action === "effort change" ? "high" : "low",
          ...(parentId ? [parentId] : []),
        );
        const state = session.state;
        if (outcome === "resolve")
          pending.resolve({ ...source, excerpts: ["Late passage"] });
        else pending.reject(new Error("Late failure"));
        await pending.task;
        expect(session.state).toBe(state);
        expect(session.state.busy).toBe("search");
        current.resolve({
          responseId: "current-response",
          text: "Current answer.¹",
          sources: [source],
        });
        await task;
        expect(session.state.entry?.previousResponseId).toBe(parentId);
        expect(session.back()).toBe(child);
        expect(session.state.followUp).toEqual(targetFor(root));
        expect(session.state.entry?.expanded).toEqual([]);
        expect(session.state.entry?.sources[0]?.excerpts).toEqual([
          "Original passage",
        ]);
        if (operation === "search") {
          session.startFollowUp();
          await session.search("pending question");
          expect(search).toHaveBeenCalledTimes(searchCalls + 2);
        } else {
          await session.readSelected();
          expect(extract).toHaveBeenCalledTimes(extractCalls + 1);
        }
        expect(session.state.cached).toBe(false);
        expect(session.state.error).toBeNull();
      },
    );
  }

  test("long chains keep bounded flat parent data and twenty total cache/history entries", async () => {
    const { session, search, source } = setup();
    const rawTerm = "r".repeat(1_200);
    const rawContext = "c".repeat(2_200);
    await session.search(rawTerm, rawContext);
    const root = session.state.entry!;
    const entries: Entry[] = [root];
    const efforts = ["low", "medium", "high"] as const;
    expect(root.term).toHaveLength(1_000);
    expect(root.context).toHaveLength(2_000);
    for (let i = 1; i <= 25; i++) {
      const parent = session.state.entry!;
      expect(session.startFollowUp()).toBe(true);
      expect(session.state.followUp).toEqual(targetFor(parent));
      session.setEffort(efforts[i % efforts.length]!);
      await session.search("same question", "ignored");
      const entry = session.state.entry!;
      expect(entry).toEqual({
        responseId: `response-${i + 1}`,
        text: "Answer.¹",
        sources: [source],
        term: "same question",
        context: root.context,
        effort: efforts[i % efforts.length]!,
        expanded: [],
        previousResponseId: parent.responseId!,
        followUpTo: parent.term,
      });
      entries.push(entry);
    }
    expect(search).toHaveBeenCalledTimes(26);
    for (let i = 24; i >= 5; i--) {
      expect(session.back()).toBe(entries[i]!);
      expect(session.state.followUp).toEqual(targetFor(entries[i - 1]!));
    }
    expect(session.back()).toBeNull();
    session.startFollowUp();
    session.setEffort(entries[6]!.effort);
    await session.search("same question");
    expect(session.state.entry).toBe(entries[6]!);
    expect(session.state.cached).toBe(true);
    expect(search).toHaveBeenCalledTimes(26);
    session.startNewLookup();
    session.setEffort("low");
    await session.search(rawTerm, rawContext);
    expect(session.state.cached).toBe(false);
    expect(search).toHaveBeenCalledTimes(27);
  });
});
