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
  "ignore-robots"?: boolean;
  author?: boolean;
  artifacts?: boolean;
  require?: string;
  follow?: boolean;
  "max-pages"?: number;
  "max-items"?: number;
  "delay-ms"?: number;
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
    describe: "Extract structured data from a page. The first page of a layout gets a template written by a coding agent; later pages with the same layout reuse it without any model call, whatever their URL.",
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
          describe: "User agent for page and robots.txt requests. Defaults to userAgent in the nearest turbo-crawl.json, then in ~/.config/turbo-crawl/config.json, then turbo-crawl/<version>.",
        })
        .option("ignore-robots", {
          type: "boolean",
          describe: "Do not check robots.txt before rendering a page.",
        })
        .option("author", {
          type: "boolean",
          default: true,
          describe: "Let the agent write a template when none fits the page. --no-author never calls an agent and exits 3 instead.",
        })
        .option("require", {
          type: "string",
          describe: "Fields that must have a value for a saved template to fit, e.g. headline,body. Defaults to all of the template's fields.",
        })
        .option("artifacts", {
          type: "boolean",
          default: true,
          describe: "Save the page packet and result under the data folder. --no-artifacts saves only templates.",
        })
        .option("follow", {
          type: "boolean",
          default: true,
          describe: "On a listing page, extract every item and follow the pagination, printing one JSON line per item. --no-follow prints only the item and pagination URLs.",
        })
        .option("max-pages", {
          type: "number",
          describe: "Most listing pages to read when following a listing, the first one included.",
          default: 10,
        })
        .option("max-items", {
          type: "number",
          describe: "Most items to extract when following a listing.",
          default: 200,
        })
        .option("delay-ms", {
          type: "number",
          describe: "Milliseconds to wait before each page request when following a listing.",
          default: 250,
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
        .example("$0 crawl https://example.com", "Let the agent suggest the fields.")
        .example(
          "$0 crawl https://books.toscrape.com/catalogue/category/books/travel_2/index.html --fields title:string,price:number",
          "Follow a category: one JSON line per book.",
        ),
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
          ignoreRobots: argv["ignore-robots"],
          author: argv.author,
          artifacts: argv.artifacts,
          require: argv.require,
          follow: argv.follow,
          maxPages: argv["max-pages"],
          maxItems: argv["max-items"],
          delayMs: argv["delay-ms"],
        }),
      );
    },
  };
}
