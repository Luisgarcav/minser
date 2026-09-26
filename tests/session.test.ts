import { describe, expect, mock, test } from "bun:test";
import type { Answer, LookupService, Source } from "../src/parallel";
import { LookupSession } from "../src/session";

function setup() {
  const sources: Source[] = [
    {
      title: "Primera fuente",
      url: "https://example.org/first",
      excerpts: ["Primer pasaje."],
    },
    {
      title: "Segunda fuente",
      url: "https://example.org/second",
      excerpts: ["Segundo pasaje."],
    },
  ];
  const search = mock<LookupService["search"]>(async () => ({
    text: "Answer.¹²",
    sources,
  }));
  const extract = mock<LookupService["extract"]>(async (source) => ({
    ...source,
    excerpts: [...source.excerpts, "Pasaje ampliado."],
  }));
  const session = new LookupSession({ search, extract });
  return { session, search, extract, sources };
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

type Operation = "search" | "extract";

// These services deliberately ignore abort: only the session can reject stale work.
function startPending(fixture: ReturnType<typeof setup>, operation: Operation) {
  const pending = deferred<Source>();
  const { session, search, extract } = fixture;
  let task: Promise<void>;
  let signal: AbortSignal | undefined;
  if (operation === "search") {
    search.mockReturnValueOnce(
      pending.promise.then((source) => ({
        text: "Answer.¹",
        sources: [source],
      })),
    );
    task = session.search("pendiente", "contexto pendiente");
    signal = search.mock.calls.at(-1)![2];
  } else {
    extract.mockReturnValueOnce(pending.promise);
    task = session.readSelected();
    signal = extract.mock.calls.at(-1)![3];
  }
  expect(signal).toBeInstanceOf(AbortSignal);
  expect(signal!.aborted).toBe(false);
  return { ...pending, task, signal: signal! };
}

describe("LookupSession actions and cache", () => {
  test("starts idle and searches with sanitized term/context, without extracting", async () => {
    const { session, search, extract, sources } = setup();
    expect(session.state).toMatchObject({
      entry: null,
      selected: 0,
      busy: null,
      error: null,
      cached: false,
    });
    expect(search).not.toHaveBeenCalled();
    expect(extract).not.toHaveBeenCalled();

    const listener = mock(() => {});
    const unsubscribe = session.subscribe(listener);
    const pending = deferred<Answer>();
    search.mockReturnValueOnce(pending.promise);
    const task = session.search(
      " \x1b[31mentropía\x1b[0m \n",
      " \u202etermodinámica\u202c\t ",
    );
    expect(session.state.busy).toBe("search");
    expect(session.state.entry).toBeNull();
    expect(search).toHaveBeenCalledWith(
      "entropía",
      "termodinámica",
      expect.any(AbortSignal),
    );
    pending.resolve({ text: "Answer.¹²", sources });
    await task;
    expect(session.state).toMatchObject({
      entry: {
        term: "entropía",
        context: "termodinámica",
        sources,
        expanded: [],
      },
      selected: 0,
      busy: null,
      error: null,
      cached: false,
    });
    expect(listener).toHaveBeenLastCalledWith(session.state);
    expect(extract).not.toHaveBeenCalled();
    unsubscribe();
    const calls = listener.mock.calls.length;
    session.select(1);
    expect(listener).toHaveBeenCalledTimes(calls);
  });

  test("selects locally and extracts only the explicitly requested source", async () => {
    const { session, search, extract, sources } = setup();
    await session.search("entropía", "información");
    session.select(1);
    for (const index of [-1, 2, 0.5, NaN, Infinity]) session.select(index);
    expect(session.state.selected).toBe(1);
    expect(extract).not.toHaveBeenCalled();

    const detailed = { ...sources[1]!, excerpts: ["Detalle de la segunda."] };
    const pending = deferred<Source>();
    extract.mockReturnValueOnce(pending.promise);
    const task = session.readSelected();
    expect(session.state.busy).toBe("extract");
    expect(extract).toHaveBeenCalledWith(
      sources[1],
      "entropía",
      "información",
      expect.any(AbortSignal),
    );
    await session.readSelected();
    expect(extract).toHaveBeenCalledTimes(1);
    // Moving the selection while waiting must not write into the wrong row.
    session.select(0);
    pending.resolve(detailed);
    await task;
    expect(session.state.entry?.sources).toEqual([sources[0]!, detailed]);
    expect(session.state.entry?.expanded).toEqual([detailed.url]);
    expect(session.state.selected).toBe(0);
    expect(session.state.busy).toBeNull();
    expect(sources[1]!.excerpts).toEqual(["Segundo pasaje."]);
    expect(search).toHaveBeenCalledTimes(1);
  });

  test("reuses search and extraction memory cache, keyed by term AND context", async () => {
    const { session, search, extract, sources } = setup();
    await session.search("entropía", "física");
    session.select(1);
    await session.readSelected();
    const expanded = session.state.entry;
    await session.readSelected();
    expect(session.state.cached).toBe(true);
    expect(extract).toHaveBeenCalledTimes(1);

    await session.search(" entropía ", " física ");
    expect(session.state.entry).toBe(expanded);
    expect(session.state.selected).toBe(0);
    expect(session.state.cached).toBe(true);
    expect(search).toHaveBeenCalledTimes(1);
    session.select(1);
    await session.readSelected();
    expect(extract).toHaveBeenCalledTimes(1);

    await session.search("entropía", "información");
    expect(search).toHaveBeenCalledTimes(2);
    expect(session.state.cached).toBe(false);
    expect(session.state.entry?.sources).toEqual(sources);
    expect(session.state.entry?.expanded).toEqual([]);
    await session.search("entropía", "física");
    expect(session.state.entry).toBe(expanded);
    expect(search).toHaveBeenCalledTimes(2);
    expect(extract).toHaveBeenCalledTimes(1);

    const separateSession = new LookupSession({ search, extract });
    await separateSession.search("entropía", "física");
    expect(search).toHaveBeenCalledTimes(3);
    expect(separateSession.state.cached).toBe(false);
    expect(separateSession.state.entry?.expanded).toEqual([]);
  });

  test("back restores the previous query, context and expanded passages without requests", async () => {
    const { session, search, extract } = setup();
    expect(session.back()).toBeNull();
    await session.search("entropía", "física");
    session.select(1);
    await session.readSelected();
    const previous = session.state.entry;
    await session.search("entropía", "información");
    await session.search("entropía", "información");
    expect(session.back()).toBe(previous);
    expect(session.state).toMatchObject({
      entry: previous,
      selected: 0,
      busy: null,
      error: null,
      cached: true,
    });
    expect(session.back()).toBeNull();
    expect(session.state.entry).toBe(previous);
    expect(search).toHaveBeenCalledTimes(2);
    expect(extract).toHaveBeenCalledTimes(1);
  });

  test("bounds the memory cache and query history to twenty entries", async () => {
    const { session, search, extract } = setup();
    for (let i = 0; i <= 21; i++) await session.search(`consulta ${i}`);
    await session.search("consulta 21");
    expect(session.state.cached).toBe(true);
    expect(search).toHaveBeenCalledTimes(22);
    for (let i = 20; i >= 1; i--) {
      expect(session.back()?.term).toBe(`consulta ${i}`);
    }
    expect(session.back()).toBeNull();
    await session.search("consulta 0");
    expect(search).toHaveBeenCalledTimes(23);
    expect(session.state.cached).toBe(false);
    expect(extract).not.toHaveBeenCalled();
  });

  test("a public URL also requests a synthesis; Extract remains explicit", async () => {
    const { session, search, extract } = setup();
    await session.search("https://example.org/paper", "physics");
    expect(search).toHaveBeenCalledWith(
      "https://example.org/paper",
      "physics",
      expect.any(AbortSignal),
    );
    expect(extract).not.toHaveBeenCalled();
  });

  test("number keys toggle a citation and reuse passages after closing", async () => {
    const { session, extract } = setup();
    await session.search("entropy");
    await session.toggleCitation(1);
    expect(session.state.openCitation).toBe(1);
    await session.toggleCitation(1);
    expect(session.state.openCitation).toBeNull();
    await session.toggleCitation(1);
    expect(session.state.openCitation).toBe(1);
    expect(extract).toHaveBeenCalledTimes(1);
    await session.toggleCitation(0);
    expect(session.state.openCitation).toBe(0);
    expect(extract).toHaveBeenCalledTimes(2);
    for (const index of [-1, 9, NaN, 0.5]) await session.toggleCitation(index);
    expect(extract).toHaveBeenCalledTimes(2);
  });

  test("canonical extraction redirects preserve citation identity and caching", async () => {
    const { session, extract, sources } = setup();
    await session.search("entropy");
    extract.mockResolvedValueOnce({
      ...sources[0]!,
      url: "https://example.org/canonical",
      title: "New title",
      excerpts: ["Passage"],
    });
    await session.toggleCitation(0);
    expect(session.state.entry!.sources[0]).toEqual({
      ...sources[0]!,
      excerpts: ["Passage"],
    });
    await session.toggleCitation(0);
    await session.toggleCitation(0);
    expect(extract).toHaveBeenCalledTimes(1);
  });

  test("closing a pending citation cancels it and ignores late passages", async () => {
    const { session, extract, sources } = setup();
    await session.search("entropy");
    const pending = deferred<Source>();
    extract.mockReturnValueOnce(pending.promise);
    const task = session.toggleCitation(0);
    const signal = extract.mock.calls[0]![3]!;
    await session.toggleCitation(0);
    expect(signal.aborted).toBe(true);
    expect(session.state.openCitation).toBeNull();
    pending.resolve({ ...sources[0]!, excerpts: ["Late passage"] });
    await task;
    expect(session.state.entry!.expanded).toEqual([]);
    expect(session.state.entry!.sources[0]!.excerpts).not.toContain(
      "Late passage",
    );
    await session.toggleCitation(0);
    expect(extract).toHaveBeenCalledTimes(2);
  });

  test("back after a failed query restores the most recent answer", async () => {
    const { session, search } = setup();
    await session.search("first");
    await session.search("second");
    const previous = session.state.entry;
    search.mockRejectedValueOnce(new Error("Offline"));
    await session.search("third");
    expect(session.back()).toBe(previous);
    expect(session.state.error).toBeNull();
    expect(session.back()!.term).toBe("first");
  });

  test.each([
    "https://localhost/",
    "https://user:secret@example.org/",
    "file:///etc/passwd",
    "https://example.org:99999/",
  ])(
    "rejects an unsafe or malformed URL before calling the service: %s",
    async (url) => {
      const { session, search, extract } = setup();
      await session.search(url);
      expect(session.state.entry).toBeNull();
      expect(session.state.busy).toBeNull();
      expect(session.state.error).toContain(
        "public http(s) URL without credentials",
      );
      expect(search).not.toHaveBeenCalled();
      expect(extract).not.toHaveBeenCalled();
    },
  );
});

describe("LookupSession empty input and errors", () => {
  test("does not extract without an entry or source, and caches empty results", async () => {
    const { session, search, extract } = setup();
    session.select(0);
    await session.readSelected();
    expect(search).not.toHaveBeenCalled();
    expect(extract).not.toHaveBeenCalled();
    search.mockResolvedValueOnce({ text: "", sources: [] });
    await session.search("sin resultados");
    expect(search).toHaveBeenCalledWith(
      "sin resultados",
      "",
      expect.any(AbortSignal),
    );
    expect(session.state.entry?.sources).toEqual([]);
    expect(session.state.error).toBeNull();
    session.select(0);
    await session.readSelected();
    await session.search("sin resultados");
    expect(session.state.cached).toBe(true);
    expect(search).toHaveBeenCalledTimes(1);
    expect(extract).not.toHaveBeenCalled();
  });

  test("empty input aborts pending work but preserves the last entry", async () => {
    const fixture = setup();
    const { session, search, sources } = fixture;
    await session.search("anterior");
    const previous = session.state.entry;
    const pending = startPending(fixture, "search");
    for (const input of ["", " \n\t ", "\x1b[31m\x1b[0m\u202e"]) {
      await session.search(input);
      expect(session.state.entry).toBe(previous);
      expect(session.state.busy).toBeNull();
      expect(session.state.error).toContain("Type a term");
    }
    expect(pending.signal.aborted).toBe(true);
    const state = session.state;
    pending.resolve(sources[1]!);
    await pending.task;
    expect(session.state).toBe(state);
    expect(search).toHaveBeenCalledTimes(2);
    await session.search("nueva");
    expect(session.state.error).toBeNull();
  });

  test("search errors, including a missing key, are sanitized and never cached", async () => {
    const { session, search } = setup();
    await session.search("anterior");
    session.select(1);
    const previous = session.state.entry;
    search.mockRejectedValueOnce(
      new Error("\x1b[31mFalta PARALLEL_API_KEY.\x1b[0m\u202e"),
    );
    await session.search("nueva");
    expect(session.state).toMatchObject({
      entry: previous,
      selected: 1,
      busy: null,
      error: "Falta PARALLEL_API_KEY.",
      cached: false,
    });
    await session.search("nueva");
    expect(search).toHaveBeenCalledTimes(3);
    expect(session.state.entry?.term).toBe("nueva");
    expect(session.state.error).toBeNull();
  });

  test("unknown extraction failures preserve excerpts and permit an explicit retry", async () => {
    const { session, extract, sources } = setup();
    await session.search("entropía");
    const previous = session.state.entry;
    extract.mockRejectedValueOnce({ privateDetail: "not a displayable error" });
    await session.readSelected();
    expect(session.state.entry).toBe(previous);
    expect(session.state.entry?.expanded).toEqual([]);
    expect(session.state.busy).toBeNull();
    expect(session.state.error).toBe("The lookup could not be completed.");
    await session.readSelected();
    expect(extract).toHaveBeenCalledTimes(2);
    expect(session.state.entry?.expanded).toEqual([sources[0]!.url]);
    expect(session.state.error).toBeNull();
  });
});

describe("LookupSession cancellation and stale promises", () => {
  test.each([
    ["search", "resolve"],
    ["search", "reject"],
    ["extract", "resolve"],
    ["extract", "reject"],
  ] as const)(
    "cancel aborts %s and ignores a late %s",
    async (operation, outcome) => {
      const fixture = setup();
      const { session, search, extract, sources } = fixture;
      await session.search("anterior");
      const previous = session.state.entry;
      const pending = startPending(fixture, operation);
      expect(session.state.busy).toBe(operation);
      session.cancel();
      expect(pending.signal.aborted).toBe(true);
      expect(session.state.busy).toBeNull();
      expect(session.state.entry).toBe(previous);
      expect(session.state.error).toBeNull();
      const state = session.state;
      if (outcome === "resolve") pending.resolve(sources[1]!);
      else pending.reject(new Error("fallo tardío"));
      await pending.task;
      expect(session.state).toBe(state);
      if (operation === "search") {
        await session.search("pendiente", "contexto pendiente");
        expect(search).toHaveBeenCalledTimes(3);
      } else {
        await session.readSelected();
        expect(extract).toHaveBeenCalledTimes(2);
      }
      expect(session.state.cached).toBe(false);
      expect(session.state.error).toBeNull();
    },
  );

  test.each(["resolve", "reject"] as const)(
    "a newer search wins over an older search's late %s",
    async (outcome) => {
      const fixture = setup();
      const { session, search, sources } = fixture;
      const pending = startPending(fixture, "search");
      search.mockResolvedValueOnce({
        text: "Answer.¹",
        sources: [sources[0]!],
      });
      await session.search("actual", "contexto actual");
      expect(pending.signal.aborted).toBe(true);
      const current = session.state;
      expect(current.entry?.term).toBe("actual");
      if (outcome === "resolve") pending.resolve(sources[1]!);
      else pending.reject(new Error("fallo de la consulta anterior"));
      await pending.task;
      expect(session.state).toBe(current);
      await session.search("pendiente", "contexto pendiente");
      expect(search).toHaveBeenCalledTimes(3);
      expect(session.state.cached).toBe(false);
    },
  );

  test("a stale rejection cannot clear the busy state of a newer pending search", async () => {
    const fixture = setup();
    const { session, search, sources } = fixture;
    const old = startPending(fixture, "search");
    const current = deferred<Answer>();
    search.mockReturnValueOnce(current.promise);
    const task = session.search("actual");
    const state = session.state;
    old.reject(new Error("fallo anterior"));
    await old.task;
    expect(old.signal.aborted).toBe(true);
    expect(session.state).toBe(state);
    expect(session.state.busy).toBe("search");
    expect(session.state.error).toBeNull();
    current.resolve({ text: "Answer.¹", sources: [sources[0]!] });
    await task;
    expect(session.state.entry?.term).toBe("actual");
    expect(session.state.busy).toBeNull();
  });

  test("a search supersedes extraction without letting late passages pollute the cache", async () => {
    const fixture = setup();
    const { session, search, extract, sources } = fixture;
    await session.search("anterior");
    const previous = session.state.entry;
    const pending = startPending(fixture, "extract");
    await session.search("actual");
    const current = session.state;
    expect(pending.signal.aborted).toBe(true);
    pending.resolve({ ...sources[0]!, excerpts: ["Pasaje tardío."] });
    await pending.task;
    expect(session.state).toBe(current);
    await session.search("anterior");
    expect(session.state.entry).toBe(previous);
    expect(session.state.entry?.expanded).toEqual([]);
    expect(search).toHaveBeenCalledTimes(2);
    await session.readSelected();
    expect(extract).toHaveBeenCalledTimes(2);
  });

  test("back cancels a pending lookup before restoring the previous query", async () => {
    const fixture = setup();
    const { session, search, sources } = fixture;
    await session.search("primera", "contexto primero");
    await session.search("segunda");
    const previous = session.state.entry;
    const pending = startPending(fixture, "search");
    expect(session.back()).toBe(previous);
    expect(pending.signal.aborted).toBe(true);
    const restored = session.state;
    pending.resolve(sources[1]!);
    await pending.task;
    expect(session.state).toBe(restored);
    expect(session.state.busy).toBeNull();
    expect(search).toHaveBeenCalledTimes(3);
  });

  test.each(["search", "extract"] as const)(
    "dispose aborts pending %s, removes listeners and ignores late results",
    async (operation) => {
      const fixture = setup();
      const { session, sources } = fixture;
      await session.search("anterior");
      const listener = mock(() => {});
      session.subscribe(listener);
      const pending = startPending(fixture, operation);
      session.dispose();
      expect(pending.signal.aborted).toBe(true);
      expect(session.state.busy).toBeNull();
      const state = session.state;
      const calls = listener.mock.calls.length;
      pending.resolve(sources[1]!);
      await pending.task;
      expect(session.state).toBe(state);
      expect(listener).toHaveBeenCalledTimes(calls);
      session.dispose();
      expect(listener).toHaveBeenCalledTimes(calls);
    },
  );
});
