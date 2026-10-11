import yargs, { type Argv } from "yargs";
import { createCrawlCommand, type CrawlCommandDependencies } from "./commands/crawl.ts";
import { runHeadlessCrawl } from "./core/headless.ts";
import { isBunRuntime, startInteractiveSession } from "./core/session.ts";

type Writer = {
  write(chunk: string): unknown;
};

export type CliDependencies = Omit<CrawlCommandDependencies, "setExitCode"> & {
  stdout: Writer;
  stderr: Writer;
};

const defaultCliDependencies: CliDependencies = {
  startInteractiveSession,
  runHeadlessCrawl: input => runHeadlessCrawl(input),
  isInteractiveTerminal: () => Boolean(process.stdout.isTTY && process.stdin.isTTY),
  isBunRuntime,
  stdout: process.stdout,
  stderr: process.stderr,
};

export function createCli(
  argv: string[],
  deps: CliDependencies = defaultCliDependencies,
  exitCode: { value: number } = { value: 0 },
): Argv {
  const commandDeps: CrawlCommandDependencies = {
    ...deps,
    setExitCode: (code) => {
      exitCode.value = code;
    },
  };

  return yargs(argv)
    .scriptName("turbo-crawl")
    .usage("$0 <command> [options]")
    .command(createCrawlCommand(commandDeps))
    .demandCommand(1, "You need a command before starting the crawler agent.")
    .strictCommands()
    .recommendCommands()
    .help()
    .alias("h", "help")
    // Injected at build time; yargs would otherwise read the nearest package.json, which
    // belongs to whatever project the CLI runs in.
    .version(process.env.TURBO_CRAWL_VERSION ?? "dev")
    .alias("v", "version")
    .exitProcess(false);
}

export function parseCli(
  argv: string[],
  deps: CliDependencies = defaultCliDependencies,
): Promise<{ error?: Error; output: string; exitCode: number }> {
  const exitCode = { value: 0 };

  return new Promise((resolve) => {
    createCli(argv, deps, exitCode).parse(argv, (error: Error | null, _parsed: unknown, output: string) => {
      resolve({
        error: error ?? undefined,
        output: output ?? "",
        get exitCode() {
          return exitCode.value;
        },
      });
    });
  });
}

export async function runCli(
  argv: string[],
  deps: CliDependencies = defaultCliDependencies,
): Promise<number> {
  const parsed = await parseCli(argv, deps);
  const { error, output } = parsed;

  if (output) {
    const target = error ? deps.stderr : deps.stdout;
    target.write(output.endsWith("\n") ? output : `${output}\n`);
  }

  if (!error) {
    return parsed.exitCode;
  }

  if (!output && error.message) {
    deps.stderr.write(`${error.message}\n`);
  }

  return 1;
}
