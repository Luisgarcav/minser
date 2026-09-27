import { afterEach, describe, expect, mock, test } from "bun:test";
import { InputRenderable } from "@opentui/core";
import type { TestRendererSetup } from "@opentui/core/testing";
import { testRender } from "@opentui/solid";
import { App, type AppProps } from "../src/app";
import { createDemoService } from "../src/demo";
import type { Effort } from "../src/effort";
import {
  createParallelService,
  type Answer,
  type LookupService,
  type Source,
} from "../src/parallel";

const mounted: TestRendererSetup[] = [];
const context = "information theory";
const source: Source = {
  title: "Entropy reference",
  url: "https://example.org/entropy",
  excerpts: [],
};

afterEach(() => {
  for (const screen of mounted.splice(0)) screen.renderer.destroy();
});

async function mount(props: AppProps, width = 80, height = 24) {
  const screen = await testRender(() => <App {...props} />, {
    width,
    height,
    useMouse: true,
    kittyKeyboard: true,
  });
  mounted.push(screen);
  await screen.flush();
  return screen;
}

function answer(responseId: string): Answer {
  return {
    responseId,
    text: `Answer from ${responseId}.¹`,
    sources: [structuredClone(source)],
  };
}

function service() {
  let nextId = 0;
  return {
    search: mock<LookupService["search"]>(async () =>
      answer(`response-${++nextId}`),
    ),
    extract: mock<LookupService["extract"]>(async (selected) => ({
      ...selected,
      excerpts: ["An original source passage."],
    })),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function frameWith(screen: TestRendererSetup, text: string) {
  try {
    return await screen.waitForFrame((frame) => frame.includes(text));
  } catch (cause) {
    throw new Error(
      `Expected a frame containing ${JSON.stringify(text)}. Observed:\n${screen.captureCharFrame()}`,
      { cause },
    );
  }
}

function query(screen: TestRendererSetup) {
  const field = screen.renderer.root.findDescendantById("query");
  if (!(field instanceof InputRenderable)) {
    throw new Error(
      `Expected an input. Observed:\n${screen.captureCharFrame()}`,
    );
  }
  return field.value;
}

async function key(screen: TestRendererSetup, name: string, ctrl = false) {
  screen.mockInput.pressKey(name, { ctrl });
  await screen.flush();
}

async function lookup(screen: TestRendererSetup) {
  screen.mockInput.pressEnter();
  try {
    await screen.waitForFrame(
      (frame) =>
        frame.includes("according to") &&
        !frame.includes("Previous lookup:") &&
        !screen.renderer.root.findDescendantById("query"),
    );
  } catch (cause) {
    const field = screen.renderer.root.findDescendantById("query");
    throw new Error(
      `Expected Enter to show the answer (input focused: ${field?.focused}). Observed:\n${screen.captureCharFrame()}`,
      { cause },
    );
  }
}

async function chooseEffort(screen: TestRendererSetup, effort: Effort) {
  await key(screen, "e", true);
  await frameWith(screen, "Research effort");
  for (let i = 0; i < 3; i++) {
    if (screen.captureCharFrame().includes(`› ${effort.padEnd(6)}`)) break;
    screen.mockInput.pressArrow("down");
    await screen.flush();
  }
  expect(screen.captureCharFrame()).toContain(`› ${effort.padEnd(6)}`);
  screen.mockInput.pressEnter();
  await screen.flush();
  expect(screen.captureCharFrame()).not.toContain("Research effort");
}

async function clickControl(
  screen: TestRendererSetup,
  id: "follow-up-control" | "new-lookup-control",
  text: string,
) {
  const frame = screen.captureCharFrame();
  expect(screen.renderer.root.findDescendantById(id)).toBeDefined();
  const lines = frame.split("\n");
  const y = lines.findIndex((line) => line.includes(text));
  if (y < 0) throw new Error(`Missing mouse target ${id}. Observed:\n${frame}`);
  await screen.mockMouse.click(lines[y]!.indexOf(text), y);
  await screen.flush();
}

// Only the injected fetch sees these payloads; no live API or environment key.
function response(responseId: string) {
  return new Response(
    JSON.stringify({
      id: responseId,
      status: "completed",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: `Answer from ${responseId}.`,
              annotations: [
                {
                  type: "url_citation",
                  url: source.url,
                  title: source.title,
                  start_index: 0,
                  end_index: 0,
                },
              ],
            },
          ],
        },
      ],
    }),
    { headers: { "content-type": "application/json" } },
  );
}

