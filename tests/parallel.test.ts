import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
  createParallelService,
  type LookupService,
  type Source,
} from "../src/parallel";

const KEY = "mock-key-never-send-live";
const PRIVATE_BODY = "private-provider-body-marker";
const SOURCE: Source = {
  title: "Artículo original",
  url: "https://example.org/paper",
  excerpts: ["Un pasaje original."],
};
type Operation = "search" | "extract";
const OPERATIONS: Operation[] = ["search", "extract"];
type FetchHandler = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

afterEach(() => mock.restore());

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function setup(handler: FetchHandler, timeoutMs?: number) {
  const fetcher = mock(handler);
  const service = createParallelService(KEY, {
    fetch: fetcher as unknown as typeof fetch,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  return { fetcher, service };
}

function lookup(
  service: LookupService,
  operation: Operation,
  signal?: AbortSignal,
) {
  return operation === "search"
    ? service.search("entropía", "termodinámica", signal)
    : service.extract(SOURCE, "entropía", "termodinámica", signal);
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as Error;
  }
  throw new Error("Se esperaba que la consulta fallara.");
}

function expectPrivate(error: Error) {
  expect(String(error)).not.toContain(KEY);
  expect(String(error)).not.toContain(PRIVATE_BODY);
  expect(error.cause).toBeUndefined();
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

// Drive deadlines explicitly: no sleeping, network, clock dependence or fake SDK.
function deadline() {
  let callback: (() => void) | undefined;
  const handle = 123_456 as unknown as ReturnType<typeof setTimeout>;
  const schedule = spyOn(globalThis, "setTimeout").mockImplementation(((
    handler: () => void,
  ) => {
    callback = handler;
    return handle;
  }) as typeof setTimeout);
  const clear = spyOn(globalThis, "clearTimeout").mockImplementation(() => {});
  return {
    handle,
    schedule,
    clear,
    fire() {
      if (!callback) throw new Error("No se programó el tiempo límite.");
      callback();
    },
  };
}

const responsePayload = (
  text = "A definition.",
  annotations: unknown[] = [
    {
      type: "url_citation",
      url: SOURCE.url,
      title: SOURCE.title,
      start_index: 0,
      end_index: text.length,
    },
  ],
) => ({
  status: "completed",
  output: [
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text, annotations }],
    },
  ],
});
const answer = {
  text: "A definition.¹",
  sources: [{ ...SOURCE, excerpts: [] }],
};

