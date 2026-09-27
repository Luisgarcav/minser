import { afterEach, describe, expect, mock, test } from "bun:test";
import type { TestRendererSetup } from "@opentui/core/testing";
import { testRender } from "@opentui/solid";
import { App, type AppProps } from "../src/app";
import { createDemoService } from "../src/demo";
import { createParallelService, type Answer } from "../src/parallel";

const mounted: TestRendererSetup[] = [];
afterEach(() => {
  for (const setup of mounted.splice(0)) setup.renderer.destroy();
});

async function mount(props: AppProps, width = 80, height = 24) {
  const setup = await testRender(() => <App {...props} />, {
    width,
    height,
    useMouse: false,
    kittyKeyboard: true,
  });
  mounted.push(setup);
  await setup.flush();
  return setup;
}
function service() {
  const demo = createDemoService();
  return { search: mock(demo.search), extract: mock(demo.extract) };
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
async function lookup(screen: TestRendererSetup) {
  screen.mockInput.pressEnter();
  await screen.waitForFrame((frame) => frame.includes("according to"));
}

describe("Paper terminal flow", () => {
  test("starts idle without requests, including demo and prefilled context", async () => {
    const api = service();
    const screen = await mount({
      service: api,
      demo: true,
      initialQuery: "entropy",
      initialContext: "information theory",
    });
    const frame = screen.captureCharFrame();
    expect(frame).toContain("minser");
    expect(frame).toContain("entropy : information theory");
    expect(frame).toContain("Type what you want");
    expect(frame).toContain("demo · offline");
    expect(api.search).not.toHaveBeenCalled();
    expect(api.extract).not.toHaveBeenCalled();
  });

  test.each([
    ["low", "5–10"],
    ["medium", "15–20"],
    ["high", "30–60"],
  ] as const)(
    "shows %s effort and its waiting estimate",
    async (effort, seconds) => {
      const api = service();
      api.search.mockReturnValueOnce(new Promise(() => {}));
      const screen = await mount({
        service: api,
        configured: true,
        initialQuery: "perceptron",
        effort,
      });
      expect(screen.captureCharFrame()).toContain(`effort: ${effort}`);
      expect(api.search).not.toHaveBeenCalled();
      screen.mockInput.pressEnter();
      await screen.waitForFrame((frame) => frame.includes("Looking up"));
      expect(screen.captureCharFrame()).toContain(`${seconds} seconds`);
    },
  );

  test("single-field lookup, numbered citations, collapse and cached re-expansion", async () => {
    const api = service();
    const screen = await mount({ service: api, configured: true });
    await screen.mockInput.typeText("entropy : information theory");
    await lookup(screen);
    expect(api.search).toHaveBeenCalledWith(
      "entropy",
      "information theory",
      expect.any(AbortSignal),
      "low",
    );
    expect(api.extract).not.toHaveBeenCalled();
    const frame = screen.captureCharFrame();
    expect(frame).toContain("variable.¹");
    expect(frame).toContain("1–3 expand");
    expect(frame).toContain("plato.stanford.edu");

    screen.mockInput.pressKey("2");
    await screen.waitForFrame((frame) => frame.includes("expected number"));
    expect(api.extract).toHaveBeenCalledTimes(1);
    expect(api.extract.mock.calls[0]![0].url).toContain("plato.stanford.edu");
    expect(screen.captureCharFrame()).toContain("2 collapse");
    screen.mockInput.pressKey("2");
    await screen.waitForFrame((frame) => !frame.includes("expected number"));
    screen.mockInput.pressKey("2");
    await screen.waitForFrame((frame) => frame.includes("expected number"));
    expect(api.extract).toHaveBeenCalledTimes(1);
    screen.mockInput.pressKey("/");
    await screen.flush();
    await lookup(screen);
    expect(api.search).toHaveBeenCalledTimes(1);
    expect(screen.captureCharFrame()).toContain("session cache");
  });

  test("demo fits 80x24 and resizes to a narrow terminal without losing commands", async () => {
    const screen = await mount({
      service: createDemoService(),
      demo: true,
      initialQuery: "entropy : information theory",
    });
    await lookup(screen);
    let frame = screen.captureCharFrame();
    expect(frame).toContain("Entropy (information theory)");
    expect(frame).toContain("ncatlab.org");
    expect(frame).toContain("q quit");
    expect(frame).toContain("Illustrative demo");
    screen.resize(48, 20);
    await screen.flush();
    frame = screen.captureCharFrame();
    expect(frame).toContain("minser");
    expect(frame).toContain("q quit");
    screen.mockInput.pressKey("3");
    await screen.waitForFrame((frame) => frame.includes("expected number"));
    screen.mockInput.pressKey("\x1b[6~");
    await screen.flush();
    expect(screen.captureCharFrame()).toContain("downloaded from this source");
    screen.mockInput.pressKey("\x1b[5~");
    await screen.flush();
    expect(screen.captureCharFrame()).not.toContain(
      "downloaded from this source",
    );
    const before = screen.captureCharFrame();
    screen.mockInput.pressArrow("up");
    await screen.flush();
    expect(screen.captureCharFrame()).not.toBe(before);
  });

  test("missing key shows setup and never sends a request", async () => {
    const fetcher = Object.assign(
      mock(async () => {
        throw new Error("Unexpected network");
      }),
      { preconnect: mock(() => {}) },
    );
    const onExit = mock(() => {});
    const screen = await mount({
      service: createParallelService("", { fetch: fetcher }),
      initialQuery: "entropy",
      onExit,
    });
    expect(screen.captureCharFrame()).toContain("PARALLEL_API_KEY is missing.");
    expect(screen.captureCharFrame()).toContain("cp .env.example .env");
    screen.mockInput.pressEnter();
    await screen.flush();
    expect(fetcher).not.toHaveBeenCalled();
    screen.mockInput.pressKey("q");
    await screen.flush();
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  test("Escape cancels a pending lookup and ignores late results", async () => {
    const pending = deferred<Answer>();
    const api = service();
    api.search.mockReturnValueOnce(pending.promise);
    const screen = await mount({
      service: api,
      initialQuery: "entropy",
      configured: true,
    });
    screen.mockInput.pressEnter();
    await screen.waitForFrame((frame) => frame.includes("Looking up"));
    expect(screen.captureCharFrame()).not.toContain("sources found");
    const signal = api.search.mock.calls[0]![2]!;
    screen.mockInput.pressEscape();
    await screen.waitFor(() => signal.aborted);
    pending.resolve({ text: "Stale result.", sources: [] });
    await screen.flush();
    expect(screen.captureCharFrame()).not.toContain("Stale result");
    expect(screen.captureCharFrame()).not.toContain("Looking up");
    await screen.mockInput.typeText(" updated");
    expect(api.search).toHaveBeenCalledTimes(1);
  });

  test("uncited and empty answers show the no-answer state", async () => {
    const api = service();
    api.search.mockResolvedValue({
      text: "Unverified definition",
      sources: [],
    });
    const screen = await mount({
      service: api,
      configured: true,
      initialQuery: "phlogiston",
    });
    screen.mockInput.pressEnter();
    await screen.waitForFrame((frame) => frame.includes("Not enough sources"));
    expect(screen.captureCharFrame()).not.toContain("Unverified definition");
    screen.mockInput.pressKey("1");
    await screen.flush();
    expect(api.extract).not.toHaveBeenCalled();
  });

  test("a failure keeps the query and Enter explicitly retries", async () => {
    const api = service();
    api.search.mockRejectedValueOnce(
      new Error("Parallel did not respond within 30 seconds."),
    );
    const screen = await mount({
      service: api,
      configured: true,
      initialQuery: "entropy",
    });
    screen.mockInput.pressEnter();
    await screen.waitForFrame((frame) => frame.includes("did not respond"));
    expect(screen.captureCharFrame()).toContain("entropy");
    expect(screen.captureCharFrame()).toContain("retry");
    await lookup(screen);
    expect(api.search).toHaveBeenCalledTimes(2);
  });

  test("failed extraction is inline; retry does not repeat Responses", async () => {
    const api = service();
    api.extract.mockRejectedValueOnce(new Error("Source unavailable."));
    const screen = await mount({
      service: api,
      configured: true,
      initialQuery: "entropy",
    });
    await lookup(screen);
    screen.mockInput.pressKey("1");
    await screen.waitForFrame((frame) => frame.includes("Source unavailable."));
    screen.mockInput.pressEnter();
    await screen.waitForFrame((frame) => frame.includes("expected number"));
    expect(api.search).toHaveBeenCalledTimes(1);
    expect(api.extract).toHaveBeenCalledTimes(2);
  });

  test("Ctrl+B restores the last good lookup after failure", async () => {
    const api = service();
    const screen = await mount({
      service: api,
      configured: true,
      initialQuery: "entropy",
    });
    await lookup(screen);
    screen.mockInput.pressKey("/");
    await screen.flush();
    await screen.mockInput.typeText(" new");
    api.search.mockRejectedValueOnce(new Error("Offline."));
    screen.mockInput.pressEnter();
    await screen.waitForFrame((frame) => frame.includes("Offline."));
    screen.mockInput.pressKey("b", { ctrl: true });
    await screen.waitForFrame((frame) => frame.includes("according to"));
    expect(screen.captureCharFrame()).not.toContain("entropy new");
    expect(api.search).toHaveBeenCalledTimes(2);
  });

  test("q and digits type while editing; Escape then q exits", async () => {
    const onExit = mock(() => {});
    const api = service();
    const screen = await mount({ service: api, configured: true, onExit });
    await screen.mockInput.typeText("q123");
    expect(onExit).not.toHaveBeenCalled();
    expect(api.extract).not.toHaveBeenCalled();
    screen.mockInput.pressEscape();
    await screen.flush();
    screen.mockInput.pressKey("q");
    await screen.flush();
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  test("Ctrl+C aborts in-flight work before exiting", async () => {
    const api = service();
    api.search.mockReturnValueOnce(new Promise(() => {}));
    const onExit = mock(() => {});
    const screen = await mount({
      service: api,
      configured: true,
      initialQuery: "entropy",
      onExit,
    });
    screen.mockInput.pressEnter();
    await screen.waitForFrame((frame) => frame.includes("Looking up"));
    screen.mockInput.pressKey("c", { ctrl: true });
    await screen.flush();
    expect(api.search.mock.calls[0]![2]!.aborted).toBe(true);
    expect(onExit).toHaveBeenCalledTimes(1);
  });
});