function wireService() {
  let nextId = 0;
  const fetcher = mock(async (_url: RequestInfo | URL, _init?: RequestInit) =>
    response(`wire-${++nextId}`),
  );
  return {
    fetcher,
    service: createParallelService("mock-key-never-send-live", {
      fetch: fetcher as unknown as typeof fetch,
    }),
    bodies: () =>
      fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body))),
  };
}

describe("follow-up UI drafts", () => {
  test("f clears the input, anchors the answer and sends literal colons only on Enter", async () => {
    const api = service();
    const screen = await mount({
      service: api,
      configured: true,
      initialQuery: "entropy",
      initialContext: context,
      effort: "medium",
    });
    expect(api.search).not.toHaveBeenCalled();
    await lookup(screen);
    expect(api.search).toHaveBeenLastCalledWith(
      "entropy",
      context,
      expect.any(AbortSignal),
      "medium",
    );
    await key(screen, "f");
    expect(query(screen)).toBe("");
    expect(screen.captureCharFrame()).toContain("Ask a follow-up…");
    expect(screen.captureCharFrame()).toContain("Follow-up to: entropy");
    expect(screen.captureCharFrame()).toContain("Previous lookup: entropy");
    expect(screen.captureCharFrame()).toContain("⏎ follow up");
    expect(api.search).toHaveBeenCalledTimes(1);
    screen.mockInput.pressEnter();
    await screen.flush();
    expect(api.search).toHaveBeenCalledTimes(1);

    const question = "Why: 1:2 : https://example.org:8080/a::b?";
    await screen.mockInput.typeText(question);
    expect(query(screen)).toBe(question);
    expect(api.search).toHaveBeenCalledTimes(1);
    await lookup(screen);
    expect(api.search).toHaveBeenLastCalledWith(
      question,
      context,
      expect.any(AbortSignal),
      "medium",
      "response-1",
    );
    expect(api.search).toHaveBeenCalledTimes(2);
    expect(api.extract).not.toHaveBeenCalled();
  });

  test("slash edits the current turn without advancing its parent; only explicit f advances", async () => {
    const api = service();
    const screen = await mount({
      service: api,
      configured: true,
      initialQuery: "entropy",
      initialContext: context,
    });
    await lookup(screen);
    await key(screen, "f");
    await screen.mockInput.typeText("Why: a coin?");
    await lookup(screen);
    await key(screen, "/");
    expect(query(screen)).toBe("Why: a coin?");
    await screen.mockInput.typeText(" And dice?");
    expect(api.search).toHaveBeenCalledTimes(2);
    await lookup(screen);
    expect(api.search).toHaveBeenLastCalledWith(
      "Why: a coin? And dice?",
      context,
      expect.any(AbortSignal),
      "low",
      "response-1",
    );
    expect(screen.captureCharFrame()).toContain("Follow-up to: entropy");
    await key(screen, "/");
    expect(query(screen)).toBe("Why: a coin? And dice?");
    await lookup(screen);
    expect(api.search).toHaveBeenCalledTimes(3);
    expect(screen.captureCharFrame()).toContain("session cache");

    await key(screen, "f");
    expect(query(screen)).toBe("");
    expect(screen.captureCharFrame()).toContain(
      "Follow-up to: Why: a coin? And dice?",
    );
    expect(api.search).toHaveBeenCalledTimes(3);
    await screen.mockInput.typeText("What else: why?");
    await lookup(screen);
    expect(api.search).toHaveBeenLastCalledWith(
      "What else: why?",
      context,
      expect.any(AbortSignal),
      "low",
      "response-3",
    );
    expect(api.search).toHaveBeenCalledTimes(4);
  });

  test("n clears a linked turn and resumes independent colon parsing only on Enter", async () => {
    const api = service();
    const screen = await mount({
      service: api,
      configured: true,
      initialQuery: "entropy",
      initialContext: context,
    });
    await lookup(screen);
    await key(screen, "f");
    await screen.mockInput.typeText("Why: a coin?");
    await lookup(screen);
    await key(screen, "n");
    expect(query(screen)).toBe("");
    expect(screen.captureCharFrame()).not.toContain("Follow-up to:");
    expect(screen.captureCharFrame()).toContain("⏎ look up");
    expect(api.search).toHaveBeenCalledTimes(2);
    await screen.mockInput.typeText("coherence : quantum mechanics");
    expect(api.search).toHaveBeenCalledTimes(2);
    await lookup(screen);
    expect(api.search).toHaveBeenLastCalledWith(
      "coherence",
      "quantum mechanics",
      expect.any(AbortSignal),
      "low",
    );
    expect(api.search.mock.calls[2]).toHaveLength(4);
    expect(api.search).toHaveBeenCalledTimes(3);
  });

  test.each([
    [80, 24, "follow-up"],
    [48, 20, "follow-up"],
    [80, 24, "new"],
    [48, 20, "new"],
  ] as const)(
    "mouse at %ix%i starts an editable %s draft with the offline demo",
    async (width, height, kind) => {
      const demo = createDemoService();
      const api = { search: mock(demo.search), extract: mock(demo.extract) };
      const screen = await mount(
        {
          service: api,
          demo: true,
          initialQuery: "entropy",
          initialContext: context,
        },
        width,
        height,
      );
      await lookup(screen);
      if (kind === "new") {
        await key(screen, "f");
        await screen.mockInput.typeText("Example: a coin?");
        await lookup(screen);
      }
      const before = kind === "follow-up" ? 1 : 2;
      expect(screen.captureCharFrame()).toContain("demo · offline");
      expect(screen.captureCharFrame()).toContain("f follow up");
      expect(screen.captureCharFrame()).toContain("n new");
      await clickControl(
        screen,
        kind === "follow-up" ? "follow-up-control" : "new-lookup-control",
        kind === "follow-up" ? "f follow up" : "n new",
      );
      expect(query(screen)).toBe("");
      expect(screen.captureCharFrame().includes("Follow-up to: entropy")).toBe(
        kind === "follow-up",
      );
      expect(api.search).toHaveBeenCalledTimes(before);
      await screen.mockInput.typeText(
        kind === "follow-up" ? "Example: a coin?" : "coherence : optics",
      );
      expect(api.search).toHaveBeenCalledTimes(before);
      await lookup(screen);
      expect(api.search.mock.calls.at(-1)).toEqual(
        kind === "follow-up"
          ? [
              "Example: a coin?",
              context,
              expect.any(AbortSignal),
              "low",
              "demo-response-1",
            ]
          : ["coherence", "optics", expect.any(AbortSignal), "low"],
      );
      expect(screen.captureCharFrame()).toContain(
        kind === "follow-up" ? "For a fair coin" : "average uncertainty",
      );
      expect(screen.captureCharFrame()).toContain("q quit");
      expect(api.search).toHaveBeenCalledTimes(before + 1);
      expect(api.extract).not.toHaveBeenCalled();
    },
  );

  test.each(["f", "n"] as const)(
    "Ctrl+E preserves the %s draft's text and linkage without sending it",
    async (draft) => {
      const api = service();
      const screen = await mount({
        service: api,
        configured: true,
        initialQuery: "entropy",
        initialContext: context,
      });
      await lookup(screen);
      await key(screen, "f");
      await screen.mockInput.typeText("First question");
      await lookup(screen);
      await key(screen, draft);
      await screen.mockInput.typeText("Next: a coin?");
      await chooseEffort(screen, "high");
      expect(query(screen)).toBe("Next: a coin?");
      expect(screen.captureCharFrame()).toContain("effort: high");
      expect(
        screen.captureCharFrame().includes("Follow-up to: First question"),
      ).toBe(draft === "f");
      expect(api.search).toHaveBeenCalledTimes(2);
      await lookup(screen);
      expect(api.search.mock.calls[2]).toEqual(
        draft === "f"
          ? [
              "Next: a coin?",
              context,
              expect.any(AbortSignal),
              "high",
              "response-2",
            ]
          : ["Next", "a coin?", expect.any(AbortSignal), "high"],
      );
      expect(api.search).toHaveBeenCalledTimes(3);
    },
  );

  test.each([
    ["f", "Escape", false],
    ["n", "Escape", false],
    ["f", "Ctrl+B", false],
    ["n", "Ctrl+B", false],
    ["f", "Escape", true],
    ["n", "Escape", true],
    ["f", "Ctrl+B", true],
    ["n", "Ctrl+B", true],
  ] as const)(
    "unsent %s + %s restores answer, effort and parent without consuming history (changed effort: %j)",
    async (draft, cancel, changeEffort) => {
      const api = service();
      const screen = await mount({
        service: api,
        configured: true,
        initialQuery: "entropy",
        initialContext: context,
      });
      await lookup(screen);
      await key(screen, "f");
      await chooseEffort(screen, "medium");
      await screen.mockInput.typeText("Why: a coin?");
      await lookup(screen);
      await key(screen, draft);
      await screen.mockInput.typeText("Discard this: unsent");
      if (changeEffort) await chooseEffort(screen, "high");
      if (cancel === "Ctrl+B") await key(screen, "b", true);
      else {
        screen.mockInput.pressEscape();
        await screen.flush();
      }
      expect(screen.captureCharFrame()).toContain("Answer from response-2.");
      expect(screen.captureCharFrame()).toContain("effort: medium");
      expect(screen.captureCharFrame()).toContain("Follow-up to: entropy");
      expect(screen.captureCharFrame()).not.toContain("Discard this");
      expect(screen.captureCharFrame()).not.toContain("Previous lookup:");
      expect(api.search).toHaveBeenCalledTimes(2);

      // Restoring a follow-up must not append its inherited context to the field.
      await key(screen, "/");
      expect(query(screen)).toBe("Why: a coin?");
      await lookup(screen);
      expect(api.search).toHaveBeenCalledTimes(2);
      expect(screen.captureCharFrame()).toContain("session cache");
      await key(screen, "b", true);
      expect(screen.captureCharFrame()).toContain("Answer from response-1.");
      expect(screen.captureCharFrame()).toContain("effort: low");
      expect(screen.captureCharFrame()).not.toContain("Follow-up to:");
      await key(screen, "/");
      expect(query(screen)).toBe(`entropy : ${context}`);
      await lookup(screen);
      expect(api.search).toHaveBeenCalledTimes(2);
      expect(api.extract).not.toHaveBeenCalled();
    },
  );

  test.each(["initial", "follow-up", "new", "slash edit"] as const)(
    "f, n, q and digits remain ordinary input during %s editing",
    async (mode) => {
      const api = service();
      const onExit = mock(() => {});
      const screen = await mount({
        service: api,
        configured: true,
        initialQuery: mode === "initial" ? "" : "entropy",
        onExit,
      });
      if (mode !== "initial") {
        await lookup(screen);
        await key(
          screen,
          mode === "follow-up" ? "f" : mode === "new" ? "n" : "/",
        );
      }
      await screen.mockInput.typeText("fnq12345");
      const term = mode === "slash edit" ? "entropyfnq12345" : "fnq12345";
      expect(query(screen)).toBe(term);
      expect(onExit).not.toHaveBeenCalled();
      expect(api.extract).not.toHaveBeenCalled();
      expect(api.search).toHaveBeenCalledTimes(mode === "initial" ? 0 : 1);
      await lookup(screen);
      expect(api.search.mock.calls.at(-1)).toEqual(
        mode === "follow-up"
          ? [term, "", expect.any(AbortSignal), "low", "response-1"]
          : [term, "", expect.any(AbortSignal), "low"],
      );
      expect(onExit).not.toHaveBeenCalled();
      expect(api.extract).not.toHaveBeenCalled();
    },
  );
});

