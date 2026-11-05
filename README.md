# turbo-crawl

Turn any web page into structured JSON without writing selectors.

The first time turbo-crawl sees a page layout, it asks a coding agent you already use (**Claude Code** or **Codex**) to read the page's structure and write an extraction template: CSS, JSON-LD, meta or table selectors for each field. Every selector is checked on the live page, and any that fail go back to the agent to fix. After that, every page with the same layout is scraped with the saved template, whatever its URL, with **no model call**: it's fast, free and deterministic.

```console
$ npx @fragmentoid/turbo-crawl crawl https://books.toscrape.com/catalogue/a-light-in-the-attic_1000/index.html \
    --fields title:string,price:number,availability:string,upc:string
Rendering https://books.toscrape.com/catalogue/a-light-in-the-attic_1000/index.html…
Using claude to write the template.
Asking claude to write selectors for 4 fields…
{
  "ok": true,
  "kind": "item",
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

$ npx @fragmentoid/turbo-crawl crawl https://books.toscrape.com/catalogue/sapiens-a-brief-history-of-humankind_996/index.html
Rendering https://books.toscrape.com/catalogue/sapiens-a-brief-history-of-humankind_996/index.html…
Extracted with the saved template data/books.toscrape.com/templates/dc69babc39c9291d.json.
{
  "ok": true,
  "kind": "item",
  "path": "template-reuse",
  "llmUsed": false,
  "data": { "title": "Sapiens: A Brief History of Humankind", "price": 54.23, ... }
}
```

turbo-crawl also works as a Node library, for jobs that must never call a model: author templates on your machine, commit them, and extract in CI with `authoring: "never"`.

## Requirements

