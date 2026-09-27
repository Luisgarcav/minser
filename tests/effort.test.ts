import { describe, expect, test } from "bun:test";
import { parseEffort, resolveEffort } from "../src/effort";

describe("effort configuration", () => {
  test.each(["low", "medium", "high"] as const)("accepts %s", (effort) => {
    expect(parseEffort(effort)).toBe(effort);
    expect(parseEffort(` ${effort} `)).toBe(effort);
    expect(resolveEffort(undefined, effort)).toBe(effort);
  });

  test.each([undefined, "", " \n\t"])(
    "defaults to low with no environment value: %j",
    (value) => {
      expect(resolveEffort(undefined, value)).toBe("low");
    },
  );

  test("CLI takes precedence, including over an invalid environment value", () => {
    expect(resolveEffort("low", "high")).toBe("low");
    expect(resolveEffort("high", "medium")).toBe("high");
    expect(resolveEffort("medium", "invalid")).toBe("medium");
  });

  test.each(["", " ", "HIGH", "none", "__proto__", "private-value\x1b[31m"])(
    "rejects invalid effort without echoing it: %j",
    (value) => {
      expect(() => parseEffort(value)).toThrow(
        "Effort must be low, medium or high (--effort / PARALLEL_EFFORT).",
      );
    },
  );

  test("an invalid environment setting does not silently change the tier", () => {
    expect(() => resolveEffort(undefined, "invalid")).toThrow(
      "PARALLEL_EFFORT",
    );
  });
});
