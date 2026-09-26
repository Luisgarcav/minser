import { boundedText } from "./parallel";

/** Split the topic separator, while keeping URL schemes and ports intact. */
export function parseQuery(input: string) {
  const trimmed = input.trim();
  const isUrl = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed);
  const separator = trimmed.indexOf(isUrl ? " : " : ":");
  return {
    term: boundedText(
      separator < 0 ? trimmed : trimmed.slice(0, separator),
      1000,
    ),
    context: boundedText(
      separator < 0 ? "" : trimmed.slice(separator + (isUrl ? 3 : 1)),
      2000,
    ),
  };
}

export function formatQuery(term: string, context = "") {
  return context ? `${term} : ${context}` : term;
}
