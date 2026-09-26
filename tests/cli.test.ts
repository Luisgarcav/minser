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
