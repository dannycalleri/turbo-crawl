# Reference

- [CLI](#cli)
- [Exit codes and errors](#exit-codes-and-errors)
- [Listing pages](#listing-pages)
- [How a template is chosen](#how-a-template-is-chosen)
- [URL patterns](#url-patterns)
- [User agent](#user-agent)
- [robots.txt and policy signals](#robotstxt-and-policy-signals)
- [Environment variables](#environment-variables)
- [Library API](#library-api)
- [How it works](#how-it-works)
- [Data layout](#data-layout)

## CLI

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
| `--max-pages <n>` | Listing pages only: most listing pages to read, the first one included. Default `10`. |
| `--max-items <n>` | Listing pages only: most items to try, extracted or failed. Default `200`. |
| `--delay-ms <n>` | Listing pages only: milliseconds to wait between two page requests. Default `250`. |
| `--no-follow` | Listing pages only: print only the listing's links, as one JSON object. |

Field types: use `text` for long passages such as an article body, and `string` for short values. A `text` field needs at least 200 characters for a template to fit. A `date` field keeps only machine-readable dates (ISO 8601, RFC 2822, Unix time).

The result goes to stdout as JSON and progress goes to stderr, so `turbo-crawl crawl <url> --fields ... > item.json` works as expected.

## Exit codes and errors

Errors are JSON on stdout too: `{ "ok": false, "code": "...", "message": "..." }`. The exception is an unknown option or a missing URL: the CLI prints a plain message on stderr and exits 2.

| Exit code | Meaning |
| --- | --- |
| `0` | Success. |
| `1` | The page failed (`BLOCKED`, `HTTP_ERROR`, `TIMEOUT`, `AMBIGUOUS_TEMPLATE`) or another error. |
| `2` | Invalid arguments or an invalid config file. |
| `3` | `TEMPLATE_MISSING`: no saved template fits and authoring is off. |
| `4` | `ROBOTS_DISALLOWED`: robots.txt disallows the URL for this user agent. |

HTTP 401, 403 and 429 give `BLOCKED`; other 4xx and 5xx give `HTTP_ERROR`.

## Listing pages

Point turbo-crawl at a category, archive or search page and it extracts every item, following the pagination, up to `--max-items`.

- **Recognizing a listing.** When no saved template fits a page or gives a stale result, and authoring is on, turbo-crawl asks the agent if the page is a listing. For a listing, the agent writes link selectors for the items, the next page and the numbered pages, plus the URL pattern of the listing pages and of the item pages. An item selector passes when at least 2 of its links match the item pattern; other links it reads are dropped. Everything is checked on the live page and saved as a listing template in `data/<domain>/listings/`. Later listing pages with the same layout, on this or other categories, are read with no agent call. A page whose URL matches a listing's item pattern is never read as a listing, and the agent is not asked about it.
- **Following it.** Each item is extracted as a detail page. When `--fields` is not given, the fields the agent suggests for the first item are used for all of them. All the items of a listing page are extracted before the next listing page is read. Pagination pages are read with the start page's listing template.
- **Staying polite.** Each URL is visited once (ignoring the fragment and `utm_*` parameters), only on the start URL's host, with robots.txt checked for every page.

The output is one JSON line per item (NDJSON). A failed item gives a line with `"ok": false`, its `url`, `code` and `message`, and the crawl goes on. A summary goes to stderr. The command exits 0 when at least one item was extracted, and 1 when none was.

With `--no-follow`, the output is one JSON object: `{ "ok": true, "kind": "listing", "itemUrls": [...], "paginationUrls": [...], "templateFit": {...}, ... }`.

## How a template is chosen

turbo-crawl renders the page first, runs every saved template of the domain on it, and keeps the one that fits. A template fits when:

- every required field has a value;
- at least one required field has a CSS selector that reads a value on the page, even when JSON-LD or meta supplied the value (JSON-LD and meta tags alone match almost any page);
- every `text` field has at least 200 characters.

So an article layout authored on `/news/clock-3` is reused on `/2026/11/04/clock-3` with no agent call, and the new URL pattern is added to the template.

## URL patterns

A URL pattern says which pages are the same kind of page. turbo-crawl uses it to tell a changed layout from a different page, and to keep a related-products block from turning a product page into a listing.

- **The agent writes the pattern.** When it authors a template, the agent also returns a pattern with placeholders, such as `/:brand/:slug--id:id.htm`, plus example links from the page of the same type and of other types. turbo-crawl accepts the pattern only when the page URL and every same-type example match it, no other-type example matches it, and every example is a real link on the page. Otherwise the agent gets a repair round; if the pattern still fails, the template uses a pattern inferred from the URL alone, and the result has a warning.
- **Syntax.** A placeholder is `:` and a lowercase name. `:id` stands for digits; any other placeholder stands for text without `/`. Extra query keys in a URL do not stop a match.
- **Patterns grow only by fits.** When a template fits a page that none of its patterns match, turbo-crawl adds a pattern for that page, merges patterns that differ in one path segment (`/rolex/:slug` and `/omega/:slug` become `/:slug/:slug`), and keeps at most 20.
- **Stale results.** When no template fits, but a template has a pattern that the page URL matches, the result is marked `"stale": true` with a warning that names the reason: the site layout has probably changed, and the template should be authored again. A listing template that fits the page wins over a stale result.

## User agent

turbo-crawl identifies itself honestly. It sends the first user agent it finds in:

1. `--user-agent`;
2. `userAgent` in the nearest `turbo-crawl.json`, searched from the current folder up to the git root;
3. `userAgent` in `$XDG_CONFIG_HOME/turbo-crawl/config.json` (default `~/.config/turbo-crawl/config.json`);
4. `turbo-crawl/<version> (+https://github.com/dannycalleri/turbo-crawl)`.

```json
{ "userAgent": "MyBot/1.0 (+https://example.com/bot)" }
```

An invalid config file stops the run with an error that names the file.

## robots.txt and policy signals

Before it renders a page, turbo-crawl reads the host's robots.txt with the same user agent, and again after a redirect to another URL. A disallowed URL is never fetched. Every result has a `policy` object with the robots.txt verdict, the HTTP status, the `X-Robots-Tag` header, the robots meta tag, and the TDM reservation signals (`tdm-reservation`, `tdm-policy`). TDM signals are reported, not enforced: what you do with them is your decision.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `TURBO_CRAWL_PROVIDER` | Default provider when `--provider` is not given. |
| `TURBO_CRAWL_MODEL` | Default model. |
| `TURBO_CRAWL_DATA_DIR` | Default data directory. |
| `TURBO_CRAWL_LLM_TIMEOUT_MS` | Timeout for one agent call (default `600000`). |
| `TURBO_CRAWL_SKELETON_BYTES` | Size budget of the page outline sent to the agent (default `120000`). |
| `TURBO_CRAWL_CLAUDE_BIN`, `TURBO_CRAWL_CODEX_BIN` | Path to a specific `claude` or `codex` binary. |
| `TURBO_CRAWL_LMSTUDIO_URL` | LM Studio base URL (default `http://localhost:1234`). |

## Library API

```bash
npm install @fragmentoid/turbo-crawl playwright
npx playwright install chromium
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
3. **Classify.** Otherwise, the agent decides whether the page is a listing and writes its link selectors and URL patterns. `crawler.extract()`, the items of a followed listing, and URLs that match a saved item pattern skip this step: they are always detail pages.
4. **Author.** For a detail page, the agent gets the field list, the page's JSON-LD, meta tags and tables, its same-site links, and a compact outline of the DOM (tags, ids, stable classes, semantic attributes, short text). It returns up to four ordered selectors per field and the page's URL pattern.
5. **Validate and repair.** Each selector runs on the live page and its value is normalized to the field type. Fields with no working selector go back to the agent, along with what each selector actually read. When no working selector is a CSS selector, the agent is asked for one, because templates are matched to pages by their page-body selectors. Fields that still fail are left `null` with a warning.
6. **Save.** The template is saved and the page is extracted with it, so the first page and every later page go through the same extraction code.

The agent CLIs run in headless mode with no tools and no access to your files. They get only a text outline of the page, and use your existing login, so there are no API keys to configure.

## Data layout

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
