# Reference

- [CLI](#cli)
- [Exit codes and errors](#exit-codes-and-errors)
- [Listing pages](#listing-pages)
- [How turbo-crawl selects a template](#how-turbo-crawl-selects-a-template)
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
| `--fields name:type,...` | The fields to extract. The types are `string`, `text`, `number`, `boolean`, `date` and `url`. When you do not give this option, the agent suggests the fields. |
| `--require name,...` | The fields that must have a value for a saved template to fit. The default is all the fields of the template. |
| `--no-author` | Do not call an agent. When no saved template fits, the CLI exits with code 3. Without an agent, only a saved listing template can identify a listing page. |
| `--provider <name>` | `auto` (the default), `claude`, `codex` or `lmstudio`. `auto` uses `claude` when it is installed. Otherwise, it uses `codex`. |
| `--model <id>` | The model for the provider, for example `sonnet` or `opus` for Claude. The default is the default model of the provider. |
| `--max-repairs <n>` | The maximum number of repair rounds for failed selectors. The default is `2`. |
| `--user-agent <ua>` | The user agent for page requests and robots.txt requests. Refer to [User agent](#user-agent). |
| `--ignore-robots` | Do not check robots.txt. Use this option only when the site gives you permission. |
| `--data-dir <path>` | The folder for templates and results. The default is `./data`. |
| `--no-artifacts` | Save only the templates. Do not save the page packets and the results. |
| `--json` | The CLI accepts this option for compatibility. The result is always JSON. |
| `--max-pages <n>` | For listing pages: the maximum number of listing pages to read, including the first page. The default is `10`. |
| `--max-items <n>` | For listing pages: the maximum number of items to try. This number includes the items that fail. The default is `200`. |
| `--delay-ms <n>` | For listing pages: the time to wait between two page requests, in milliseconds. The default is `250`. |
| `--no-follow` | For listing pages: print only the links of the listing, as one JSON object. |

Use the field types as follows:

- Use `text` for a long passage, for example the body of an article. A `text` field must have 200 characters or more, or the template does not fit.
- Use `string` for a short value.
- A `date` field keeps only dates in a machine format: ISO 8601, RFC 2822 or Unix time.

The CLI writes the result to stdout as JSON. It writes the progress messages to stderr. Thus you can send the result to a file:

```bash
turbo-crawl crawl <url> --fields title:string > item.json
```

## Exit codes and errors

The CLI also writes errors to stdout as JSON: `{ "ok": false, "code": "...", "message": "..." }`. There is one exception. For an unknown option or a missing URL, the CLI writes a plain message to stderr and exits with code 2.

| Exit code | Meaning |
| --- | --- |
| `0` | The crawl was successful. |
| `1` | The page failed (`BLOCKED`, `HTTP_ERROR`, `TIMEOUT` or `AMBIGUOUS_TEMPLATE`), or a different error occurred. |
| `2` | An argument or a config file is not valid. |
| `3` | `TEMPLATE_MISSING`: no saved template fits, and authoring is off. |
| `4` | `ROBOTS_DISALLOWED`: robots.txt does not allow this user agent to get the URL. |

HTTP 401, 403 and 429 give `BLOCKED`. All other 4xx and 5xx statuses give `HTTP_ERROR`.

## Listing pages

A listing page is a category page, an archive page or a search page. When you crawl a listing page, turbo-crawl extracts each item. It also follows the pagination until it has `--max-items` items.

### How turbo-crawl identifies a listing

1. No saved template fits the page, or a template gives a stale result, and authoring is on.
2. turbo-crawl asks the agent if the page is a listing.
3. For a listing, the agent writes link selectors for the items, the next page and the numbered pages.
4. The agent also writes two URL patterns: one for the listing pages and one for the item pages.
5. turbo-crawl runs each selector on the live page. An item selector passes when 2 or more of its links match the item pattern. turbo-crawl ignores the other links of the selector.
6. turbo-crawl saves the result as a listing template in `data/<domain>/listings/`.

After this, turbo-crawl reads all listing pages with the same layout without an agent call. This includes the pages of other categories.

A page whose URL matches the item pattern of a listing is never a listing. turbo-crawl does not ask the agent about this page.

### How turbo-crawl follows a listing

- turbo-crawl extracts each item as a detail page.
- When you do not give `--fields`, the agent suggests fields for the first item. turbo-crawl uses these fields for all the items.
- turbo-crawl extracts all the items of a listing page before it reads the next listing page.
- turbo-crawl reads the pagination pages with the listing template of the start page.

### Limits

- turbo-crawl visits each URL one time. It ignores the fragment and the `utm_*` parameters when it compares URLs.
- turbo-crawl visits only the host of the start URL.
- turbo-crawl checks robots.txt for each page.

### Output

The output has one JSON line for each item (NDJSON). When an item fails, its line has `"ok": false`, the `url`, the `code` and the `message`. The crawl then continues with the next item. turbo-crawl writes a summary to stderr.

The exit code is 0 when turbo-crawl extracts one item or more. The exit code is 1 when it extracts no item.

With `--no-follow`, the output is one JSON object: `{ "ok": true, "kind": "listing", "itemUrls": [...], "paginationUrls": [...], "templateFit": {...}, ... }`.

## How turbo-crawl selects a template

turbo-crawl renders the page first. Then it runs all the saved templates of the domain on the page, and it uses the template that fits. A template fits when all these conditions are true:

- Each required field has a value.
- One or more required fields have a CSS selector that reads a value on the page. This is necessary also when JSON-LD or a meta tag gives the value, because JSON-LD and meta tags match almost all pages.
- Each `text` field has 200 characters or more.

Example: you author an article template on `/news/clock-3`. turbo-crawl then uses the same template on `/2026/11/04/clock-3`, without an agent call. It also adds the new URL pattern to the template.

## URL patterns

A URL pattern tells which pages are the same type of page. turbo-crawl uses URL patterns for two tasks:

- To find a page whose layout changed.
- To make sure that a block of related products does not change a product page into a listing.

### The agent writes the pattern

When the agent authors a template, it also gives a URL pattern with placeholders, for example `/:brand/:slug--id:id.htm`. It also gives example links of the same page type and of other page types. All the examples must be links on the page.

turbo-crawl accepts the pattern only when all these conditions are true:

- The page URL matches the pattern.
- Each example of the same page type matches the pattern.
- No example of another page type matches the pattern.
- Each example is a link on the page.

When a condition is false, the agent gets a repair round. When the pattern fails again, the template uses a pattern that turbo-crawl makes from the URL. The result then has a warning.

### Syntax

- A placeholder is `:` and a lowercase name, for example `:slug`.
- `:id` matches only digits.
- All other placeholders match text without `/`.
- A URL can have more query keys than the pattern and still match.

### How patterns change

A template gets a new pattern only when it fits a page that none of its patterns match. turbo-crawl then:

1. Adds a pattern for that page.
2. Merges two patterns when they are different in one path segment. For example, `/rolex/:slug` and `/omega/:slug` become `/:slug/:slug`.
3. Keeps a maximum of 20 patterns.

### Stale results

A result is stale when no template fits the page, but the page URL matches a pattern of a template. turbo-crawl then marks the result `"stale": true` and adds a warning with the reason. A stale result usually means that the layout of the site changed. Author the template again.

When a listing template fits the page, turbo-crawl gives the listing result, not the stale result.

## User agent

turbo-crawl identifies itself honestly. It sends the first user agent that it finds in this list:

1. `--user-agent`.
2. `userAgent` in the nearest `turbo-crawl.json`. turbo-crawl looks for this file in the current folder and in each parent folder, up to the git root.
3. `userAgent` in `$XDG_CONFIG_HOME/turbo-crawl/config.json`. The default file is `~/.config/turbo-crawl/config.json`.
4. `turbo-crawl/<version> (+https://github.com/dannycalleri/turbo-crawl)`.

```json
{ "userAgent": "MyBot/1.0 (+https://example.com/bot)" }
```

When a config file is not valid, the run stops. The error gives the name of the file.

## robots.txt and policy signals

Before turbo-crawl renders a page, it reads the robots.txt of the host with the same user agent. It reads robots.txt again after a redirect to a different URL. turbo-crawl never gets a URL that robots.txt does not allow.

Each result has a `policy` object with these values:

- The result of the robots.txt check.
- The HTTP status.
- The `X-Robots-Tag` header.
- The robots meta tag.
- The TDM reservation signals: `tdm-reservation` and `tdm-policy`.

turbo-crawl only reports the TDM signals. It does not obey them for you. You decide what to do with them.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `TURBO_CRAWL_PROVIDER` | The default provider when you do not give `--provider`. |
| `TURBO_CRAWL_MODEL` | The default model. |
| `TURBO_CRAWL_DATA_DIR` | The default data folder. |
| `TURBO_CRAWL_LLM_TIMEOUT_MS` | The maximum time for one agent call, in milliseconds. The default is `600000`. |
| `TURBO_CRAWL_SKELETON_BYTES` | The maximum size of the page outline that turbo-crawl sends to the agent. The default is `120000`. |
| `TURBO_CRAWL_CLAUDE_BIN`, `TURBO_CRAWL_CODEX_BIN` | The path to a specific `claude` or `codex` binary. |
| `TURBO_CRAWL_LMSTUDIO_URL` | The base URL of LM Studio. The default is `http://localhost:1234`. |

## Library API

Install the package and Chromium:

```bash
npm install @fragmentoid/turbo-crawl playwright
npx playwright install chromium
```

### `createCrawler(options)`

The required options are `dataDir`, `userAgent` and `authoring` (`"never"` or `"allowed"`).

The optional options are:

- `respectRobots`. The default is `true`.
- `writeArtifacts`. The default is `false`.
- `navigationTimeoutMs`. The default is `30000`.
- `settleTimeoutMs`. The default is `10000`.
- `maxConcurrentPages`. The default is `4`.

The library does not read config files. One crawler uses one browser. You can run calls at the same time. When more than `maxConcurrentPages` calls run, the other calls wait.

### `extract(url, { fields?, require? })`

This call reads the page as a detail page. It gives `{ ok: true, data, missing, stale, canonicalUrl, fetchedAt, urlPattern, policy, templateFit, warnings, ... }`.

### `links(url)`

This call reads the page as a listing. It gives `{ ok: true, itemUrls: [{ url, text, urlPattern, cssPath }], paginationUrls, patterns, ... }`.

### Errors

An error gives `{ ok: false, code, message, policy }`. The code is one of these:

- `TEMPLATE_MISSING`
- `ROBOTS_DISALLOWED`
- `BLOCKED`, with `retryAfterSeconds`
- `HTTP_ERROR`
- `TIMEOUT`
- `AMBIGUOUS_TEMPLATE`

A call rejects only in these cases: an argument is not valid, Chromium is missing, or the agent fails when `authoring` is `"allowed"`.

### `close()`

This call waits for the running calls to complete. Then it closes the browser.

Each result has `schemaVersion: 1`. The package includes the TypeScript types.

## How it works

1. **Render.** Playwright opens the page in headless Chromium. It waits until the network is quiet, and it closes the cookie banners.
2. **Match.** turbo-crawl runs the saved listing templates and field templates of the domain on the page. When a template fits the content, turbo-crawl uses it and does not call a model.
3. **Classify.** When no template fits, the agent tells if the page is a listing. For a listing, it writes the link selectors and the URL patterns. turbo-crawl does not do this step for `crawler.extract()`, for the items of a listing, or for a URL that matches a saved item pattern. These pages are always detail pages.
4. **Author.** For a detail page, the agent gets the list of fields and the page data. The page data is the JSON-LD, the meta tags, the tables, the links to the same site, and a short outline of the DOM. The agent gives a maximum of four selectors for each field, in order, and the URL pattern of the page.
5. **Validate and repair.** turbo-crawl runs each selector on the live page and converts its value to the field type. When a field has no selector that works, turbo-crawl sends the field back to the agent, with the values that each selector read. When none of the selectors that work is a CSS selector, turbo-crawl asks the agent for a CSS selector. This is necessary because turbo-crawl matches templates to pages by their CSS selectors. When a field fails again, its value is `null` and the result has a warning.
6. **Save.** turbo-crawl saves the template and extracts the page with it. Thus the first page and all the subsequent pages use the same extraction code.

turbo-crawl runs the agent CLIs in headless mode. The agents have no tools and no access to your files. They get only a text outline of the page. They use your current login, so you do not need API keys.

## Data layout

```
data/<domain>/
  templates/<id>.json              field templates, each with the URL patterns that it fitted
  listings/<id>.json               listing templates
  packets/<url-hash>/
    packet.json                    the data that turbo-crawl captured from the page
    packet.llm.json                the messages with the agent, when the agent authored a template
    result.json                    the extraction result
```

The templates are plain JSON files. You can examine them, change selectors manually, or commit them with your code.