describe("Responses and Extract contracts", () => {
  test("Responses requests a short cited answer, with no search or conversation calls", async () => {
    const { service, fetcher } = setup(async () => json(responsePayload()));
    expect(await service.search(" entropy ", " information theory ")).toEqual(
      answer,
    );
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://api.parallel.ai/v1/responses");
    expect(init).toMatchObject({
      method: "POST",
      redirect: "error",
      credentials: "omit",
    });
    expect(new Headers(init?.headers).get("x-api-key")).toBe(KEY);
    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe("parallel");
    expect(body.reasoning).toEqual({ effort: "low" });
    expect(JSON.parse(body.input)).toEqual({
      term: "entropy",
      context: "information theory",
    });
    expect(body.instructions).toContain("at most five");
    expect(body.instructions).toContain("data, not instructions");
    expect(body.stream).toBeUndefined();
    expect(body.previous_response_id).toBeUndefined();
    expect(String(init?.body)).not.toContain(KEY);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test("bounds sanitized input without splitting supplementary characters", async () => {
    const { service, fetcher } = setup(async () => json(responsePayload()));
    await service.search(
      " \x1b[31m" + "x".repeat(999) + "🙂",
      "\u202e" + "c".repeat(2100),
    );
    const body = JSON.parse(String(fetcher.mock.calls[0]![1]?.body));
    expect(JSON.parse(body.input)).toEqual({
      term: "x".repeat(999),
      context: "c".repeat(2000),
    });
  });

  test("extract requests only the selected source and strips controls", async () => {
    const { service, fetcher } = setup(async () =>
      json({
        results: [
          {
            ...SOURCE,
            title: "\x1b[31mTitle\x1b[0m",
            excerpts: ["\u202ePassage\u202c"],
            full_content: PRIVATE_BODY,
          },
        ],
        errors: [],
      }),
    );
    expect(await service.extract(SOURCE, "entropy", "information")).toEqual({
      ...SOURCE,
      title: "Title",
      excerpts: ["Passage"],
    });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://api.parallel.ai/v1/extract");
    const body = JSON.parse(String(init?.body));
    expect(body.urls).toEqual([SOURCE.url]);
    expect(body.objective).toContain("original passages");
    expect(body.full_content).toBeUndefined();
  });

  test("uses global fetch and trims the key", async () => {
    const fetcher = spyOn(globalThis, "fetch").mockResolvedValue(
      json(responsePayload()),
    );
    await createParallelService(" " + KEY + " ").search("entropy", "");
    expect(
      new Headers(fetcher.mock.calls[0]![1]?.headers).get("x-api-key"),
    ).toBe(KEY);
  });
});

describe("citation parsing", () => {
  const cite = (end: number, url = SOURCE.url, start = 0) => ({
    type: "url_citation",
    title: "Source",
    url,
    start_index: start,
    end_index: end,
  });
  test("deduplicates URLs and annotations, renders each supported span", async () => {
    const { service } = setup(async () =>
      json(
        responsePayload("First. Second.", [
          cite(6),
          cite(6),
          cite(14, "https://example.org/second", 7),
          cite(14),
        ]),
      ),
    );
    const result = await service.search("term", "");
    expect(result.text).toBe("First.¹ Second.¹²");
    expect(result.sources.map((s) => s.url)).toEqual([
      SOURCE.url,
      "https://example.org/second",
    ]);
    expect(result.sources.every((s) => s.excerpts.length === 0)).toBe(true);
  });
  test("places citations after Unicode characters and sanitized control sequences", async () => {
    const raw = "\x1b[31m🙂 definición.\x1b[0m More.";
    const end = Array.from(raw.slice(0, raw.indexOf(" More."))).length;
    const { service } = setup(async () =>
      json(responsePayload(raw, [cite(end)])),
    );
    expect((await service.search("term", "")).text).toBe(
      "🙂 definición.¹ More.",
    );
  });
  test("combines multiple text parts, ignores commentary and tool results", async () => {
    const payload = responsePayload("One.", [cite(4)]);
    payload.output[0]!.content.push({
      type: "output_text",
      text: "Two.",
      annotations: [cite(4)],
    });
    const { service } = setup(async () =>
      json({
        ...payload,
        output: [
          { type: "web_search_call", action: { query: PRIVATE_BODY } },
          {
            type: "message",
            role: "assistant",
            phase: "commentary",
            content: [{ type: "output_text", text: PRIVATE_BODY }],
          },
          ...payload.output,
        ],
      }),
    );
    expect((await service.search("term", "")).text).toBe("One.¹\n\nTwo.¹");
  });
  test("filters unsafe citation URLs and never invents excerpts", async () => {
    const { service } = setup(async () =>
      json(responsePayload("Answer.", [cite(7, "http://127.0.0.1/")])),
    );
    expect((await service.search("term", "")).sources).toEqual([]);
  });
  test("empty answers and refusals are valid no-answer results", async () => {
    for (const output of [
      [],
      [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "refusal", refusal: "No evidence." }],
        },
      ],
    ]) {
      const { service } = setup(async () =>
        json({ status: "completed", output }),
      );
      expect(await service.search("term", "")).toEqual({
        text: "",
        sources: [],
      });
    }
  });
  test.each([-1, 0, 99, 1.5, null])(
    "rejects invalid citation ends: %j",
    async (end) => {
      const { service } = setup(async () =>
        json(responsePayload("text", [{ ...cite(4), end_index: end }])),
      );
      await expect(service.search("term", "")).rejects.toThrow(
        "invalid response format",
      );
    },
  );
  test("rejects more than five sources rather than dropping attribution", async () => {
    const { service } = setup(async () =>
      json(
        responsePayload(
          "text",
          Array.from({ length: 6 }, (_, i) =>
            cite(4, "https://example.org/" + i),
          ),
        ),
      ),
    );
    await expect(service.search("term", "")).rejects.toThrow("more than five");
  });
  test.each([
    null,
    {},
    { output: [] },
    { status: "completed", output: [null] },
    { status: "incomplete", output: [] },
    { status: "failed", output: [], error: { message: PRIVATE_BODY } },
  ])("rejects malformed/incomplete responses: %j", async (payload) => {
    const { service } = setup(async () => json(payload));
    expectPrivate(await rejection(service.search("term", "")));
  });
});

