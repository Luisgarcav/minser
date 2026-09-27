# minser

Look a term up, then get back to your reading. A small TUI that answers with a
short synthesis and the citations it rests on — no browser, no tabs, no feed.
Ask follow-up questions without repeating the context, choose how deeply to
research each turn, or start a fresh lookup whenever you want.

- **Cited answers:** expand individual sources on demand with `1`–`5`.
- **Follow-ups:** press `f` to continue an answer, or `n` for an independent lookup.
- **Adjustable effort:** choose `low`, `medium` or `high` with Ctrl+E or the mouse.
- **Explicit requests:** nothing is sent at startup, while typing or when changing
  effort. Press Enter to submit; expanding an uncached citation makes a separate request.

Bun + TypeScript + Solid + OpenTUI. Parallel does the research: the **Responses
API** returns the answer with its citations, and **Extract** pulls passages from
a single source when you ask for them.

## Getting started

Requires Bun 1.4.1 or later and an interactive terminal, 80×24 or larger.

```sh
git clone https://github.com/Luisgarcav/minser.git
cd minser
bun install --frozen-lockfile
bun run demo
```

The demo needs no key and no network. Independent lookups show a fixed entropy
example; follow-ups show a fixed fair-coin example, whatever you type. Its text
is illustrative: it was not downloaded from the URLs it shows.

To try the interface offline:

1. Press Enter to show the prefilled entropy example.
2. Press `f`, type `Can you give an example?`, then Enter to see the follow-up.
3. Press Ctrl+E to inspect the effort levels and their displayed costs. Applying
   a level does not submit a query; the demo never incurs charges.
4. Press Ctrl+B to return to the previous answer, or Ctrl+C to quit.

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
bun run start --context "machine learning" "perceptron"
bun run start --help
```

Arguments prefill the term. Nothing is requested at startup or while you type,
including in demo mode. Press Enter to start the lookup.

### Research effort

Choose the depth of web research directly in the interface: press **Ctrl+E** or
click the **effort** label in the header. Use the arrow keys and Enter to apply,
click a level to apply it, or press Esc to cancel. The selector shows estimated
latency and cost for `low`, `medium` and `high`.

To choose the initial tier when starting minser:

```sh
bun run start --effort medium "perceptron"
bun run start --effort high "entropy : information theory"
```

For a persistent default, set `PARALLEL_EFFORT=medium` in `.env` (or your
shell environment). Precedence is `--effort`, then `PARALLEL_EFFORT`, then `low`.
Only `low`, `medium` and `high` are accepted; invalid values fail before a request.

Changing effort keeps your query but does not send it: press Enter again to
look up with the new tier. The previous answer stays in history; Ctrl+B restores
its effort too. Cached answers and expanded citations are separated by term,
context, effort and conversation parent, within the same 20-entry limit. The
selector is disabled while a request is running; cancel with Esc first.
Interface changes last only until you quit and do not rewrite `.env`. Demo mode
ignores the environment's effort and remains offline at every level.

| Effort   | Typical lookup | minser search timeout | USD per successful lookup |
| -------- | -------------- | --------------------- | ------------------------- |
| `low`    | 5–10 s         | 30 s                  | $0.01                     |
| `medium` | 15–20 s        | 60 s                  | $0.05                     |
| `high`   | 30–60 s        | 120 s                 | $0.25                     |

Higher tiers research more deeply, not necessarily more verbosely. These are
Parallel's published [tiers](https://docs.parallel.ai/responses-api/responses-quickstart)
and [prices](https://docs.parallel.ai/getting-started/pricing), not latency guarantees.
Extract has no reasoning effort and retains its 30-second timeout and separate charge.

### Follow-up questions

After an answer, press **f** or click **f follow up** beside the citations. Type
something like `Can you give an example?` and press Enter. The follow-up uses the
previous answer's conversation context; the `Follow-up to:` label identifies
that answer. Colons in follow-up questions are literal text, not new context
separators. Press f again after the next answer to continue the chain.

For example, try this sequence, pressing Enter after typing each query:

| Action          | Query                                       |
| --------------- | ------------------------------------------- |
| First lookup    | `perceptron : machine learning`             |
| Press `f`       | `Why can't it learn XOR?`                   |
| Press `f` again | `How does a multilayer network solve that?` |
| Press `n`       | `entropy : information theory`              |

