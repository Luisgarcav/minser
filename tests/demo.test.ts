import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createDemoService } from "../src/demo";

const rootText =
  "Measure of the average uncertainty of a random variable.¹ In information theory, the number of bits needed on average to describe an outcome.² Not a measure of disorder, but of missing information.³";
const followUpText =
  "For a fair coin, either outcome has probability one half, so its entropy is one bit.¹ If the outcome is certain, its entropy is zero: there is no uncertainty left to resolve.²";
const passages = [
  "The expected number of bits required to describe the outcome.",
  "Shannon's measure quantifies missing information: how much we do not yet know about the outcome. A fair coin has one bit of entropy.",
];

function guardNetwork() {
  const forbidden = () => {
    throw new Error("The offline demo must not call global fetch.");
  };
  return spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(forbidden, { preconnect: forbidden }),
  );
}
let network: ReturnType<typeof guardNetwork>;
beforeEach(() => {
  network = guardNetwork();
});
afterEach(() => {
  try {
    expect(network).not.toHaveBeenCalled();
  } finally {
    network.mockRestore();
  }
});

describe("offline follow-up demo", () => {
  test("every search gets a unique sequential demo-response-n ID, including repeated parents and new roots", async () => {
    const demo = createDemoService();
    const root = await demo.search("entropy", "information theory");
    const child = await demo.search(
      "Why?",
      "information theory",
      undefined,
      "low",
      root.responseId,
    );
    const sibling = await demo.search(
      "Why?",
      "information theory",
      undefined,
      "low",
      root.responseId,
    );
    const grandchild = await demo.search(
      "An example?",
      "information theory",
      undefined,
      "high",
      child.responseId,
    );
    const independent = await demo.search("coherence", "optics");
    const concurrent = await Promise.all([
      demo.search("another root", ""),
      demo.search(
        "another question",
        "",
        undefined,
        "medium",
        child.responseId,
      ),
    ]);
    const ids = [
      root,
      child,
      sibling,
      grandchild,
      independent,
      ...concurrent,
    ].map((answer) => answer.responseId);
    expect(ids).toEqual([
      "demo-response-1",
      "demo-response-2",
      "demo-response-3",
      "demo-response-4",
      "demo-response-5",
      "demo-response-6",
      "demo-response-7",
    ]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(independent.text).toBe(rootText);
    expect(grandchild.text).toBe(followUpText);
  });

  test("linked requests use a static fair-coin illustration, independent of query, context or effort", async () => {
    const demo = createDemoService();
    const root = await demo.search("entropy", "information theory");
    expect(root.text).toBe(rootText);
    expect(root.sources.map((source) => source.url)).toEqual([
      "https://en.wikipedia.org/wiki/Entropy_(information_theory)",
      "https://plato.stanford.edu/entries/information/",
      "https://ncatlab.org/nlab/show/entropy",
    ]);
    for (const effort of ["low", "medium", "high"] as const) {
      const linked = await demo.search(
        `Unrelated: query::${effort}`,
        "a different topic",
        new AbortController().signal,
        effort,
        root.responseId,
      );
      expect(linked.text).toBe(followUpText);
      expect(linked.sources).toEqual(root.sources);
      expect(
        linked.sources.every((source) => source.excerpts.length === 0),
      ).toBe(true);
      const independent = await demo.search(
        "a different term",
        "",
        undefined,
        effort,
      );
      expect(independent.text).toBe(rootText);
    }
  });

  test("answer and nested citation mutations never leak into later turns or another demo service", async () => {
    const demo = createDemoService();
    const root = await demo.search("entropy", "");
    const originalSources = structuredClone(root.sources);
    root.text = "Mutated answer";
    root.sources[0]!.title = "Mutated title";
    root.sources[0]!.excerpts.push("Mutated excerpt");
    root.sources.pop();

    const child = await demo.search(
      "Why?",
      "",
      undefined,
      "low",
      root.responseId,
    );
    expect(child.text).toBe(followUpText);
    expect(child.sources).toEqual(originalSources);
    expect(child.sources).not.toBe(root.sources);
    expect(child.sources[0]).not.toBe(root.sources[0]);
    expect(child.sources[0]!.excerpts).not.toBe(root.sources[0]!.excerpts);
    child.sources[0]!.url = "https://example.org/mutated";
    child.sources[0]!.excerpts.push("Child-only excerpt");
    child.sources.pop();

    const independent = await demo.search("fresh", "");
    const otherDemo = await createDemoService().search("fresh", "");
    for (const fresh of [independent, otherDemo]) {
      expect(fresh.text).toBe(rootText);
      expect(fresh.sources).toEqual(originalSources);
    }
    expect(independent.responseId).toBe("demo-response-3");
    expect(otherDemo.responseId).toBe("demo-response-1");
    expect(independent.sources[0]).not.toBe(otherDemo.sources[0]);
  });

  test("extract returns fresh illustrative passages without mutating sources or consuming response IDs", async () => {
    const demo = createDemoService();
    const root = await demo.search("entropy", "information theory");
    const original = structuredClone(root);
    for (const source of root.sources) {
      const detailed = await demo.extract(
        source,
        "entropy",
        "information theory",
      );
      expect(detailed).toEqual({ ...source, excerpts: passages });
      expect(detailed).not.toBe(source);
      expect(source.excerpts).toEqual([]);
      detailed.excerpts.push("Mutation must remain local");
      const again = await demo.extract(source, "a different question", "");
      expect(again.excerpts).toEqual(passages);
      expect(again.excerpts).not.toBe(detailed.excerpts);
    }
    expect(root).toEqual(original);
    const child = await demo.search(
      "Why: a coin?",
      "information theory",
      undefined,
      "low",
      root.responseId,
    );
    expect(child.responseId).toBe("demo-response-2");
    expect(child.text).toBe(followUpText);
    expect(child.sources).toEqual(original.sources);
  });
});
