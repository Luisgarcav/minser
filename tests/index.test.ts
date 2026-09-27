import { describe, expect, test } from "bun:test";

const cwd = new URL("../", import.meta.url).pathname;
const INVALID_EFFORT = "private-invalid-effort";

function start(args: readonly string[]) {
  const result = Bun.spawnSync({
    cmd: [process.execPath, "src/index.tsx", ...args],
    cwd,
    env: {
      ...process.env,
      PARALLEL_API_KEY: "",
      PARALLEL_EFFORT: INVALID_EFFORT,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

describe("CLI startup effort wiring (no TTY or network)", () => {
  test("help works even with an invalid environment effort", () => {
    const result = start(["--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("--effort LEVEL");
    expect(result.stderr).toBe("");
  });

  test("validates environment effort before starting the renderer", () => {
    const result = start([]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Effort must be low, medium or high");
    expect(result.stderr).not.toContain(INVALID_EFFORT);
    expect(result.stderr).not.toContain("interactive terminal");
  });

  test.each([{ args: ["--effort", "high"] }, { args: ["--demo"] }])(
    "CLI override and demo ignore invalid environment effort: %j",
    ({ args }) => {
      const result = start(args);
      // Reaching the TTY guard proves config resolved without launching a lookup.
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("interactive terminal");
      expect(result.stderr).not.toContain("Effort must");
      expect(result.stderr).not.toContain(INVALID_EFFORT);
    },
  );
});
