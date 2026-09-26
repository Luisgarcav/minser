import { HELP, parseArgs } from "./cli";

async function main() {
  const options = parseArgs(Bun.argv.slice(2));
  if (options.help) {
    console.log(HELP);
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      "minser needs an interactive terminal. Use --help to see available options.",
    );
  }

  const [
    { render },
    { App },
    { createDemoService },
    { createParallelService },
    { RGBA },
  ] = await Promise.all([
    import("@opentui/solid"),
    import("./app"),
    import("./demo"),
    import("./parallel"),
    import("@opentui/core"),
  ]);
  const apiKey = process.env.PARALLEL_API_KEY?.trim() ?? "";
  const service = options.demo
    ? createDemoService()
    : createParallelService(apiKey);
  await render(
    () => (
      <App
        service={service}
        demo={options.demo}
        configured={Boolean(apiKey)}
        initialQuery={options.query}
        initialContext={options.context}
      />
    ),
    {
      exitOnCtrlC: true,
      screenMode: "alternate-screen",
      backgroundColor: RGBA.defaultBackground(),
      targetFps: 30,
      maxFps: 30,
      useMouse: true,
      consoleMode: "disabled",
    },
  );
}

main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.message : "Could not start minser.",
  );
  process.exitCode = 1;
});
