# turbo-crawl

Turn any web page into structured JSON without writing selectors.

The first time you crawl a URL pattern, turbo-crawl asks a coding agent you already use (**Claude Code** or **Codex**) to read the page's structure and write an extraction template: CSS, JSON-LD, meta or table selectors for each field. Every selector is checked on the live page, and any that fail go back to the agent to fix. After that, every page matching the same pattern is scraped with the saved template, with **no model call**: it's fast, free and deterministic.

```console
$ npx turbo-crawl crawl https://books.toscrape.com/catalogue/a-light-in-the-attic_1000/index.html \
    --fields title:string,price:number,availability:text,upc:string
Using claude to write the template.
Asking claude to write selectors for 4 fields…
{
  "urlPattern": "/catalogue/:slug/index.html",
  "path": "authored",
  "llmUsed": true,
  "data": {
    "title": "A Light in the Attic",
    "price": 51.77,
    "availability": "In stock (22 available)",
    "upc": "a897fe39b1053632"
  },
  ...
}

$ npx turbo-crawl crawl https://books.toscrape.com/catalogue/sapiens-a-brief-history-of-humankind_996/index.html
Extracting with the saved template for /catalogue/:slug/index.html…
{
  "path": "template-reuse",
  "llmUsed": false,
  "data": { "title": "Sapiens: A Brief History of Humankind", "price": 54.23, ... }
}
```

## Requirements

- Node.js 20 or later.
- One template author:
  - [Claude Code](https://docs.claude.com/en/docs/claude-code) (`claude`), installed and logged in. This is the default.
  - or [Codex CLI](https://github.com/openai/codex) (`codex`), installed and logged in.
  - or a local [LM Studio](https://lmstudio.ai) server, via `--provider lmstudio`.
- Chromium for Playwright: `npx playwright install chromium`.

turbo-crawl runs the agent CLIs in headless mode with no tools and no access to your files. It sends them only a text outline of the page, and uses your existing login, so there are no API keys to configure.

## Usage

```bash
turbo-crawl crawl <url> [options]
```

| Option | Description |
| --- | --- |
| `--fields name:type,...` | Fields to extract. Types: `string`, `text`, `number`, `boolean`, `date`, `url`. Omit it and the agent suggests fields for the page. |
| `--provider <name>` | `auto` (default), `claude`, `codex` or `lmstudio`. `auto` picks `claude` if it is installed, otherwise `codex`. |
| `--model <id>` | Model passed to the provider (e.g. `sonnet` or `opus` for Claude). Defaults to the provider's own default. |
| `--data-dir <path>` | Where schemas, templates and results are stored. Default `./data`. |
| `--max-repairs <n>` | How many times the agent may fix failing selectors. Default `2`. |
| `--json` | Run without the TUI and print JSON. This is automatic when `--fields` is given, output is piped, or you are not running under Bun. |
| `--tui` / `--no-tui` | Force or disable the interactive TUI (needs Bun, see below). |

The result goes to stdout as JSON and progress goes to stderr, so `turbo-crawl crawl <url> --fields ... > item.json` works as expected. Exit codes: `0` success, `1` runtime error, `2` invalid arguments.

### Environment variables

| Variable | Purpose |
| --- | --- |
| `TURBO_CRAWL_PROVIDER` | Default provider when `--provider` is not given. |
| `TURBO_CRAWL_MODEL` | Default model. |
| `TURBO_CRAWL_DATA_DIR` | Default data directory. |
| `TURBO_CRAWL_LLM_TIMEOUT_MS` | Timeout for one agent call (default `600000`). |
| `TURBO_CRAWL_SKELETON_BYTES` | Size budget of the page outline sent to the agent (default `120000`). |
| `TURBO_CRAWL_CLAUDE_BIN`, `TURBO_CRAWL_CODEX_BIN` | Path to a specific `claude` or `codex` binary. |
| `TURBO_CRAWL_LMSTUDIO_URL` | LM Studio base URL (default `http://localhost:1234`). |

## How it works

1. **Render.** Playwright opens the page in headless Chromium, waits for the network to settle and dismisses cookie banners.
2. **Reuse.** turbo-crawl turns the URL into a pattern (`/products/black-bay-58` becomes `/products/:slug`, and `/item/123` becomes `/item/:id`). If a template exists for that pattern, it is used and no model is called.
3. **Author.** Otherwise the agent gets the field list, the page's JSON-LD, meta tags and tables, and a compact outline of the DOM (tags, ids, stable classes, semantic attributes, short text). It returns up to four ordered selectors per field.
4. **Validate and repair.** Each selector runs on the live page and its value is normalized to the field type. Fields with no working selector go back to the agent, along with what each selector actually read. Fields that still fail are left `null` with a warning.
5. **Save.** The template is saved and the page is extracted with it, so the first page and every later page go through the same extraction code.

### Data layout

```
data/<domain>/
  schemas/<timestamp>.json         field lists you created or the agent suggested
  templates/<hash>.json            one template per URL pattern and field set
  packets/<url-hash>/
    packet.json                    what was captured from the page
    packet.llm.json                the agent exchange, when a template was authored
    result.json                    the extraction result
```

Templates are plain JSON. You can review them, edit selectors by hand, or commit them next to your code.

## Interactive TUI (Bun)

With [Bun](https://bun.sh) installed, run the interactive schema builder:

```bash
bunx turbo-crawl crawl https://example.com --tui
```

It suggests stored templates and schemas for the domain, lets you build a schema field by field (or press Tab with no fields to let the agent suggest them), and shows the extracted values when the crawl is done.

## Development

```bash
bun install
bun run dev crawl <url>       # run from source
bun run typecheck
bun test
bun run build                 # dist/cli.js, runs on Node
```

See [AGENTS.md](AGENTS.md) for conventions.

## License

MIT
