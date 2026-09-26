import { expect, test } from "bun:test";
import { formatQuery, parseQuery } from "../src/query";

test("splits term/context once and preserves URL schemes and ports", () => {
  expect(parseQuery(" entropy : information theory : chapter 2 ")).toEqual({
    term: "entropy",
    context: "information theory : chapter 2",
  });
  expect(parseQuery("coherence:quantum mechanics")).toEqual({
    term: "coherence",
    context: "quantum mechanics",
  });
  expect(parseQuery("https://example.org:443/article")).toEqual({
    term: "https://example.org:443/article",
    context: "",
  });
  expect(parseQuery("https://example.org/article : physics")).toEqual({
    term: "https://example.org/article",
    context: "physics",
  });
  expect(parseQuery(" : context").term).toBe("");
  expect(parseQuery(formatQuery("entropy", "information theory"))).toEqual({
    term: "entropy",
    context: "information theory",
  });
});
