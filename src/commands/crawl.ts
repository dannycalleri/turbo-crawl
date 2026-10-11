import type { CommandModule } from "yargs";
import type { HeadlessCrawlInput } from "../core/headless.ts";
import type { InteractiveSessionInput } from "../core/session.ts";

export type CrawlArguments = {
  target: string;
  fields?: string;
  provider?: string;
  model?: string;
  "data-dir"?: string;
  "max-repairs"?: number;
  json?: boolean;
  tui?: boolean;
};

export type CrawlCommandDependencies = {
  startInteractiveSession(input: InteractiveSessionInput): Promise<void>;
  runHeadlessCrawl(input: HeadlessCrawlInput): Promise<number>;
  isInteractiveTerminal(): boolean;
  isBunRuntime(): boolean;
  setExitCode(code: number): void;
  stderr: { write(chunk: string): unknown };
};

export type CrawlMode = "tui" | "headless" | "tui-unavailable";

export function chooseCrawlMode(
  argv: Pick<CrawlArguments, "fields" | "json" | "tui">,
  env: { interactiveTerminal: boolean; bun: boolean },
): CrawlMode {
  if (argv.tui === true) {
    return env.bun ? "tui" : "tui-unavailable";
  }
  if (argv.tui === false || argv.json || argv.fields !== undefined) {
    return "headless";
  }
  return env.bun && env.interactiveTerminal ? "tui" : "headless";
}

export function createCrawlCommand(
  deps: CrawlCommandDependencies,
): CommandModule<object, CrawlArguments> {
  return {
    command: "crawl <target>",
    describe: "Extract structured data from a page. The first page of a URL pattern gets a template written by a coding agent; later pages reuse it without any model call.",
    builder: (yargs) =>
      yargs
        .positional("target", {
          type: "string",
          describe: "Absolute URL or hostname to crawl.",
          demandOption: true,
        })
        .option("fields", {
          type: "string",
          describe: "Fields to extract as name:type pairs (types: string, text, number, boolean, date, url). Omit to let the agent suggest fields.",
        })
        .option("provider", {
          type: "string",
          describe: "Agent that writes templates: auto, claude, codex or lmstudio. Defaults to $TURBO_CRAWL_PROVIDER, then auto.",
        })
        .option("model", {
          type: "string",
          describe: "Model passed to the provider. Defaults to $TURBO_CRAWL_MODEL, then the provider's default.",
        })
        .option("data-dir", {
          type: "string",
          describe: "Where schemas, templates and results are stored. Defaults to $TURBO_CRAWL_DATA_DIR, then ./data.",
        })
        .option("max-repairs", {
          type: "number",
          describe: "How many times the agent may fix selectors that failed on the page.",
          default: 2,
        })
        .option("json", {
          type: "boolean",
          describe: "Run without the TUI and print the result as JSON.",
        })
        .option("tui", {
          type: "boolean",
          describe: "Force (--tui) or disable (--no-tui) the interactive TUI. The TUI needs Bun.",
        })
        .example(
          "$0 crawl https://books.toscrape.com/catalogue/a-light-in-the-attic_1000/index.html --fields title:string,price:number",
          "Write a template with your coding agent and print the extracted JSON.",
        )
        .example("bunx turbo-crawl crawl https://example.com --tui", "Build the schema interactively."),
    handler: async (argv) => {
      const dataDir = argv["data-dir"] ?? (process.env.TURBO_CRAWL_DATA_DIR || undefined);
      const mode = chooseCrawlMode(argv, {
        interactiveTerminal: deps.isInteractiveTerminal(),
        bun: deps.isBunRuntime(),
      });

      // Errors are reported here: yargs does not hand async handler rejections to parse().
      if (mode === "tui-unavailable") {
        deps.stderr.write("error: The interactive TUI needs Bun. Run `bunx turbo-crawl crawl <url> --tui`, or drop --tui to run headless.\n");
        deps.setExitCode(2);
        return;
      }

      if (mode === "tui") {
        try {
          await deps.startInteractiveSession({
            target: argv.target,
            provider: argv.provider,
            model: argv.model,
            dataDir,
            maxRepairs: argv["max-repairs"],
          });
        } catch (error) {
          deps.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
          deps.setExitCode(1);
        }
        return;
      }

      deps.setExitCode(
        await deps.runHeadlessCrawl({
          target: argv.target,
          fields: argv.fields,
          provider: argv.provider,
          model: argv.model,
          dataDir,
          maxRepairs: argv["max-repairs"],
        }),
      );
    },
  };
}
