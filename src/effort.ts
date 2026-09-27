export const EFFORT_LEVELS = ["low", "medium", "high"] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

export const DEFAULT_EFFORT: Effort = "low";
export const EFFORT_PROFILES = {
  low: { timeoutMs: 30_000, usualSeconds: "5–10", cost: "$0.01" },
  medium: { timeoutMs: 60_000, usualSeconds: "15–20", cost: "$0.05" },
  high: { timeoutMs: 120_000, usualSeconds: "30–60", cost: "$0.25" },
} as const satisfies Record<
  Effort,
  { timeoutMs: number; usualSeconds: string; cost: string }
>;

export function parseEffort(value: string): Effort {
  const effort = value.trim();
  if (effort === "low" || effort === "medium" || effort === "high")
    return effort;
  // Never echo arbitrary CLI/environment values into the terminal.
  throw new Error(
    "Effort must be low, medium or high (--effort / PARALLEL_EFFORT).",
  );
}

export function resolveEffort(
  cliEffort: Effort | undefined,
  envEffort: string | undefined,
): Effort {
  return cliEffort ?? parseEffort(envEffort?.trim() || DEFAULT_EFFORT);
}
