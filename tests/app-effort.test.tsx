import { afterEach, describe, expect, mock, test } from "bun:test";
import type { TestRendererSetup } from "@opentui/core/testing";
import { testRender } from "@opentui/solid";
import { App, type AppProps } from "../src/app";
import { createDemoService } from "../src/demo";
import type { Effort } from "../src/effort";
import { createParallelService, type Answer } from "../src/parallel";

const mounted: TestRendererSetup[] = [];
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

function service() {
  const demo = createDemoService();
  return { search: mock(demo.search), extract: mock(demo.extract) };
}

async function open(screen: TestRendererSetup) {
  screen.mockInput.pressKey("e", { ctrl: true });
  await screen.waitForFrame((frame) => frame.includes("Research effort"));
}

async function choose(screen: TestRendererSetup, effort: Effort) {
  await open(screen);
  for (let i = 0; i < 3; i++) {
    if (screen.captureCharFrame().includes(`› ${effort.padEnd(6)}`)) break;
    screen.mockInput.pressArrow("down");
    await screen.flush();
  }
  expect(screen.captureCharFrame()).toContain(`› ${effort.padEnd(6)}`);
  screen.mockInput.pressEnter();
  await screen.waitForFrame((frame) => !frame.includes("Research effort"));
}

async function lookup(screen: TestRendererSetup) {
  screen.mockInput.pressEnter();
  await screen.waitForFrame((frame) => frame.includes("according to"));
}

async function clickText(screen: TestRendererSetup, text: string) {
  const lines = screen.captureCharFrame().split("\n");
  const y = lines.findIndex((line) => line.includes(text));
  expect(y).toBeGreaterThanOrEqual(0);
  const x = lines[y]!.indexOf(text);
  await screen.mockMouse.click(x, y);
  await screen.flush();
}

