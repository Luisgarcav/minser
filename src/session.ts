import { boundedText, type Answer, type LookupService } from "./parallel";
import { safePublicUrl, sanitizeText } from "./text";

export type Entry = Answer & {
  term: string;
  context: string;
  expanded: string[];
};
export type SessionState = {
  entry: Entry | null;
  selected: number;
  busy: "search" | "extract" | null;
  error: string | null;
  cached: boolean;
  openCitation: number | null;
  errorKind: "search" | "extract" | null;
};

const LIMIT = 20;
const cacheKey = (term: string, context: string) =>
  JSON.stringify([term, context]);

/** A bounded, memory-only session. No history, source text or credentials on disk. */
export class LookupSession {
  state: SessionState = {
    entry: null,
    selected: 0,
    busy: null,
    error: null,
    cached: false,
    openCitation: null,
    errorKind: null,
  };
  private listeners = new Set<(state: SessionState) => void>();
  private cache = new Map<string, Entry>();
  private history: Entry[] = [];
  private controller: AbortController | undefined;
  private generation = 0;

  constructor(private service: LookupService) {}

  subscribe(listener: (state: SessionState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private update(patch: Partial<SessionState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
  }

  private remember(entry: Entry) {
    const key = cacheKey(entry.term, entry.context);
    this.cache.delete(key);
    this.cache.set(key, entry);
    if (this.cache.size > LIMIT)
      this.cache.delete(this.cache.keys().next().value!);
  }

  private commit(entry: Entry, cached: boolean) {
    const previous = this.state.entry;
    if (
      previous &&
      cacheKey(previous.term, previous.context) !==
        cacheKey(entry.term, entry.context)
    ) {
      this.history.push(previous);
      if (this.history.length > LIMIT) this.history.shift();
    }
    this.remember(entry);
    this.update({
      entry,
      selected: 0,
      openCitation: null,
      busy: null,
      error: null,
      errorKind: null,
      cached,
    });
  }

  cancel() {
    this.generation++;
    this.controller?.abort();
    this.controller = undefined;
    this.update({
      busy: null,
      ...(this.state.busy === "extract" ? { openCitation: null } : {}),
    });
  }

  private begin(busy: "search" | "extract") {
    this.cancel();
    this.controller = new AbortController();
    this.update({ busy, error: null, errorKind: null, cached: false });
    return { generation: this.generation, signal: this.controller.signal };
  }

  private fail(error: unknown, generation: number) {
    if (generation !== this.generation) return;
    this.update({
      errorKind: this.state.busy,
      busy: null,
      error:
        error instanceof Error
          ? sanitizeText(error.message)
          : "The lookup could not be completed.",
    });
  }

  async search(rawTerm: string, rawContext = "") {
    const term = boundedText(rawTerm, 1000);
    const context = boundedText(rawContext, 2000);
    if (!term) {
      this.cancel();
      this.update({ error: "Type a term to look up.", errorKind: "search" });
      return;
    }
    const task = this.begin("search");
    this.update({ openCitation: null });
    const cached = this.cache.get(cacheKey(term, context));
    if (cached) {
      this.commit(cached, true);
      return;
    }
    try {
      const isUrl = /^[a-z][a-z\d+.-]*:\/\//i.test(term);
      if (isUrl && !safePublicUrl(term))
        throw new Error("Use a public http(s) URL without credentials.");
      const answer = await this.service.search(term, context, task.signal);
      if (task.generation !== this.generation) return;
      this.commit(
        {
          term,
          context,
          ...answer,
          expanded: [],
        },
        false,
      );
    } catch (error) {
      this.fail(error, task.generation);
    }
  }

  select(index: number) {
    if (!Number.isInteger(index) || !this.state.entry?.sources[index]) return;
    this.update({ selected: index });
  }

  async toggleCitation(index: number) {
    if (
      !Number.isInteger(index) ||
      !this.state.entry?.sources[index] ||
      this.state.busy === "search"
    )
      return;
    const closing = this.state.openCitation === index;
    if (this.state.busy === "extract") this.cancel();
    if (closing) {
      this.update({ openCitation: null, error: null, errorKind: null });
      return;
    }
    this.update({ selected: index, openCitation: index });
    await this.readSelected();
  }

  async readSelected() {
    const entry = this.state.entry;
    const source = entry?.sources[this.state.selected];
    if (!entry || !source || this.state.busy) return;
    if (entry.expanded.includes(source.url)) {
      this.update({ cached: true, error: null, errorKind: null });
      return;
    }
    const index = this.state.selected;
    const task = this.begin("extract");
    try {
      const detailed = await this.service.extract(
        source,
        entry.term,
        entry.context,
        task.signal,
      );
      if (task.generation !== this.generation) return;
      const sources = [...entry.sources];
      // Preserve citation identity even when Extract follows a canonical redirect.
      sources[index] = { ...source, excerpts: detailed.excerpts };
      const next = {
        ...entry,
        sources,
        expanded: [...entry.expanded, source.url],
      };
      this.remember(next);
      this.update({ entry: next, busy: null });
    } catch (error) {
      this.fail(error, task.generation);
    }
  }

  back(): Entry | null {
    const restoreCurrent =
      this.state.busy === "search" || this.state.errorKind === "search";
    this.cancel();
    const entry =
      restoreCurrent && this.state.entry
        ? this.state.entry
        : this.history.pop();
    if (!entry) return null;
    const latest = this.cache.get(cacheKey(entry.term, entry.context)) ?? entry;
    this.update({
      entry: latest,
      selected: 0,
      openCitation: null,
      error: null,
      errorKind: null,
      cached: true,
    });
    return latest;
  }

  dispose() {
    this.cancel();
    this.listeners.clear();
    this.cache.clear();
    this.history = [];
  }
}
