import { parseEffort, type Effort } from "./effort";

export const HELP = `minser — look a term up, then get back to your reading.

Usage:
  bun run start
  bun run start "entropy : information theory"
  bun run start --context "information theory" "entropy"
  bun run start --effort high "perceptron"
  bun run demo

Options:
  --context TEXT    Optional topic to disambiguate the term.
  --effort LEVEL    low, medium or high; overrides PARALLEL_EFFORT (default: low).
  --demo            Fixed entropy example, no network or key.
  --help, -h        Show this help.

Set PARALLEL_API_KEY and optionally PARALLEL_EFFORT in your environment or .env.
Ctrl+E or click the effort label to change it in the interface.
Choose with arrows, Enter to apply, Esc to cancel. Higher tiers cost more.
Search timeouts: low 30s, medium 60s, high 120s. Extract always uses 30s.
Enter sends your term/question and context to Parallel's Responses API.
After an answer, f (or click follow up) composes a linked follow-up; n starts anew.
Neither sends until Enter. Each uncached follow-up is a new paid lookup.
Follow-ups need a response ID and are unavailable with Zero Data Retention.
Expanding a citation sends its URL and your query to Extract.
No local documents are read. Local history lives in memory until you quit;
Parallel stores responses server-side for conversation context.

Keys: Enter look up/retry · f follow up · n new lookup · Ctrl+E effort
1–5 expand/collapse · / edit current turn · Ctrl+B previous (including effort)
↑↓ scroll · PgUp/PgDn page · Esc cancel/leave editing · q/Ctrl+C quit
Esc or Ctrl+B returns from an unsent follow-up/new draft without a request.
While editing, letters (including f/n/q) and numbers are text. Ctrl+C quits.
`;

export function parseArgs(args: string[]) {
  const result: {
    demo: boolean;
    help: boolean;
    context: string;
    query: string;
    effort?: Effort;
  } = { demo: false, help: false, context: "", query: "" };
  const terms: string[] = [];
  let literal = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!literal && arg === "--") literal = true;
    else if (!literal && (arg === "--help" || arg === "-h")) result.help = true;
    else if (!literal && arg === "--demo") result.demo = true;
    else if (!literal && arg === "--context") {
      const value = args[++i];
      if (!value || value.startsWith("-"))
        throw new Error("--context requires a quoted text value.");
      result.context = value;
    } else if (!literal && arg === "--effort") {
      const value = args[++i];
      if (!value || value.startsWith("-"))
        throw new Error("--effort requires low, medium or high.");
      result.effort = parseEffort(value);
    } else if (!literal && arg.startsWith("-")) {
      throw new Error("Unknown option. Use --help to see available options.");
    } else terms.push(arg);
  }
  result.query = terms.join(" ");
  if (result.demo && !result.query) result.query = "entropy";
  if (result.demo && result.query === "entropy" && !result.context)
    result.context = "information theory";
  return result;
}
