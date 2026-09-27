import { DEFAULT_EFFORT, parseEffort, type Effort } from "./effort";
import { boundedText, type Answer, type LookupService } from "./parallel";
import { safePublicUrl, sanitizeText } from "./text";

export type FollowUpTarget = {
  responseId: string;
  term: string;
  context: string;
};
export type Entry = Answer & {
  term: string;
  context: string;
  effort: Effort;
  expanded: string[];
  previousResponseId?: string;
  followUpTo?: string;
};
export type SessionState = {
  effort: Effort;
  entry: Entry | null;
  followUp: FollowUpTarget | null;
  selected: number;
  busy: "search" | "extract" | null;
  error: string | null;
  cached: boolean;
  openCitation: number | null;
  errorKind: "search" | "extract" | null;
};

const LIMIT = 20;
const cacheKey = ({
  term,
  context,
  effort,
  previousResponseId,
}: Pick<Entry, "term" | "context" | "effort" | "previousResponseId">) =>
  JSON.stringify([term, context, effort, previousResponseId]);

/** A bounded, memory-only session. No history, source text or credentials on disk. */
export class LookupSession {
  state: SessionState = {
    effort: DEFAULT_EFFORT,
    entry: null,
    followUp: null,
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

  constructor(
    private service: LookupService,
    initialEffort: Effort = DEFAULT_EFFORT,
  ) {
    this.state.effort = parseEffort(initialEffort);
  }

  subscribe(listener: (state: SessionState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private update(patch: Partial<SessionState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
  }

  private remember(entry: Entry) {
    const key = cacheKey(entry);
    this.cache.delete(key);
    this.cache.set(key, entry);
    if (this.cache.size > LIMIT)
      this.cache.delete(this.cache.keys().next().value!);
  }

  private preserveCurrent(next?: Entry) {
    const previous = this.state.entry;
    if (!previous) return;
    if (next && cacheKey(previous) === cacheKey(next)) return;
    this.history.push(previous);
    if (this.history.length > LIMIT) this.history.shift();
  }

  private commit(entry: Entry, cached: boolean) {
    this.preserveCurrent(entry);
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

  startFollowUp(): boolean {
    const entry = this.state.entry;
    if (
      this.state.busy ||
      !entry?.responseId?.trim() ||
      !entry.text.trim() ||
      !entry.sources.length
    )
      return false;
    this.update({
      followUp: {
        responseId: entry.responseId,
        term: entry.term,
        context: entry.context,
      },
      error: null,
      errorKind: null,
      openCitation: null,
    });
    return true;
  }

  startNewLookup(): void {
    this.cancel();
    this.update({
      followUp: null,
      error: null,
      errorKind: null,
      openCitation: null,
    });
  }

  setEffort(effort: Effort): boolean {
    if (effort === this.state.effort) return false;
    const nextEffort = parseEffort(effort);
    this.cancel();
    this.preserveCurrent();
    this.update({
      effort: nextEffort,
      entry: null,
      selected: 0,
      cached: false,
      error: null,
      errorKind: null,
      openCitation: null,
    });
    return true;
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
    const { effort, followUp } = this.state;
    const term = boundedText(rawTerm, 1000);
    const context = followUp?.context ?? boundedText(rawContext, 2000);
    if (!term) {
      this.cancel();
      this.update({ error: "Type a term to look up.", errorKind: "search" });
      return;
    }
    const query = {
      term,
      context,
      effort,
      ...(followUp
        ? {
            previousResponseId: followUp.responseId,
            followUpTo: followUp.term,
          }
        : {}),
    };
    const task = this.begin("search");
    this.update({ openCitation: null });
    const cached = this.cache.get(cacheKey(query));
    if (cached) {
      this.commit(cached, true);
      return;
    }
    try {
      const isUrl = /^[a-z][a-z\d+.-]*:\/\//i.test(term);
      if (isUrl && !safePublicUrl(term))
        throw new Error("Use a public http(s) URL without credentials.");
      const answer = followUp
        ? await this.service.search(
            term,
            context,
            task.signal,
            effort,
            followUp.responseId,
          )
        : await this.service.search(term, context, task.signal, effort);
      if (task.generation !== this.generation) return;
      this.commit({ ...answer, ...query, expanded: [] }, false);
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

  back(restoreCurrent = false): Entry | null {
    const keepCurrent =
      restoreCurrent ||
      this.state.busy === "search" ||
      this.state.errorKind === "search";
    this.cancel();
    const entry =
      keepCurrent && this.state.entry ? this.state.entry : this.history.pop();
    if (!entry) return null;
    const latest = this.cache.get(cacheKey(entry)) ?? entry;
    this.update({
      entry: latest,
      effort: latest.effort,
      followUp: latest.previousResponseId
        ? {
            responseId: latest.previousResponseId,
            term: latest.followUpTo ?? "",
            context: latest.context,
          }
        : null,
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