describe("interactive effort", () => {
  test("choosing high sends nothing until the next Enter, then reaches the API body", async () => {
    const text = "A perceptron is a linear classifier.";
    const fetcher = mock(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            status: "completed",
            output: [
              {
                type: "message",
                role: "assistant",
                content: [
                  {
                    type: "output_text",
                    text,
                    annotations: [
                      {
                        type: "url_citation",
                        url: "https://example.org/perceptron",
                        title: "Perceptron",
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
        ),
    );
    const screen = await mount({
      service: createParallelService("mock-key-never-send-live", {
        fetch: fetcher as unknown as typeof fetch,
      }),
      configured: true,
      initialQuery: "perceptron",
    });
    await choose(screen, "high");
    expect(screen.captureCharFrame()).toContain("effort: high");
    expect(screen.captureCharFrame()).toContain("perceptron");
    expect(fetcher).not.toHaveBeenCalled();
    await lookup(screen);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body))).toMatchObject({
      reasoning: { effort: "high" },
    });
    expect(screen.captureCharFrame()).toContain(text);
  });

  test("shows costs, keeps typed text out of the query, and Escape cancels", async () => {
    const api = service();
    const screen = await mount({
      service: api,
      configured: true,
      effort: "medium",
      initialQuery: "entropy",
    });
    await open(screen);
    expect(screen.captureCharFrame()).toContain("› medium");
    for (const price of ["$0.01", "$0.05", "$0.25"])
      expect(screen.captureCharFrame()).toContain(price);
    screen.mockInput.pressArrow("down");
    await screen.mockInput.typeText("ignore-me");
    screen.mockInput.pressEscape();
    await screen.flush();
    expect(screen.captureCharFrame()).not.toContain("Research effort");
    expect(screen.captureCharFrame()).toContain("effort: medium");
    expect(api.search).not.toHaveBeenCalled();
    await lookup(screen);
    expect(api.search).toHaveBeenCalledWith(
      "entropy",
      "",
      expect.any(AbortSignal),
      "medium",
    );
  });

  test("applying the current tier leaves the answer and request count unchanged", async () => {
    const api = service();
    const screen = await mount({
      service: api,
      configured: true,
      initialQuery: "entropy",
    });
    await lookup(screen);
    await choose(screen, "low");
    expect(screen.captureCharFrame()).toContain("according to");
    expect(api.search).toHaveBeenCalledTimes(1);
  });

  test("same-query lookups use separate tiers and reuse the right cache", async () => {
    const api = service();
    const screen = await mount({
      service: api,
      configured: true,
      initialQuery: "entropy",
    });
    await lookup(screen);
    await choose(screen, "high");
    expect(screen.captureCharFrame()).not.toContain("according to");
    expect(api.search).toHaveBeenCalledTimes(1);
    await lookup(screen);
    expect(api.search.mock.calls.map((call) => call[3])).toEqual([
      "low",
      "high",
    ]);
    await choose(screen, "low");
    await lookup(screen);
    expect(api.search).toHaveBeenCalledTimes(2);
    expect(screen.captureCharFrame()).toContain("session cache");
    expect(screen.captureCharFrame()).toContain("effort: low");
  });

  test("Ctrl+B restores the previous effort after a failed lookup at another tier", async () => {
    const api = service();
    const screen = await mount({
      service: api,
      configured: true,
      initialQuery: "entropy",
    });
    await lookup(screen);
    await choose(screen, "high");
    api.search.mockRejectedValueOnce(new Error("Offline."));
    screen.mockInput.pressEnter();
    await screen.waitForFrame((frame) => frame.includes("Offline."));
    screen.mockInput.pressKey("b", { ctrl: true });
    await screen.waitForFrame((frame) => frame.includes("according to"));
    expect(screen.captureCharFrame()).toContain("effort: low");
    expect(screen.captureCharFrame()).not.toContain("Offline.");
    expect(api.search).toHaveBeenCalledTimes(2);
  });

  test("effort is locked while searching, and becomes available after cancellation", async () => {
    const api = service();
    let resolve!: (answer: Answer) => void;
    api.search.mockReturnValueOnce(
      new Promise<Answer>((yes) => {
        resolve = yes;
      }),
    );
    const screen = await mount({
      service: api,
      configured: true,
      initialQuery: "entropy",
    });
    screen.mockInput.pressEnter();
    await screen.waitForFrame((frame) => frame.includes("Looking up"));
    screen.mockInput.pressKey("e", { ctrl: true });
    await screen.flush();
    expect(screen.captureCharFrame()).not.toContain("Research effort");
    expect(screen.captureCharFrame()).toContain("effort: low");
    screen.mockInput.pressEscape();
    await screen.flush();
    expect(api.search.mock.calls[0]![2]?.aborted).toBe(true);
    await choose(screen, "high");
    resolve({ text: "Stale low answer.", sources: [] });
    await screen.flush();
    expect(screen.captureCharFrame()).toContain("effort: high");
    expect(screen.captureCharFrame()).not.toContain("Stale low");
    expect(api.search).toHaveBeenCalledTimes(1);
  });

  test("clicking selects effort in a narrow terminal; demo stays offline", async () => {
    const api = service();
    const screen = await mount(
      { service: api, demo: true, initialQuery: "entropy" },
      48,
      20,
    );
    await clickText(screen, "effort: low");
    expect(screen.captureCharFrame()).toContain("Research effort");
    expect(screen.captureCharFrame()).toContain("no requests or charges");
    expect(screen.captureCharFrame()).toContain("Esc cancel");
    await clickText(screen, "high");
    expect(screen.captureCharFrame()).not.toContain("Research effort");
    expect(screen.captureCharFrame()).toContain("effort: high");
    expect(screen.captureCharFrame()).toContain("demo · offline");
    expect(api.search).not.toHaveBeenCalled();
    await lookup(screen);
    expect(api.search.mock.calls[0]![3]).toBe("high");
    expect(screen.captureCharFrame()).toContain("q quit");
  });

  test("missing-key screen does not open the selector", async () => {
    const api = service();
    const screen = await mount({ service: api, initialQuery: "entropy" });
    screen.mockInput.pressKey("e", { ctrl: true });
    await screen.flush();
    expect(screen.captureCharFrame()).not.toContain("Research effort");
    expect(screen.captureCharFrame()).toContain("no key");
    expect(api.search).not.toHaveBeenCalled();
  });
});