describe("follow-up UI guards and cancellation", () => {
  test.each(["completion", "rejection"] as const)(
    "Escape aborts a linked search and ignores stale %s after a newer answer",
    async (settlement) => {
      const api = service();
      const pending = deferred<Answer>();
      const screen = await mount({
        service: api,
        configured: true,
        initialQuery: "entropy",
        initialContext: context,
      });
      await lookup(screen);
      await key(screen, "f");
      await screen.mockInput.typeText("Pending: why?");
      api.search.mockReturnValueOnce(pending.promise);
      screen.mockInput.pressEnter();
      await frameWith(screen, "Looking up Pending: why?");
      expect(screen.captureCharFrame()).toContain("conversation context");
      const signal = api.search.mock.calls[1]![2]!;
      await key(screen, "f");
      await key(screen, "n");
      expect(screen.captureCharFrame()).toContain("Looking up Pending: why?");
      expect(screen.renderer.root.findDescendantById("query")).toBeUndefined();
      expect(signal.aborted).toBe(false);
      expect(api.search).toHaveBeenCalledTimes(2);
      screen.mockInput.pressEscape();
      await screen.flush();
      expect(signal.aborted).toBe(true);
      expect(query(screen)).toBe("Pending: why?");
      expect(screen.captureCharFrame()).toContain("Follow-up to: entropy");
      expect(screen.captureCharFrame()).not.toContain("Looking up");
      await screen.mockInput.typeText(" Revised");
      await lookup(screen);
      expect(api.search).toHaveBeenLastCalledWith(
        "Pending: why? Revised",
        context,
        expect.any(AbortSignal),
        "low",
        "response-1",
      );
      if (settlement === "completion")
        pending.resolve(answer("stale-response"));
      else pending.reject(new Error("Stale rejection must stay hidden."));
      await screen.flush();
      expect(screen.captureCharFrame()).toContain("Answer from response-2.");
      expect(screen.captureCharFrame()).not.toContain("stale-response");
      expect(screen.captureCharFrame()).not.toContain("Stale rejection");
      expect(api.search).toHaveBeenCalledTimes(3);
      await key(screen, "f");
      await screen.mockInput.typeText("After cancellation");
      await lookup(screen);
      expect(api.search.mock.calls[3]![4]).toBe("response-2");
      expect(api.search).toHaveBeenCalledTimes(4);
    },
  );

  test("keyboard and mouse cannot start a follow-up while a source is being read", async () => {
    const api = service();
    const pending = deferred<Source>();
    api.extract.mockReturnValueOnce(pending.promise);
    const screen = await mount({
      service: api,
      configured: true,
      initialQuery: "entropy",
    });
    await lookup(screen);
    await key(screen, "1");
    await frameWith(screen, "Reading this source");
    const signal = api.extract.mock.calls[0]![3]!;
    await key(screen, "f");
    await clickControl(screen, "follow-up-control", "f follow up");
    expect(screen.captureCharFrame()).not.toContain("Follow-up to:");
    expect(screen.renderer.root.findDescendantById("query")).toBeUndefined();
    expect(screen.captureCharFrame()).toContain("Reading this source");
    expect(signal.aborted).toBe(false);
    expect(api.search).toHaveBeenCalledTimes(1);
    expect(api.extract).toHaveBeenCalledTimes(1);
    screen.mockInput.pressEscape();
    await screen.flush();
    expect(signal.aborted).toBe(true);
    pending.resolve({ ...source, excerpts: ["Stale source passage"] });
    await screen.flush();
    expect(screen.captureCharFrame()).not.toContain("Stale source passage");
    await key(screen, "f");
    expect(query(screen)).toBe("");
    expect(screen.captureCharFrame()).toContain("Follow-up to: entropy");
    expect(api.search).toHaveBeenCalledTimes(1);
  });

  test.each([undefined, "", "   "])(
    "a cited answer with response ID %j stays visible but has no follow-up action",
    async (responseId) => {
      const api = service();
      api.search.mockResolvedValueOnce({
        text: "Still a useful cited answer.¹",
        sources: [source],
        ...(responseId === undefined ? {} : { responseId }),
      });
      const screen = await mount({
        service: api,
        configured: true,
        initialQuery: "entropy",
      });
      await lookup(screen);
      expect(screen.captureCharFrame()).toContain(
        "Still a useful cited answer.",
      );
      expect(screen.captureCharFrame()).toContain(
        "Follow-up unavailable: no response ID",
      );
      expect(screen.captureCharFrame()).not.toContain("f follow up");
      expect(
        screen.renderer.root.findDescendantById("follow-up-control"),
      ).toBeUndefined();
      await key(screen, "f");
      expect(screen.renderer.root.findDescendantById("query")).toBeUndefined();
      expect(screen.captureCharFrame()).not.toContain("Follow-up to:");
      expect(api.search).toHaveBeenCalledTimes(1);
      await key(screen, "1");
      expect(api.extract).toHaveBeenCalledTimes(1);
      await key(screen, "n");
      expect(query(screen)).toBe("");
      expect(api.search).toHaveBeenCalledTimes(1);
    },
  );

  test.each(["no sources", "empty answer"] as const)(
    "f is disabled with %s even when an ID exists",
    async (reason) => {
      const api = service();
      api.search.mockResolvedValueOnce({
        responseId: "unusable-answer",
        text: reason === "empty answer" ? "" : "An uncited answer.",
        sources: reason === "no sources" ? [] : [source],
      });
      const screen = await mount({
        service: api,
        configured: true,
        initialQuery: "entropy",
      });
      screen.mockInput.pressEnter();
      await frameWith(screen, "Not enough sources to answer.");
      await key(screen, "f");
      expect(screen.captureCharFrame()).not.toContain("Follow-up to:");
      expect(screen.captureCharFrame()).not.toContain("f follow up");
      expect(
        screen.renderer.root.findDescendantById("follow-up-control"),
      ).toBeUndefined();
      expect(screen.renderer.root.findDescendantById("query")).toBeUndefined();
      expect(api.search).toHaveBeenCalledTimes(1);
      expect(api.extract).not.toHaveBeenCalled();
    },
  );

  test("missing configuration disables follow-up and new actions without a request", async () => {
    const api = service();
    const screen = await mount({ service: api, initialQuery: "entropy" });
    screen.mockInput.pressEscape();
    await screen.flush();
    await key(screen, "f");
    await key(screen, "n");
    screen.mockInput.pressEnter();
    await screen.flush();
    expect(screen.captureCharFrame()).toContain("PARALLEL_API_KEY is missing.");
    expect(screen.captureCharFrame()).not.toContain("Follow-up to:");
    expect(query(screen)).toBe("entropy");
    expect(
      screen.renderer.root.findDescendantById("follow-up-control"),
    ).toBeUndefined();
    expect(
      screen.renderer.root.findDescendantById("new-lookup-control"),
    ).toBeUndefined();
    expect(api.search).not.toHaveBeenCalled();
    expect(api.extract).not.toHaveBeenCalled();
  });
});

