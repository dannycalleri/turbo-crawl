import type { CommandModule } from "yargs";
import type { HeadlessCrawlInput } from "../core/headless.ts";

export type CrawlArguments = {
  target: string;
  fields?: string;
  provider?: string;
  model?: string;
  "data-dir"?: string;
  "max-repairs"?: number;
  "user-agent"?: string;
  json?: boolean;
};

export type CrawlCommandDependencies = {
  runHeadlessCrawl(input: HeadlessCrawlInput): Promise<number>;
  setExitCode(code: number): void;
};

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
          describe: "Where templates and results are stored. Defaults to $TURBO_CRAWL_DATA_DIR, then ./data.",
        })
        .option("max-repairs", {
          type: "number",
          describe: "How many times the agent may fix selectors that failed on the page.",
          default: 2,
        })
        .option("user-agent", {
          type: "string",
          describe: "User agent for page requests. Defaults to userAgent in the nearest turbo-crawl.json, then in ~/.config/turbo-crawl/config.json, then turbo-crawl/<version>.",
        })
        .option("json", {
          type: "boolean",
          describe: "Accepted for compatibility. The result is always printed as JSON.",
        })
        .strictOptions()
        .example(
          "$0 crawl https://books.toscrape.com/catalogue/a-light-in-the-attic_1000/index.html --fields title:string,price:number",
          "Write a template with your coding agent and print the extracted JSON.",
        )
        .example("$0 crawl https://example.com", "Let the agent suggest the fields."),
    handler: async (argv) => {
      const dataDir = argv["data-dir"] ?? (process.env.TURBO_CRAWL_DATA_DIR || undefined);

      deps.setExitCode(
        await deps.runHeadlessCrawl({
          target: argv.target,
          fields: argv.fields,
          provider: argv.provider,
          model: argv.model,
          dataDir,
          maxRepairs: argv["max-repairs"],
          userAgent: argv["user-agent"],
        }),
      );
    },
  };
}
