import { RGBA, type ScrollBoxRenderable } from "@opentui/core";
import {
  useKeyboard,
  useRenderer,
  useTerminalDimensions,
} from "@opentui/solid";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  Show,
} from "solid-js";
import type { LookupService } from "./parallel";
import { formatQuery, parseQuery } from "./query";
import { LookupSession } from "./session";
import { displayHost } from "./text";

// Paper's layout with native terminal colors and transparent surfaces.
export const color = {
  ground: "transparent",
  rule: RGBA.fromIndex(8),
  muted: RGBA.defaultForeground(),
  ink: RGBA.defaultForeground(),
  patina: RGBA.fromIndex(2),
  verdigris: RGBA.fromIndex(6),
  rust: RGBA.fromIndex(1),
};

export type AppProps = {
  service: LookupService;
  demo?: boolean;
  configured?: boolean;
  initialQuery?: string;
  initialContext?: string;
  onExit?: () => void;
};

export function App(props: AppProps) {
  const renderer = useRenderer();
  const dimensions = useTerminalDimensions();
  const session = new LookupSession(props.service);
  const [state, setState] = createSignal(session.state);
  const [query, setQuery] = createSignal(
    formatQuery(props.initialQuery ?? "", props.initialContext),
  );
  const [editing, setEditing] = createSignal(true);
  const [elapsed, setElapsed] = createSignal(0);
  let reader: ScrollBoxRenderable | undefined;
  let action = 0;
  const unsubscribe = session.subscribe(setState);
  const missingKey = () => !props.configured && !props.demo;
  const width = () => Math.max(1, Math.min(80, dimensions().width) - 4);
  const parsed = createMemo(() => parseQuery(query()));
  const sources = () => state().entry?.sources ?? [];
  const lookupError = () => state().errorKind === "search" && !editing();
  const showAnswer = () =>
    !lookupError() && state().busy !== "search" && !!state().entry;
  const hasAnswer = () => !!state().entry?.text.trim() && sources().length > 0;

  createEffect(() => {
    const busy = state().busy;
    setElapsed(0);
    if (!busy) return;
    const started = Date.now();
    const timer = setInterval(
      () => setElapsed(Math.floor((Date.now() - started) / 1000)),
      1000,
    );
    onCleanup(() => clearInterval(timer));
  });

  createEffect(() => {
    const index = state().openCitation;
    if (index === null || editing() || !showAnswer()) return;
    // Source expansion changes measured row positions on the next frame.
    const reveal = () => reader?.scrollChildIntoView(`citation-${index}`);
    renderer.once("frame", reveal);
    renderer.requestRender();
    onCleanup(() => renderer.off("frame", reveal));
  });

  async function submit() {
    if (missingKey() || state().busy || !parsed().term) return;
    const current = ++action;
    const { term, context } = parsed();
    setQuery(formatQuery(term, context));
    setEditing(false);
    reader?.scrollTo(0);
    await session.search(term, context);
    if (current === action) reader?.scrollTo(0);
  }

  function edit() {
    action++;
    session.cancel();
    setEditing(true);
    reader?.scrollTo(0);
  }

  function previous() {
    action++;
    const entry = session.back();
    if (entry) {
      setQuery(formatQuery(entry.term, entry.context));
      setEditing(false);
      reader?.scrollTo(0);
    }
  }

  function exit() {
    action++;
    session.cancel();
    if (props.onExit) props.onExit();
    else renderer.destroy();
  }

  async function toggle(index: number) {
    await session.toggleCitation(index);
  }

  useKeyboard((key) => {
    const stop = () => {
      key.preventDefault();
      key.stopPropagation();
    };
    if (key.ctrl && (key.name === "c" || key.name === "q")) {
      stop();
      exit();
    } else if (key.ctrl && key.name === "b") {
      stop();
      previous();
    } else if (key.name === "escape") {
      stop();
      action++;
      const busy = state().busy;
      session.cancel();
      setEditing(busy === "search" || (!state().entry && !editing()));
    } else if (!key.ctrl && !key.meta && !editing()) {
      if (key.name === "q") {
        stop();
        exit();
      } else if (key.name === "/" || key.name === "slash") {
        stop();
        edit();
      } else if (/^[1-5]$/.test(key.name) && showAnswer()) {
        stop();
        void toggle(Number(key.name) - 1);
      } else if (key.name === "return" && state().error && !state().busy) {
        stop();
        if (state().errorKind === "extract") void session.readSelected();
        else void submit();
      } else if (["up", "down", "pageup", "pagedown"].includes(key.name)) {
        stop();
        const sign = key.name === "up" || key.name === "pageup" ? -1 : 1;
        reader?.scrollBy(
          sign *
            (key.name.startsWith("page")
              ? Math.max(1, (reader?.viewport.height ?? 10) - 1)
              : 1),
        );
      }
    } else if (missingKey() && key.name === "q") {
      stop();
      exit();
    }
  });

  onCleanup(() => {
    unsubscribe();
    session.dispose();
  });

  const footer = () => {
    if (missingKey()) return "q quit and configure · Ctrl+C quit";
    if (state().busy) return "Esc cancel · Ctrl+C quit";
    if (editing()) return "⏎ look up · Esc leave editing · Ctrl+C quit";
    if (state().error) return "⏎ retry · Ctrl+B previous · / edit · q quit";
    if (!hasAnswer()) return "/ edit · Ctrl+B previous · q quit";
    const open = state().openCitation;
    const expand =
      open === null ? `1–${sources().length} expand` : `${open + 1} collapse`;
    return `${expand} · ↑↓ scroll · / edit · q quit`;
  };

  return (
    <box
      width="100%"
      height="100%"
      backgroundColor={color.ground}
      alignItems="center"
      paddingTop={dimensions().height >= 20 ? 1 : 0}
    >
      <box
        width={Math.min(80, dimensions().width)}
        height="100%"
        paddingX={2}
        flexDirection="column"
      >
        <box
          height={1}
          flexShrink={0}
          flexDirection="row"
          justifyContent="space-between"
        >
          <text fg={color.ink}>
            <strong>minser</strong>
          </text>
          <text fg={missingKey() || lookupError() ? color.rust : color.muted}>
            {missingKey()
              ? "no key"
              : lookupError()
                ? "no response"
                : props.demo
                  ? "demo · offline"
                  : state().cached
                    ? "session cache"
                    : ""}
          </text>
        </box>
        <box height={1} flexShrink={0} />
        <Show
          when={editing() || missingKey()}
          fallback={
            <text height={1} flexShrink={0} fg={color.ink}>
              <strong>{parsed().term}</strong>
              <span style={{ fg: color.muted }}>
                {parsed().context ? ` : ${parsed().context}` : ""}
              </span>
            </text>
          }
        >
          <box height={1} flexShrink={0} flexDirection="row">
            <text fg={color.patina} width={2}>
              ›{" "}
            </text>
            <input
              id="query"
              value={query()}
              onInput={setQuery}
              onSubmit={() => void submit()}
              focused={editing() && !missingKey() && !state().busy}
              onMouseDown={() => {
                if (!missingKey()) edit();
              }}
              maxLength={3003}
              flexGrow={1}
              placeholder=""
              textColor={color.ink}
              cursorColor={color.patina}
              backgroundColor={color.ground}
              focusedBackgroundColor={color.ground}
            />
          </box>
        </Show>
        <text height={1} flexShrink={0} fg={color.rule}>
          {"─".repeat(width())}
        </text>
        <box height={1} flexShrink={0} />
        <scrollbox
          id="reader"
          ref={(element) => {
            reader = element;
          }}
          flexGrow={1}
          minHeight={0}
          scrollX={false}
          contentOptions={{ flexDirection: "column", gap: 1 }}
          verticalScrollbarOptions={{ visible: false }}
        >
          <Show when={missingKey()}>
            <text fg={color.rust}>PARALLEL_API_KEY is missing.</text>
            <text fg={color.muted} wrapMode="word">
              minser cannot look anything up without it. Create a key at
              platform.parallel.ai and save it in .env:
            </text>
            <text fg={color.ink}>
              {"cp .env.example .env\nPARALLEL_API_KEY=…"}
            </text>
            <text fg={color.muted}>
              Then restart minser. Try bun run demo without a key.
            </text>
          </Show>
          <Show when={!missingKey()}>
            <Show when={state().busy === "search"}>
              <text
                fg={color.patina}
              >{`Looking up ${parsed().term}…  ${elapsed()}s`}</text>
              <text fg={color.muted} wrapMode="word">
                Parallel is researching your term and preparing a cited
                synthesis.
              </text>
              <text fg={color.muted}>A lookup usually takes 5–10 seconds.</text>
            </Show>
            <Show when={lookupError()}>
              <text fg={color.rust} wrapMode="word">
                {state().error}
              </text>
              <text fg={color.muted} wrapMode="word">
                Your query is still here. Press Enter to try again, or / to edit
                it.
              </text>
              <Show when={state().entry}>
                <text fg={color.muted}>
                  The previous lookup is still in memory:
                </text>
                <text fg={color.ink} wrapMode="word">
                  {formatQuery(state().entry!.term, state().entry!.context)}
                </text>
              </Show>
            </Show>
            <Show when={!state().entry && !state().busy && !lookupError()}>
              <text fg={color.muted} wrapMode="word">
                Type what you want to understand. If the term is ambiguous, add
                the topic after a colon:
              </text>
              <text fg={color.ink}>
                {"entropy : information theory\ncoherence : quantum mechanics"}
              </text>
              <text fg={color.muted} wrapMode="word">
                minser answers with a synthesis and the citations it rests on.
              </text>
              <Show when={props.demo}>
                <text fg={color.muted}>
                  Demo: a fixed entropy example. No network requests.
                </text>
              </Show>
            </Show>
            <Show when={showAnswer()}>
              <Show
                when={hasAnswer()}
                fallback={
                  <box flexDirection="column" gap={1}>
                    <text fg={color.ink}>Not enough sources to answer.</text>
                    <text fg={color.muted} wrapMode="word">
                      Parallel did not return a definition with usable
                      citations.
                    </text>
                    <text fg={color.muted} wrapMode="word">
                      Try dropping the context, or writing the term another way.
                    </text>
                  </box>
                }
              >
                <Show when={editing()}>
                  <text
                    fg={color.muted}
                    wrapMode="word"
                  >{`Previous lookup: ${formatQuery(state().entry!.term, state().entry!.context)}`}</text>
                </Show>
                <text fg={color.ink} wrapMode="word">
                  <For each={state().entry!.text.split(/([¹²³⁴⁵]+)/)}>
                    {(part) => (
                      <span
                        style={{
                          fg: /^[¹²³⁴⁵]+$/.test(part)
                            ? color.patina
                            : color.ink,
                        }}
                      >
                        {part}
                      </span>
                    )}
                  </For>
                </text>
                <box flexDirection="row" height={1} flexShrink={0} gap={1}>
                  <text fg={color.patina}>according to</text>
                  <text fg={color.verdigris}>
                    {"─".repeat(Math.max(1, width() - 13))}
                  </text>
                </box>
                <For each={sources()}>
                  {(source, index) => (
                    <box
                      id={`citation-${index()}`}
                      flexDirection="column"
                      flexShrink={0}
                      gap={1}
                    >
                      <box flexDirection="row" gap={2} flexShrink={0}>
                        <text width={1} flexShrink={0} fg={color.patina}>
                          <strong>{index() + 1}</strong>
                        </text>
                        <box
                          flexGrow={1}
                          minWidth={0}
                          flexDirection={width() < 66 ? "column" : "row"}
                          justifyContent="space-between"
                          gap={width() < 66 ? 0 : 2}
                        >
                          <text fg={color.muted} flexShrink={0}>
                            {displayHost(source.url)}
                          </text>
                          <text fg={color.muted} wrapMode="word" flexShrink={1}>
                            {source.title}
                          </text>
                        </box>
                      </box>
                      <Show when={state().openCitation === index()}>
                        <box
                          flexDirection="column"
                          paddingLeft={3}
                          gap={1}
                          flexShrink={0}
                        >
                          <Show when={state().busy === "extract"}>
                            <text
                              fg={color.patina}
                            >{`Reading this source… ${elapsed()}s`}</text>
                          </Show>
                          <Show when={state().errorKind === "extract"}>
                            <text fg={color.rust} wrapMode="word">
                              {state().error}
                            </text>
                          </Show>
                          <For each={source.excerpts.filter(Boolean)}>
                            {(excerpt) => (
                              <text
                                fg={color.ink}
                                wrapMode="word"
                              >{`«${excerpt}»`}</text>
                            )}
                          </For>
                          <Show
                            when={
                              !state().busy &&
                              !state().error &&
                              !source.excerpts.some(Boolean)
                            }
                          >
                            <text fg={color.muted}>
                              No passages returned for this source.
                            </text>
                          </Show>
                          <text fg={color.muted} wrapMode="char">
                            {source.url}
                          </text>
                          <Show when={props.demo}>
                            <text fg={color.muted} wrapMode="word">
                              Illustrative demo passages; not downloaded from
                              this source.
                            </text>
                          </Show>
                        </box>
                      </Show>
                    </box>
                  )}
                </For>
                <Show when={props.demo}>
                  <text fg={color.muted}>
                    Illustrative demo answer · no network
                  </text>
                </Show>
              </Show>
            </Show>
          </Show>
        </scrollbox>
        <box height={1} flexShrink={0} />
        <text height={2} flexShrink={0} fg={color.patina} wrapMode="word">
          {footer()}
        </text>
      </box>
    </box>
  );
}