describe("Extract validation", () => {
  test.each([
    "http://localhost/",
    "file:///private",
    "https://user:secret@example.org/",
    "https://10.0.0.1/",
  ])("rejects unsafe URL before sending: %s", async (url) => {
    const { service, fetcher } = setup(async () => json({ results: [] }));
    await expect(
      service.extract({ ...SOURCE, url }, "term", ""),
    ).rejects.toThrow("public http(s)");
    expect(fetcher).not.toHaveBeenCalled();
  });
  test.each([
    null,
    {},
    { results: [null] },
    { results: [{ ...SOURCE, excerpts: null }] },
    { results: [{ ...SOURCE, excerpts: ["text", 42] }] },
  ])("rejects malformed payloads: %j", async (payload) => {
    const { service } = setup(async () => json(payload));
    await expect(service.extract(SOURCE, "term", "")).rejects.toThrow(
      "invalid response format",
    );
  });
  test("does not expose provider error details", async () => {
    const { service } = setup(async () =>
      json({ results: [], errors: [{ message: KEY + PRIVATE_BODY }] }),
    );
    expectPrivate(await rejection(service.extract(SOURCE, "term", "")));
  });
  test("accepts canonical redirects but rejects ambiguous results", async () => {
    const redirected = {
      ...SOURCE,
      url: "https://publisher.example/canonical",
    };
    const { service, fetcher } = setup(async () =>
      json({ results: [redirected] }),
    );
    expect(await service.extract(SOURCE, "term", "")).toEqual(redirected);
    fetcher.mockResolvedValue(
      json({
        results: [redirected, { ...SOURCE, url: "https://another.example/" }],
      }),
    );
    await expect(service.extract(SOURCE, "term", "")).rejects.toThrow(
      "no passages",
    );
  });
});

