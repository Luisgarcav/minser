# minser

Look a term up, then get back to your reading. A small TUI that answers with a
short synthesis and the citations it rests on — no browser, no tabs, no feed.

Bun + TypeScript + Solid + OpenTUI. Parallel does the research: the **Responses
API** returns the answer with its citations, and **Extract** pulls passages from
a single source when you ask for them.

The interface follows the minser screens in Paper: one reading column, a short
answer and numbered citations. Surfaces are transparent and colors follow your
terminal's background, foreground and ANSI palette. Font family and line height
are controlled by your terminal; IBM Plex Mono matches Paper.

## Getting started

Requires Bun 1.4.1 or later and an interactive terminal, 80×24 or larger.

```sh
git clone https://github.com/Luisgarcav/minser.git
cd minser
bun install --frozen-lockfile
bun run demo
```

The demo needs no key and no network. It always shows the same fixed example
about entropy, whatever you type. Its text is illustrative: it was not
downloaded from the URLs it shows.

## Real lookups

Create a key at [Parallel](https://platform.parallel.ai/) and set up the
environment:

```sh
cp .env.example .env
# Edit .env and set PARALLEL_API_KEY. Do not share that key.
bun run start
```

Bun loads `.env` automatically. You can also set `PARALLEL_API_KEY` in your
environment. `.env` is excluded from Git; `.env.example` holds no key.

```sh
bun run start "entropy : information theory"
bun run start --help
```

Arguments prefill the term. Nothing is requested at startup or while you type,
including in demo mode. Press Enter to start the lookup.

## The flow

1. Type a term. If it is ambiguous, add the topic after a colon:
   `entropy : information theory`.
2. Press Enter. minser asks Parallel's Responses API.
3. You get a short synthesis. Superscript markers — ¹ ² ³ — tie each claim to
   the source that supports it.
4. Below a rule, the numbered citations: host and page title.
5. Press `1`–`5` to pull passages from that source, via Extract. One request,
   only for the one you asked about.
6. Press `q` and go back to your reading.

Once results arrive, focus leaves the input and keys become commands. `/` puts
you back in the term field.

| Key          | Action                                                    |
| ------------ | --------------------------------------------------------- |
| Enter        | Look up (while editing) / retry (after a failure)         |
| `1`–`5`      | Expand that citation's passages — press again to collapse |
| ↑ / ↓        | Scroll the reading column                                 |
| PgUp / PgDn  | Scroll by page                                            |
| `/`          | Edit the term again                                       |
| Ctrl+B       | Recall the previous lookup of this session                |
| Esc          | Cancel a pending request, or leave editing                |
| `q` / Ctrl+C | Quit                                                      |

While editing, letters and numbers go into the query. Press Esc to leave
editing before using `q`, or use Ctrl+C at any time. Only one citation is open
at a time. Enter retries a failed extraction as well as a failed lookup.

## What Parallel returns

The Responses API is OpenAI-compatible: base URL `https://api.parallel.ai/v1`,
a single model id `parallel`, and `reasoning.effort` picking the depth tier. It
can be called with an OpenAI SDK, but minser posts to `/v1/responses` directly
and keeps its dependency list empty of HTTP clients.

Citations come back as annotations on the answer text, at
`message.content[].annotations[]`:

```json
{
  "type": "url_citation",
  "url": "https://en.wikipedia.org/wiki/Entropy_(information_theory)",
  "title": "Entropy (information theory)",
  "start_index": 0,
  "end_index": 56
}
```

Two consequences worth knowing, because they shape the interface:

- `start_index` and `end_index` point into **the answer**, not into the source
  page. That is exactly what the superscript markers render: the span of the
  synthesis each source backs.
- The annotation carries **no excerpt** of the source. So a citation shows only
  host and title until you press its number, at which point Extract fetches the
  passages. Richer evidence without a second call would mean the Task API's
  Research Basis instead, at a different latency and price.

The API also supports SSE streaming and multi-turn via `previous_response_id`.
minser uses neither: one question, one answer, no conversation.

## Scope, cost and privacy

- **The answer is generated.** The prompt asks for a citation on every factual
  sentence; minser displays the annotations the API actually returns. It does
  not verify the claims or guarantee full citation coverage. Answers without
  usable citations show the no-answer state. Check the sources when needed.
- minser defaults to `reasoning.effort: "low"` — around 5–10 seconds, and
  **$10 per 1,000 lookups**, so roughly a cent each. `medium` ($50/1K, 15–20s)
  and `high` ($250/1K, 30–60s) research harder. The 30-second request timeout
  suits `low`; `high` would need it raised. Expanding a citation adds an Extract
  call. See Parallel's [pricing](https://docs.parallel.ai/getting-started/pricing).
- Only your term, your optional context, and the URL you choose to expand are
  sent to Parallel. Do not paste private information you would not share with
  that service.
- No books, local PDFs, clipboard or other personal files are read. No accounts,
  no telemetry of our own, no database.
- Cache and history are capped at 20 lookups, in memory only. Repeating a lookup
  with the same context, or re-expanding a source, does not call the API again
  while it is still cached. Everything is lost on exit.
- Requests can be cancelled and expire after 30 seconds. A stale response never
  replaces a newer lookup. Cancellation stops the local wait; Parallel may
  already have processed the request. Retrying is always an explicit action.
- The waiting screen shows elapsed time, not simulated research stages.
- The prompt requests at most five sources. A response exceeding that limit
  is rejected with an explanation, so citations are never silently discarded.
- Terminal control sequences are stripped from received text. URLs must be
  public http(s) without credentials; the check is syntactic and does not
  resolve DNS.
- Not a full browser, a PDF reader or a chat. No machine translation, no site
  logins, no crawling every link on a page.

## Development

```sh
bun run dev
bun run typecheck
bun test
bun run format:check
# Or all at once:
bun run check
```

Tests use mocked responses and OpenTUI's test renderer: no key, no model, no
network needed. Demo mode also lets you check behaviour in a real terminal.

`@opentui/core` and `@opentui/solid` are kept on matching versions; Solid is
pinned to the version the renderer requires. You do not need Zig to use the
published packages.

Docs: [OpenTUI Solid](https://github.com/anomalyco/opentui/tree/main/packages/solid),
[Parallel Responses](https://docs.parallel.ai/responses-api/responses-quickstart),
[Parallel Extract](https://docs.parallel.ai/extract/extract-quickstart).