describe("follow-up UI to mocked Responses fetch", () => {
  test("actual request bodies preserve edited parents, advance explicit chains and omit independent linkage", async () => {
    const api = wireService();
    const screen = await mount({
      service: api.service,
      configured: true,
      initialQuery: "entropy",
      initialContext: context,
    });
    expect(api.fetcher).not.toHaveBeenCalled();
    await lookup(screen);
    await key(screen, "f");
    await screen.mockInput.typeText("Why: a coin?");
    expect(api.fetcher).toHaveBeenCalledTimes(1);
    await lookup(screen);
    await key(screen, "/");
    await screen.mockInput.typeText(" And dice?");
    expect(api.fetcher).toHaveBeenCalledTimes(2);
    await lookup(screen);
    await key(screen, "f");
    await screen.mockInput.typeText("Limits: why?");
    expect(api.fetcher).toHaveBeenCalledTimes(3);
    await lookup(screen);
    await key(screen, "n");
    await screen.mockInput.typeText("coherence : optics");
    expect(api.fetcher).toHaveBeenCalledTimes(4);
    await lookup(screen);

    const bodies = api.bodies();
    expect(bodies.map((body) => body.previous_response_id)).toEqual([
      undefined,
      "wire-1",
      "wire-1",
      "wire-3",
      undefined,
    ]);
    expect(bodies.map((body) => JSON.parse(body.input))).toEqual([
      { term: "entropy", context },
      { term: "Why: a coin?", context },
      { term: "Why: a coin? And dice?", context },
      { term: "Limits: why?", context },
      { term: "coherence", context: "optics" },
    ]);
    for (const index of [0, 4])
      expect(bodies[index]).not.toHaveProperty("previous_response_id");
    expect(api.fetcher).toHaveBeenCalledTimes(5);
    for (const [url, init] of api.fetcher.mock.calls) {
      expect(url).toBe("https://api.parallel.ai/v1/responses");
      expect(init?.method).toBe("POST");
    }
  });

  test.each(["HTTP 404", "fetch rejection"] as const)(
    "%s never replays or falls back; Enter explicitly retries the same parent",
    async (failure) => {
      const api = wireService();
      const screen = await mount({
        service: api.service,
        configured: true,
        initialQuery: "entropy",
        initialContext: context,
      });
      await lookup(screen);
      await key(screen, "f");
      await screen.mockInput.typeText("Why: a coin?");
      if (failure === "HTTP 404") {
        api.fetcher.mockResolvedValueOnce(
          new Response("Not available", { status: 404 }),
        );
      } else {
        api.fetcher.mockRejectedValueOnce(new Error("Mock transport rejected"));
      }
      screen.mockInput.pressEnter();
      await frameWith(
        screen,
        failure === "HTTP 404" ? "HTTP 404" : "Could not connect to Parallel",
      );
      expect(screen.captureCharFrame()).toContain("⏎ retry");
      expect(screen.captureCharFrame()).toContain("Why: a coin?");
      expect(screen.captureCharFrame()).not.toContain("according to");
      if (failure === "HTTP 404") {
        expect(screen.captureCharFrame().replace(/\s+/g, " ")).toContain(
          "cannot continue this conversation",
        );
      }
      await key(screen, "f");
      await screen.flush();
      expect(api.fetcher).toHaveBeenCalledTimes(2);
      expect(api.bodies()[1].previous_response_id).toBe("wire-1");
      await lookup(screen);
      expect(api.fetcher).toHaveBeenCalledTimes(3);
      expect(api.bodies()[2]).toEqual(api.bodies()[1]);
      expect(screen.captureCharFrame()).toContain("Answer from wire-2.");
      await key(screen, "n");
      await screen.mockInput.typeText("fresh : optics");
      expect(api.fetcher).toHaveBeenCalledTimes(3);
      await lookup(screen);
      const bodies = api.bodies();
      expect(bodies.map((body) => body.previous_response_id)).toEqual([
        undefined,
        "wire-1",
        "wire-1",
        undefined,
      ]);
      expect(bodies[3]).not.toHaveProperty("previous_response_id");
      expect(bodies.map((body) => JSON.parse(body.input))).toEqual([
        { term: "entropy", context },
        { term: "Why: a coin?", context },
        { term: "Why: a coin?", context },
        { term: "fresh", context: "optics" },
      ]);
      expect(api.fetcher).toHaveBeenCalledTimes(4);
    },
  );
});