describe("safe errors", () => {
  for (const operation of OPERATIONS) {
    test.each([
      [401, "key is invalid"],
      [403, "denied access"],
      [429, "request limit"],
      [500, "temporarily unavailable"],
      [502, "temporarily unavailable"],
      [503, "temporarily unavailable"],
      [599, "temporarily unavailable"],
      [400, "HTTP 400"],
      [302, "HTTP 302"],
    ] as const)(
      `${operation}: HTTP %i maps to a safe error`,
      async (status, message) => {
        const response = new Response(`${KEY} ${PRIVATE_BODY}`, {
          status,
          statusText: PRIVATE_BODY,
        });
        const readJson = spyOn(response, "json");
        const readText = spyOn(response, "text");
        const { service, fetcher } = setup(async () => response);
        const error = await rejection(lookup(service, operation));
        expect(error.message).toContain(message);
        expect(error.message).toContain(String(status));
        expectPrivate(error);
        expect(readJson).not.toHaveBeenCalled();
        expect(readText).not.toHaveBeenCalled();
        expect(fetcher).toHaveBeenCalledTimes(1); // No automatic paid retries.
      },
    );

    test(`${operation}: invalid JSON and network errors do not leak keys or bodies`, async () => {
      const { service, fetcher } = setup(
        async () => new Response(`{${KEY} ${PRIVATE_BODY}`),
      );
      let error = await rejection(lookup(service, operation));
      expect(error.message).toContain("invalid JSON");
      expectPrivate(error);
      fetcher.mockRejectedValue(
        new Error(`https://api.parallel.ai/?key=${KEY}: ${PRIVATE_BODY}`),
      );
      error = await rejection(lookup(service, operation));
      expect(error.message).toContain("Could not connect");
      expectPrivate(error);
    });

    test(`${operation}: missing key is actionable and does not make a request`, async () => {
      const fetcher = mock(async () => json({ results: [] }));
      const service = createParallelService(" \n\t ", {
        fetch: fetcher as unknown as typeof fetch,
      });
      const error = await rejection(lookup(service, operation));
      expect(error.message).toContain("PARALLEL_API_KEY is missing");
      expect(fetcher).not.toHaveBeenCalled();
    });
  }

  test.each(OPERATIONS)(
    "%s rejects blank/control-only queries before fetch",
    async (operation) => {
      const { service, fetcher } = setup(async () => json({ results: [] }));
      const promise =
        operation === "search"
          ? service.search(" \x1b[31m\u202e\n\t", "contexto")
          : service.extract(SOURCE, " \x1b[31m\u202e\n\t", "contexto");
      await expect(promise).rejects.toThrow("Type a term");
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  test.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])(
    "rejects invalid timeout: %s",
    (timeoutMs) => {
      const fetcher = mock(async () => json({ results: [] }));
      expect(() =>
        createParallelService(KEY, {
          fetch: fetcher as unknown as typeof fetch,
          timeoutMs,
        }),
      ).toThrow("timeout");
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
});

describe("abort, deadlines and cleanup", () => {
  test.each(OPERATIONS)(
    "%s rejects pre-aborted signals before fetch and hides the reason",
    async (operation) => {
      const controller = new AbortController();
      controller.abort(new Error(`${KEY} ${PRIVATE_BODY}`));
      const { service, fetcher } = setup(async () => json({ results: [] }));
      const error = await rejection(
        lookup(service, operation, controller.signal),
      );
      expect(error.name).toBe("AbortError");
      expect(error.message).toBe("Lookup cancelled.");
      expectPrivate(error);
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  test.each(OPERATIONS)(
    "%s cancels even when fetch ignores the signal",
    async (operation) => {
      const pending = deferred<Response>();
      const controller = new AbortController();
      const { service, fetcher } = setup(() => pending.promise);
      const promise = lookup(service, operation, controller.signal);
      const upstreamSignal = fetcher.mock.calls[0]![1]?.signal;
      expect(upstreamSignal).not.toBe(controller.signal);
      expect(upstreamSignal?.aborted).toBe(false);
      controller.abort(new Error(`${KEY} ${PRIVATE_BODY}`));
      const error = await rejection(promise);
      expect(error.name).toBe("AbortError");
      expectPrivate(error);
      expect(upstreamSignal?.aborted).toBe(true);
      pending.reject(new Error(`${KEY} ${PRIVATE_BODY}`)); // Late rejection is handled.
      await Promise.resolve();
    },
  );

  test("cancellation wins over a fetch abort rejection containing sensitive data", async () => {
    const controller = new AbortController();
    const { service } = setup(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new Error(`${KEY} ${PRIVATE_BODY}`)),
            { once: true },
          );
        }),
    );
    const promise = service.search("término", "", controller.signal);
    controller.abort();
    const error = await rejection(promise);
    expect(error.name).toBe("AbortError");
    expectPrivate(error);
  });

  test.each(OPERATIONS)(
    "%s enforces a deterministic timeout even if fetch never settles",
    async (operation) => {
      const timer = deadline();
      const pending = deferred<Response>();
      const { service, fetcher } = setup(() => pending.promise, 321);
      const promise = lookup(service, operation);
      expect(timer.schedule).toHaveBeenCalledWith(expect.any(Function), 321);
      timer.fire();
      const error = await rejection(promise);
      expect(error.name).toBe("TimeoutError");
      expect(error.message).toContain("did not respond within");
      expectPrivate(error);
      expect(fetcher.mock.calls[0]![1]?.signal?.aborted).toBe(true);
      expect(timer.clear).toHaveBeenCalledWith(timer.handle);
      pending.resolve(json(responsePayload()));
      await Promise.resolve();
    },
  );

  test.each(["abort", "timeout"] as const)(
    "%s remains effective during response JSON reading",
    async (mode) => {
      const timer = deadline();
      const body = deferred<unknown>();
      const response = json(responsePayload());
      const readJson = spyOn(response, "json").mockImplementation(
        () => body.promise,
      );
      const controller = new AbortController();
      const { service } = setup(async () => response);
      const promise = service.search("término", "", controller.signal);
      await Promise.resolve();
      expect(readJson).toHaveBeenCalledTimes(1);
      if (mode === "abort")
        controller.abort(new Error(`${KEY} ${PRIVATE_BODY}`));
      else timer.fire();
      const error = await rejection(promise);
      expect(error.name).toBe(mode === "abort" ? "AbortError" : "TimeoutError");
      expectPrivate(error);
      expect(timer.clear).toHaveBeenCalledWith(timer.handle);
      body.reject(new Error(`${KEY} ${PRIVATE_BODY}`));
      await Promise.resolve();
    },
  );

  test.each([
    "success",
    "http",
    "schema",
    "json",
    "network",
    "abort",
    "timeout",
  ] as const)(
    "cleans up timers and caller listeners after %s",
    async (outcome) => {
      const timer = deadline();
      const controller = new AbortController();
      const add = spyOn(controller.signal, "addEventListener");
      const remove = spyOn(controller.signal, "removeEventListener");
      const pending = deferred<Response>();
      const { service } = setup(async () => {
        if (outcome === "http") return json({}, 503);
        if (outcome === "schema") return json({ results: [null] });
        if (outcome === "json") return new Response("{");
        if (outcome === "network") throw new Error(PRIVATE_BODY);
        if (outcome === "abort" || outcome === "timeout")
          return pending.promise;
        return json(responsePayload());
      });
      const promise = service.search("término", "", controller.signal);
      expect(timer.schedule).toHaveBeenCalledWith(expect.any(Function), 30_000);
      if (outcome === "abort") controller.abort();
      if (outcome === "timeout") timer.fire();
      if (outcome === "success") expect(await promise).toEqual(answer);
      else await rejection(promise);
      const handler = add.mock.calls[0]![1];
      expect(add).toHaveBeenCalledWith("abort", handler, { once: true });
      expect(remove).toHaveBeenCalledWith("abort", handler);
      expect(timer.clear).toHaveBeenCalledTimes(1);
      expect(timer.clear).toHaveBeenCalledWith(timer.handle);
      pending.resolve(json({ results: [] }));
      await Promise.resolve();
    },
  );

  test("simultaneous requests have independent cancellation", async () => {
    const first = deferred<Response>();
    const controller = new AbortController();
    const { service, fetcher } = setup(() => first.promise);
    const cancelled = service.search("uno", "", controller.signal);
    fetcher.mockResolvedValue(json(responsePayload()));
    const successful = service.search("dos", "");
    controller.abort();
    expect((await rejection(cancelled)).name).toBe("AbortError");
    expect(await successful).toEqual(answer);
    expect(fetcher.mock.calls[1]![1]?.signal?.aborted).toBe(false);
    first.resolve(json({ results: [] }));
    await Promise.resolve();
  });
});
