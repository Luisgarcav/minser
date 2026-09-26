export const HELP = `minser — look a term up, then get back to your reading.

Usage:
  bun run start
  bun run start "entropy : information theory"
  bun run start --context "information theory" "entropy"
  bun run demo

Options:
  --context TEXT    Optional topic to disambiguate the term.
  --demo            Fixed entropy example, no network or key.
  --help, -h        Show this help.

Set PARALLEL_API_KEY in your environment or .env.
Enter sends your term and context to Parallel's Responses API.
Expanding a citation sends its URL and your query to Extract.
No local documents are read. History lives in memory until you quit.

Keys: Enter look up/retry · 1–5 expand/collapse · / edit · Ctrl+B previous
↑↓ scroll · PgUp/PgDn page · Esc cancel/leave editing · q/Ctrl+C quit
While editing, q and number keys are text. Use Esc or Ctrl+C to leave.
`;

export function parseArgs(args: string[]) {
  const result = { demo: false, help: false, context: "", query: "" };
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