Opening or typing a follow-up sends nothing. Each uncached turn performs fresh
research and has its own lookup cost. Ctrl+E can choose a different effort for
the next turn without losing its conversation context. Esc or Ctrl+B returns
from an unsent follow-up/new draft to the current answer without a request.

Press **n** or click **n new** for an independent lookup with a blank field and
no conversation context. **/** instead edits the current turn: editing a
follow-up keeps its original parent, rather than continuing its own answer.
Ctrl+B recalls previous answers, including their effort and parent context.

Follow-up and new-lookup controls are unavailable while a request is running;
cancel with Esc first. A follow-up needs a cited answer and a usable response
ID. An answer without that ID remains readable, but shows a follow-up
unavailable message instead of the `f follow up` button.

minser links turns using Parallel's response `id` as `previous_response_id`.
Parallel's [statefulness](https://docs.parallel.ai/responses-api/features/statefulness)
is unavailable for organizations with Zero Data Retention enabled. If a linked
request fails, minser shows the error; it never silently replays the conversation,
retries, or sends the question as an independent lookup. Enter explicitly retries;
n starts an independent draft that still needs Enter to send.

## The flow

1. Type a term. If it is ambiguous, add the topic after a colon:
   `entropy : information theory`.
2. Press Enter. minser asks Parallel's Responses API.
3. You get a short synthesis. Superscript markers — ¹ ² ³ — tie each claim to
   the source that supports it.
4. Below a rule, the numbered citations: host and page title.
5. Press `1`–`5` to pull passages from that source, via Extract. One request,
   only for the one you asked about.
6. Press `f` to compose a follow-up, `n` for a new lookup, or `q` to return to reading.

### Keyboard and mouse

Once results arrive, focus leaves the input and keys become commands. `/` puts
you back in the query field. You can also click **f follow up**, **n new**, or
the header's **effort** label.

| Key          | Action                                                      |
| ------------ | ----------------------------------------------------------- |
| Enter        | Look up (while editing) / retry (after a failure)           |
| `1`–`5`      | Expand that citation's passages — press again to collapse   |
| ↑ / ↓        | Scroll the reading column                                   |
| PgUp / PgDn  | Scroll by page                                              |
| `f`          | Compose a follow-up using the current answer's context      |
| `n`          | Compose an independent lookup                               |
| `/`          | Edit the current turn, keeping its conversation parent      |
| Ctrl+B       | Recall the previous lookup, effort and parent context       |
| Ctrl+E       | Choose effort (arrows / Enter / Esc, or click a level)      |
| Esc          | Cancel a request, return from a new draft, or leave editing |
| `q` / Ctrl+C | Quit                                                        |

While editing, letters (including `f`, `n` and `q`) and numbers go into the query,
not into commands. Press Esc to leave editing before using shortcuts, or use
Ctrl+C to quit at any time. Esc or Ctrl+B returns from an unsent follow-up/new
lookup draft to the current answer without sending it. Only one citation is
open at a time. Enter retries a failed extraction as well as a failed lookup.

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
  synthesis each source backs. Parallel can also return equal indices (including
  `0, 0`), which identify no span. minser keeps those citations in the source list
  without inventing an inline marker or rejecting the answer.
- The annotation carries **no excerpt** of the source. So a citation shows only
  host and title until you press its number, at which point Extract fetches the
  passages. Richer evidence without a second call would mean the Task API's
  Research Basis instead, at a different latency and price.

minser uses multi-turn via `previous_response_id` only when you explicitly choose
a follow-up. Independent lookups omit that field. The API also supports SSE
streaming, which minser does not yet use.

## Connector support in Parallel

The same `/v1/responses` endpoint also supports connectors; no switch to the Task
API is needed. These are API capabilities, **not yet configuration options in
minser**. Choosing an effort does not enable any connector.

- **Managed Data Connectors:** send a top-level `data_sources` with `free` and/or
  `pay_per_use` lists. They require `medium` or `high`; `low` is rejected. The
  published free catalog includes `pubmed`, `clinical_trials`, `chembl`,
  `biorxiv`, `npi_registry` and `cms_coverage`. `carbonarc` is pay-per-use.
  Availability is organization-specific; minser has not checked your account's
  access. Free connectors have no connector surcharge, but the Responses lookup
  still costs money. Paid connectors charge per successful tool call and can be
  called more than once per lookup.
- **Remote MCP / your own license:** send `tools` entries of type `mcp` with a
  `server_label`, `server_url` and `require_approval: "never"`. They work at every
  effort level. Only Streamable HTTP tools are supported, not local stdio
  servers, MCP resources/prompts or OpenAI `connector_id`. Authentication is
  supplied explicitly; Parallel does not perform OAuth login for you. Since
  there is no approval step, use trusted servers and explicitly allowlist
  read-only tools with `allowed_tools`.

For example, a direct Responses API request can include:

```json
{
  "model": "parallel",
  "input": "Summarize registered phase 3 trials for semaglutide in adolescents.",
  "reasoning": { "effort": "medium" },
  "data_sources": { "free": ["clinical_trials", "pubmed"] }
}
```

Connectors supplement web research; enabling one does not guarantee it is called.
Their tool calls appear as `mcp_call` output items, separate from the final answer
and its URL citations. minser already ignores tool output when parsing an answer,
but does not yet send connector settings or surface individual connector failures.

References: [Data Connectors](https://docs.parallel.ai/resources/data-connectors#responses-api),
[MCP Tools](https://docs.parallel.ai/responses-api/features/mcp-tools).

## Scope, cost and privacy

- **The answer is generated.** The prompt asks for a citation on every factual
  sentence; minser displays the annotations the API actually returns. It does
  not verify the claims or guarantee full citation coverage. Answers without
  usable citations show the no-answer state. Check the sources when needed.
- minser defaults to `reasoning.effort: "low"`. Use Ctrl+E or the effort label
  to change it interactively, or `--effort` / `PARALLEL_EFFORT` for the initial
  tier. Each uncached follow-up is a separate lookup charged at its chosen
  effort. Expanding an uncached citation adds an Extract call. See Parallel's
  [pricing](https://docs.parallel.ai/getting-started/pricing).
- Your term or follow-up question, optional context, the previous response ID
  for linked turns, and the URL you choose to expand are sent to Parallel.
  Linked turns let Parallel reuse the conversation's earlier context. Do not
  paste private information you would not share with that service.
- Parallel stores responses server-side to support follow-ups (except with Zero
  Data Retention, where follow-ups are unavailable). Quitting minser clears only
  its local memory; it does not delete responses retained by Parallel.
- No books, local PDFs, clipboard or other personal files are read. There is no
  minser account, telemetry of our own or local database; real lookups require
  your Parallel API key.
- Cache and history are each capped at 20 lookups, in local memory only. Repeating
  a lookup with the same term/question, context, effort and conversation parent,
  or re-expanding a source for that lookup, does not call the API again while
  cached. Different conversations never share cached follow-up answers. Local
  answers, response IDs and history are lost on exit.
- Requests can be cancelled. Searches expire after 30/60/120 seconds for
  low/medium/high effort; extractions after 30 seconds. A stale response never
  replaces a newer lookup. Cancellation stops the local wait; Parallel may
  already have processed the request. Retrying is always an explicit action.
- The waiting screen shows elapsed time, not simulated research stages.
- The prompt requests at most five sources. A response exceeding that limit
  is rejected with an explanation, so citations are never silently discarded.
- Terminal control sequences are stripped from received text. URLs must be
  public http(s) without credentials; the check is syntactic and does not
  resolve DNS.
- Not a full browser, a PDF reader or a persistent chat client. No machine
  translation, no site logins, no crawling every link on a page.

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