- Node.js 20 or later.
- Chromium for Playwright: `npx playwright install chromium`.
- One template author, only where templates are written:
  - [Claude Code](https://docs.claude.com/en/docs/claude-code) (`claude`), installed and logged in. This is the default.
  - or [Codex CLI](https://github.com/openai/codex) (`codex`), installed and logged in.
  - or a local [LM Studio](https://lmstudio.ai) server, via `--provider lmstudio`.

turbo-crawl runs the agent CLIs in headless mode with no tools and no access to your files. It sends them only a text outline of the page, and uses your existing login, so there are no API keys to configure.

## Install

```bash
npm install -g @fragmentoid/turbo-crawl   # provides the `turbo-crawl` command
npx playwright install chromium
```

Or run it without installing: `npx @fragmentoid/turbo-crawl crawl <url> ...`. `playwright` (1.50 or later) is a peer dependency; npm installs it for you.

## Usage

```bash
turbo-crawl crawl <url> [options]
```

| Option | Description |
| --- | --- |
| `--fields name:type,...` | Fields to extract. Types: `string`, `text`, `number`, `boolean`, `date`, `url`. Omit it and the agent suggests fields for the page. |
| `--require name,...` | Fields that must have a value for a saved template to fit. Default: all of the template's fields. |
| `--no-author` | Never call an agent. When no saved template fits, exit 3. Without an agent, only a saved listing template can recognize a listing page. |
| `--provider <name>` | `auto` (default), `claude`, `codex` or `lmstudio`. `auto` picks `claude` if it is installed, otherwise `codex`. |
| `--model <id>` | Model passed to the provider (e.g. `sonnet` or `opus` for Claude). Defaults to the provider's own default. |
| `--max-repairs <n>` | How many times the agent may fix failing selectors. Default `2`. |
| `--user-agent <ua>` | User agent for page and robots.txt requests. See [User agent](#user-agent). |
| `--ignore-robots` | Do not check robots.txt. Use it only with the site's permission. |
| `--data-dir <path>` | Where templates and results are stored. Default `./data`. |
| `--no-artifacts` | Save only templates, not the page packets and results. |
| `--json` | Accepted for compatibility. The result is always JSON. |

The result goes to stdout as JSON and progress goes to stderr, so `turbo-crawl crawl <url> --fields ... > item.json` works as expected. Errors are JSON on stdout too: `{ "ok": false, "code": "...", "message": "..." }`. The exception is an unknown option or a missing URL: the CLI prints a plain message on stderr and exits 2.

| Exit code | Meaning |
| --- | --- |
| `0` | Success. |
| `1` | The page failed (`BLOCKED`, `HTTP_ERROR`, `TIMEOUT`, `AMBIGUOUS_TEMPLATE`) or another error. |
| `2` | Invalid arguments or an invalid config file. |
| `3` | `TEMPLATE_MISSING`: no saved template fits and authoring is off. |
| `4` | `ROBOTS_DISALLOWED`: robots.txt disallows the URL for this user agent. |

### Templates are chosen by content

turbo-crawl renders the page first, runs every saved template of the domain on it, and keeps the one that fits. A template fits when every required field has a value, at least one of them comes from a CSS selector in the page body (meta tags alone match almost any page), and every `text` field has at least 200 characters. Use `text` for long passages such as an article body, and `string` for short values. So an article layout authored on `/news/clock-3` is reused on `/2026/11/04/clock-3` with no agent call, and the new URL pattern is added to the template.

The URL pattern is still a hint. When a template that knows the page's URL pattern no longer fits, the result is marked `"stale": true` with a warning that names the reason: the site layout has probably changed, and the template should be authored again.

### Listing pages

Point turbo-crawl at a category, archive or search page and it extracts every item, following the pagination, up to `--max-items`:

```console
$ turbo-crawl crawl https://books.toscrape.com/catalogue/category/books/mystery_3/index.html \
    --fields title:string,price:number --max-items 25 > books.ndjson
…
Crawled 2 listing page(s): 25 item(s) extracted, 0 failed.

$ head -1 books.ndjson
{"ok":true,"kind":"item","url":"https://books.toscrape.com/catalogue/sharp-objects_997/index.html","data":{"title":"Sharp Objects","price":47.82},...}
```

- **Recognizing a listing.** When no saved template fits a page and the page links to at least 4 pages that share one URL shape other than its own, turbo-crawl asks the agent if the page is a listing. For a listing, the agent writes link selectors for the items, the next page and the numbered pages. They are checked on the live page and saved as a listing template in `data/<domain>/listings/`. Later listing pages with the same layout, on this or other categories, are read with no agent call.
- **Following it.** Each item is extracted as a detail page. When `--fields` is not given, the fields the agent suggests for the first item are used for all of them. All the items of a listing page are extracted before the next listing page is read. Pagination pages are read with the start page's listing template.
- **Staying polite.** Each URL is visited once (ignoring the fragment and `utm_*` parameters), only on the start URL's host, with robots.txt checked for every page.

| Option | Description |
| --- | --- |
| `--max-pages <n>` | Most listing pages to read, the first one included. Default `10`. |
| `--max-items <n>` | Most items to try, extracted or failed. Default `200`. |
| `--delay-ms <n>` | Milliseconds to wait between two page requests. Default `250`. |
| `--no-follow` | Print only the listing's links, as one JSON object: `{ "ok": true, "kind": "listing", "itemUrls": [...], "paginationUrls": [...], "templateFit": {...}, ... }`. |

The output is one JSON line per item (NDJSON). A failed item gives a line with `"ok": false`, its `url`, `code` and `message`, and the crawl goes on. A summary goes to stderr. The command exits 0 when at least one item was extracted, and 1 when none was.

### User agent

turbo-crawl identifies itself honestly. It sends the first user agent it finds in:

1. `--user-agent`;
2. `userAgent` in the nearest `turbo-crawl.json`, searched from the current folder up to the git root;
3. `userAgent` in `$XDG_CONFIG_HOME/turbo-crawl/config.json` (default `~/.config/turbo-crawl/config.json`);
4. `turbo-crawl/<version> (+https://github.com/dannycalleri/turbo-crawl)`.

```json
{ "userAgent": "MyBot/1.0 (+https://example.com/bot)" }
```

An invalid config file stops the run with an error that names the file.

### robots.txt and policy signals

Before it renders a page, turbo-crawl reads the host's robots.txt with the same user agent, and again after a redirect to another URL. A disallowed URL is never fetched. Every result has a `policy` object with the robots.txt verdict, the HTTP status, the `X-Robots-Tag` header, the robots meta tag, and the TDM reservation signals (`tdm-reservation`, `tdm-policy`). TDM signals are reported, not enforced: what you do with them is your decision.

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

## Library

```bash
npm install @fragmentoid/turbo-crawl playwright
npx playwright install chromium
```

```ts
import { createCrawler } from "@fragmentoid/turbo-crawl";

const crawler = createCrawler({
  dataDir: "templates",                                  // templates you authored and committed
  userAgent: "MyBot/1.0 (+https://example.com/bot)",     // required, no default
  authoring: "never",                                    // never start an agent
});

const index = await crawler.links("https://site.example/news");
if (index.ok) {
  for (const item of index.itemUrls) {
    const article = await crawler.extract(item.url, { require: ["headline", "body"] });
    if (article.ok) console.log(article.canonicalUrl, article.data, article.missing);
    else console.error(article.code, article.message);
  }
}

await crawler.close();
```

- **`createCrawler(options)`**: `dataDir`, `userAgent` and `authoring` (`"never"` or `"allowed"`) are required. Optional: `respectRobots` (default `true`), `writeArtifacts` (default `false`), `navigationTimeoutMs` (30000), `settleTimeoutMs` (10000) and `maxConcurrentPages` (4). The library reads no config files. One crawler shares one browser; calls may run at the same time, and calls beyond `maxConcurrentPages` wait their turn.
- **`extract(url, { fields?, require? })`** treats the page as a detail page and resolves to `{ ok: true, data, missing, stale, canonicalUrl, fetchedAt, urlPattern, policy, templateFit, warnings, ... }`.
- **`links(url)`** treats the page as a listing and resolves to `{ ok: true, itemUrls: [{ url, text, urlPattern, cssPath }], paginationUrls, patterns, ... }`.
- **Errors resolve** to `{ ok: false, code, message, policy }` with a code from `TEMPLATE_MISSING`, `ROBOTS_DISALLOWED`, `BLOCKED` (with `retryAfterSeconds`), `HTTP_ERROR`, `TIMEOUT` and `AMBIGUOUS_TEMPLATE`. A call rejects only for invalid arguments, a missing Chromium, or an agent failure when authoring is `"allowed"`.
- **`close()`** waits for running calls, then closes the browser.

Every result has `schemaVersion: 1`. The types ship with the package.

## How it works

1. **Render.** Playwright opens the page in headless Chromium, waits for the network to settle and dismisses cookie banners.
2. **Match.** Saved listing templates and field templates of the domain run on the page; the one that fits the content is used, and no model is called.
3. **Classify.** Otherwise, if the page links to at least 4 pages with one URL shape other than its own, the agent decides whether it is a listing and writes its link selectors.
4. **Author.** For a detail page, the agent gets the field list, the page's JSON-LD, meta tags and tables, and a compact outline of the DOM (tags, ids, stable classes, semantic attributes, short text). It returns up to four ordered selectors per field.
5. **Validate and repair.** Each selector runs on the live page and its value is normalized to the field type. Dates are kept only in machine-readable forms (ISO 8601, RFC 2822, Unix time). Fields with no working selector go back to the agent, along with what each selector actually read. Fields that still fail are left `null` with a warning.
6. **Save.** The template is saved and the page is extracted with it, so the first page and every later page go through the same extraction code.

### Data layout

```
data/<domain>/
  templates/<id>.json              field templates, each with the URL patterns it fitted
  listings/<id>.json               listing templates
  packets/<url-hash>/
    packet.json                    what was captured from the page
    packet.llm.json                the agent exchange, when a template was authored
    result.json                    the extraction result
```

Templates are plain JSON. You can review them, edit selectors by hand, or commit them next to your code.

## Upgrading from 0.1

Version 0.2 changes some defaults and outputs:

- **The TUI is gone.** `turbo-crawl crawl` always runs headless, and `--tui` is now an unknown option (exit 2).
- **Honest user agent.** Requests send `turbo-crawl/<version> (+https://github.com/dannycalleri/turbo-crawl)` instead of a Chrome user agent. Set your own with `--user-agent`, `turbo-crawl.json` or `~/.config/turbo-crawl/config.json`.
- **robots.txt is respected.** A disallowed URL is not fetched and the CLI exits 4. `--ignore-robots` turns the check off.
- **Templates are chosen by page content, not by URL pattern.** Template files are now `templates/<id>.json` with a list of `urlPatterns`. Files from 0.1.0 (one `urlPattern`) are still read. A `text` field must now have at least 200 characters for a template to fit: use `string` for short values.
- **New exit codes and JSON errors.** Errors print `{ "ok": false, "code", "message" }` on stdout (an unknown option or a missing URL still prints plain text on stderr, exit 2). Exit 3 is `TEMPLATE_MISSING`, exit 4 is `ROBOTS_DISALLOWED`. HTTP 401, 403 and 429 give `BLOCKED`; other 4xx and 5xx give `HTTP_ERROR`.
- **Dates in prose are not parsed.** A `date` field keeps only machine-readable dates (ISO 8601, RFC 2822, Unix time); `4 novembre 2026` becomes `null`.
- **`playwright` is a peer dependency** (`>=1.50 <2`). npm 7 and later install it for you.

## Development

```bash
bun install
bun run dev crawl <url>       # run from source
bun run typecheck
bun run test                  # plain, browser and e2e tests, in three processes
bun run build                 # dist/cli.js and dist/lib.js, run on Node
```

See [AGENTS.md](AGENTS.md) for conventions.

### Releases

Releases are automatic. Every merge to `main` updates an open release pull request with the next version and the changelog, built by [release-please](https://github.com/googleapis/release-please) from the conventional commit messages (`feat:`, `fix:`, `feat!:` for a breaking change). Merging that pull request tags the version, creates the GitHub release with its [changelog](CHANGELOG.md), and publishes the package to npm with provenance. While the version is below 1.0, a breaking change raises the minor version.

## License

MIT
