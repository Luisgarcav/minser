import { describe, expect, test } from "bun:test";
import { HELP, parseArgs } from "../src/cli";

describe("parseArgs", () => {
  test("defaults to an empty interactive query and joins positional terms", () => {
    expect(parseArgs([])).toEqual({
      demo: false,
      help: false,
      context: "",
      query: "",
    });
    expect(parseArgs(["entropía", "de", "Shannon"]).query).toBe(
      "entropía de Shannon",
    );
    expect(parseArgs(["https://example.org/paper"]).query).toBe(
      "https://example.org/paper",
    );
  });

  test.each(["--help", "-h"])(
    "recognizes %s without inventing a query",
    (flag) => {
      expect(parseArgs([flag])).toEqual({
        demo: false,
        help: true,
        context: "",
        query: "",
      });
      expect(HELP).toContain("--help, -h");
      expect(HELP).toContain("--context TEXT");
    },
  );

  test.each([
    {
      args: ["--context", "teoría de la información", "entropía", "de Shannon"],
    },
    {
      args: ["entropía", "--context", "teoría de la información", "de Shannon"],
    },
  ])("parses context separately from the positional query: %j", ({ args }) => {
    const input: string[] = [...args];
    const original = [...input];
    expect(parseArgs(input)).toEqual({
      demo: false,
      help: false,
      context: "teoría de la información",
      query: "entropía de Shannon",
    });
    expect(input).toEqual(original);
  });

  test("demo supplies its default only when the query is absent", () => {
    expect(parseArgs(["--demo"])).toEqual({
      demo: true,
      help: false,
      context: "information theory",
      query: "entropy",
    });
    expect(parseArgs(["--demo", "--context", "física"])).toEqual({
      demo: true,
      help: false,
      context: "física",
      query: "entropy",
    });
    expect(parseArgs(["--demo", "otra", "consulta"])).toEqual({
      demo: true,
      help: false,
      context: "",
      query: "otra consulta",
    });
  });

  test.each(["low", "medium", "high"] as const)(
    "parses --effort %s before or after the query",
    (effort) => {
      expect(parseArgs(["--effort", effort, "perceptron"])).toMatchObject({
        effort,
        query: "perceptron",
      });
      expect(
        parseArgs(["perceptron", "--effort", effort, "--context", "ML"]),
      ).toMatchObject({
        effort,
        query: "perceptron",
        context: "ML",
      });
      expect(HELP).toContain("--effort LEVEL");
      expect(HELP).toContain("PARALLEL_EFFORT");
    },
  );

  test("help explains explicit follow-ups, independent lookups, costs and provider storage", () => {
    for (const detail of [
      "f follow up",
      "n new lookup",
      "Neither sends until Enter",
      "Each uncached follow-up is a new paid lookup",
      "Zero Data Retention",
      "Parallel stores responses server-side",
      "including f/n/q",
    ])
      expect(HELP).toContain(detail);
  });

  test("omitted effort can be resolved from the environment later", () => {
    expect(parseArgs([]).effort).toBeUndefined();
    expect(parseArgs(["--", "--effort", "high"]).query).toBe("--effort high");
    expect(parseArgs(["--", "--effort", "high"]).effort).toBeUndefined();
  });

  test.each([
    { args: ["--effort"] },
    { args: ["--effort", ""] },
    { args: ["--effort", " "] },
    { args: ["--effort", "--demo"] },
    { args: ["--effort", "--"] },
    { args: ["--effort", "invalid"] },
  ])("rejects missing or invalid effort: %j", ({ args }) => {
    expect(() => parseArgs([...args])).toThrow("effort");
  });

  test.each(["--unknown", "-x"])("rejects unknown option %s", (flag) => {
    expect(() => parseArgs(["consulta", flag])).toThrow("Unknown option");
  });

  test.each([
    { args: ["--context"] },
    { args: ["--context", ""] },
    { args: ["--context", "--demo"] },
    { args: ["--context", "--"] },
    { args: ["--context", "-h"] },
  ])(
    "rejects missing context instead of consuming another option: %j",
    ({ args }) => {
      expect(() => parseArgs([...args])).toThrow(
        "--context requires a quoted text value",
      );
    },
  );

  test("the first -- ends option parsing and later flags stay literal", () => {
    expect(
      parseArgs([
        "--context",
        "física",
        "--",
        "--help",
        "-h",
        "--demo",
        "--context",
        "--unknown",
        "--",
        "entropía",
      ]),
    ).toEqual({
      demo: false,
      help: false,
      context: "física",
      query: "--help -h --demo --context --unknown -- entropía",
    });
    expect(parseArgs(["--"]).query).toBe("");
    expect(parseArgs(["--demo", "--", "-h"])).toEqual({
      demo: true,
      help: false,
      context: "",
      query: "-h",
    });
  });
});
