# Reference

- [CLI](#cli)
- [Exit codes and errors](#exit-codes-and-errors)
- [Listing pages](#listing-pages)
- [How turbo-crawl selects a template](#how-turbo-crawl-selects-a-template)
- [URL patterns](#url-patterns)
- [User agent](#user-agent)
- [robots.txt and policy signals](#robotstxt-and-policy-signals)
- [Chromium](#chromium)
- [Environment variables](#environment-variables)
- [Library API](#library-api)
- [How it works](#how-it-works)
- [Data layout](#data-layout)

## CLI

```bash
npx @fragmentoid/turbo-crawl crawl <url> [options]
```

After a global install (`npm install -g @fragmentoid/turbo-crawl`), you can type `turbo-crawl crawl <url> [options]`.

When Chromium for Playwright is missing, turbo-crawl downloads it on the first run. Refer to [Chromium](#chromium).

| Option | Description |
| --- | --- |
| `--fields name:type,...` | The fields to extract. The types are `string`, `text`, `number`, `boolean`, `date`, `url` and `pairs`. When you do not give this option, the agent suggests the fields. |
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
- Use `pairs` for all the label/value rows of one part of the page, for example a specification table. Refer to [Pairs fields](#pairs-fields).

### Pairs fields

A `pairs` field has one `css` or `xpath` selector for the element that holds the rows. On each page, turbo-crawl reads all the rows in that element. Thus one template also reads rows that the authoring page did not have. When the selector finds more than one element, turbo-crawl reads only the first element and adds a warning.

Example: a template has the fields `price:number,specs:pairs`, and the selector of `specs` is `table.specs`. The template was made on an item with 3 specification rows. On an item with 5 rows, the same template gives all 5 rows:

```json
{ "price": 4200, "specs": { "Marca": "Omega", "Modello": "Seamaster", "Numero di referenza": "210.30", "Larghezza ansa": "20 mm", "Diametro": "42 mm" } }
```

turbo-crawl reads these rows:

- A table row (`tr`) with two or more cells that have text. The first cell is the label. The next cell is the value.
- A `dt` and the first `dd` after it.
- An element with two child elements that have text. The first child is the label. The second child is the value.

When the value is an inline element, such as `<span>`, that holds two inline elements, for example `<span><b>40</b> <small>mm</small></span>`, turbo-crawl reads it as one value: `40 mm`. When a child holds a pair of other elements, for example two `div` elements, turbo-crawl reads that pair as a row. The element beside it is a title, not a label.

turbo-crawl removes a `:` at the end of a label. When two rows have the same label, turbo-crawl keeps the first value and adds a warning. A row in a row that turbo-crawl read already does not give a second pair.

A `pairs` field must have 3 or more pairs. When it has fewer, the value is `null`, and the field has a warning. If an item can have fewer than 3 rows, do not put the `pairs` field in `--require` (`require` in the library). Then the template fits, and only the `pairs` field is `null`.

The labels are the text of the page, in the language of the page. turbo-crawl does not change them to your field names.

The agent does not suggest a `pairs` field. To get one, put it in `--fields`.

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

1. Adds a pattern for that page. The pattern keeps the file extension and an id part after `--`. For example, `/rolex/x--id1.htm` gives `/rolex/:slug--id:id.htm`, and `/rolex/x--mod37.htm` gives `/rolex/:slug--mod:id.htm`. Thus a detail page and a model page get different patterns.
2. Merges two patterns when they are different in one path segment. For example, `/rolex/:slug--id:id.htm` and `/omega/:slug--id:id.htm` become `/:slug/:slug--id:id.htm`.
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

`extractHtml()` does not read robots.txt, because it does not get the page. Refer to [`extractHtml`](#extracthtml-url-html-fields-require-).

Each result has a `policy` object with these values:

- The result of the robots.txt check.
- The HTTP status.
- The `X-Robots-Tag` header.
- The robots meta tag.
- The TDM reservation signals: `tdm-reservation` and `tdm-policy`.

turbo-crawl only reports the TDM signals. It does not obey them for you. You decide what to do with them.

## Chromium

turbo-crawl renders each page in Chromium for Playwright. When Chromium is missing, turbo-crawl downloads it one time and then continues:

1. turbo-crawl writes "Chromium for Playwright is not installed. Downloading it (one time)…" to stderr.
2. Playwright downloads Chromium Headless Shell, in the version that matches the installed `playwright` package. The download is about 100 MB.
3. Playwright shows the progress on stderr. On a terminal, it shows a progress bar. In other cases, it writes one line for each 10%.
4. turbo-crawl starts Chromium and continues the crawl.

The progress never goes to stdout. Thus the JSON result on stdout stays valid.

When the download fails, the crawl stops with an error. Run `npx playwright install --with-deps --only-shell chromium`, then try again.

### In CI

CI also gets Chromium with this download. Two items need attention:

- **Cache the download.** Without a cache, each CI run downloads Chromium again. Playwright keeps the browsers in `~/.cache/ms-playwright` on Linux, `~/Library/Caches/ms-playwright` on macOS and `%USERPROFILE%\AppData\Local\ms-playwright` on Windows. Cache this folder, with the `playwright` version in the cache key.
- **Install the system libraries.** On Linux, Chromium needs some system libraries. The GitHub `ubuntu-latest` runners have most of them. On a minimal image, run `npx playwright install --with-deps --only-shell chromium` before the crawl. This command needs root. You can also use the official Playwright Docker image. When the libraries are missing, the crawl stops with an error that gives this command.

Example for GitHub Actions. The project lists `@fragmentoid/turbo-crawl` and `playwright` in `package.json`. Thus `package-lock.json` sets the `playwright` version, and the cache key changes when that version changes.

```yaml
- run: npm ci
- uses: actions/cache@v4
  with:
    path: ~/.cache/ms-playwright
    key: playwright-${{ runner.os }}-${{ hashFiles('package-lock.json') }}
- run: npx turbo-crawl crawl https://shop.example/products/clock --no-author --data-dir templates
```

## Environment variables

| Variable | Purpose |
| --- | --- |
| `TURBO_CRAWL_PROVIDER` | The default provider when you do not give `--provider`. The library does not use it when you give the `provider` option. |
| `TURBO_CRAWL_MODEL` | The default model of `claude`, `codex` and LM Studio. With the library `provider` option, use the `model` option. |
| `TURBO_CRAWL_DATA_DIR` | The default data folder. |
| `TURBO_CRAWL_LLM_TIMEOUT_MS` | The maximum time for one agent call, in milliseconds. The default is `600000`. This limit also applies to the library `provider` option. |
| `TURBO_CRAWL_SKELETON_BYTES` | The maximum size of the page outline that turbo-crawl sends to the agent. The default is `120000`. |
| `TURBO_CRAWL_CLAUDE_BIN`, `TURBO_CRAWL_CODEX_BIN` | The path to a specific `claude` or `codex` binary. |
| `TURBO_CRAWL_LMSTUDIO_URL` | The base URL of LM Studio. The default is `http://localhost:1234`. |

## Library API

Install the package:

```bash
npm install @fragmentoid/turbo-crawl playwright
```

The library also downloads Chromium when it is missing. Refer to [Chromium](#chromium).

### `createCrawler(options)`

The required options are `userAgent`, `authoring` (`"never"` or `"allowed"`), and `dataDir` or `store`. `dataDir` is also necessary when `writeArtifacts` is `true`, because page packets and agent transcripts are files.

The optional options are:

- `respectRobots`. The default is `true`.
- `writeArtifacts`. The default is `false`.
- `navigationTimeoutMs`. The default is `30000`.
- `settleTimeoutMs`. The default is `10000`.
- `maxConcurrentPages`. The default is `4`.
- `provider`. Your own model client. Refer to [Your own model client](#your-own-model-client).
- `model`. The model id that turbo-crawl sends to `provider`. It is valid only with `provider`. For `claude`, `codex` and LM Studio, use `TURBO_CRAWL_MODEL`.
- `store`. Your own template storage. Refer to [Your own template store](#your-own-template-store).

The library does not read config files. One crawler uses one browser. You can run calls at the same time. When more than `maxConcurrentPages` calls run, the other calls wait.

### Your own model client

By default, turbo-crawl starts `claude`, `codex` or LM Studio when it must write a template. A server often has no CLI login. It calls models through its own client or gateway. For this case, give the `provider` option.

`provider` is an object with a `completeStructured(request)` function. The optional `name` shows in progress messages and errors. The default is `"custom"`. turbo-crawl uses it for every agent call: the page kind, the field suggestion, the template, the repair rounds and the URL pattern. It then does not look for `claude` or `codex`, and it does not read `TURBO_CRAWL_PROVIDER`. When `authoring` is `"never"`, turbo-crawl does not call the object.

The request has these values:

| Value | Description |
| --- | --- |
| `model` | The `model` option, or `null` when you do not give it. |
| `messages` | The system message and the user message, as `{ role, content }`. |
| `jsonSchema` | The JSON Schema of the answer. |
| `temperature` | Optional. turbo-crawl sends `0`. |
| `maxTokens` | Optional. turbo-crawl does not set it at this time. |
| `timeoutMs` | The value of `TURBO_CRAWL_LLM_TIMEOUT_MS`. The default is `600000`. |
| `signal` | An `AbortSignal`. turbo-crawl aborts it when `timeoutMs` passes. |

The function must resolve to `{ parsed, raw }`. `parsed` is the answer as a JSON value. turbo-crawl examines `parsed` with the same schema as an answer from `claude` or `codex`. When the answer is not correct, turbo-crawl repairs or rejects it in the same way. `raw` goes into the agent transcript when `writeArtifacts` is `true`.

When the function does not resolve before `timeoutMs`, turbo-crawl aborts `signal`, and the call rejects with an error that gives the time and `TURBO_CRAWL_LLM_TIMEOUT_MS`. Give `signal` to your client, so that your client also stops the request.

Example with the `ai` package (it is not a dependency of turbo-crawl):

```ts
import { generateObject, jsonSchema } from "ai";
import { createCrawler, type LLMProvider } from "@fragmentoid/turbo-crawl";

const provider: LLMProvider = {
  name: "gateway",
  async completeStructured({ model, messages, jsonSchema: schema, signal }) {
    const { object } = await generateObject({
      model: model ?? "provider/model-id",
      messages,
      schema: jsonSchema(schema as object),
      abortSignal: signal,
    });
    return { parsed: object, raw: object };
  },
};

const crawler = createCrawler({
  dataDir: "templates",
  userAgent: "MyBot/1.0 (+https://example.com/bot)",
  authoring: "allowed",
  provider,
  model: "provider/model-id",
});
```

The package exports the types `LLMProvider`, `LLMRequest`, `LLMResponse` and `LLMMessage`.

### Your own template store

By default, turbo-crawl keeps the templates as files under `dataDir`. Refer to [Data layout](#data-layout). A server in a container that does not keep files must keep the templates in other storage, for example a database. For this case, give the `store` option.

`store` is an object with these functions:

| Function | Description |
| --- | --- |
| `listTemplates(domain)` | Resolves to the field templates of the domain, as `[{ ref, template }]`. |
| `listListingTemplates(domain)` | Resolves to the listing templates of the domain, as `[{ ref, template }]`. |
| `saveTemplate(template)` | Saves a field template and resolves to its `ref`. A template with the same `id` replaces the old template. |
| `saveListingTemplate(template)` | The same for a listing template. |
| `updateTemplate(ref, update)` | Reads the field template, calls `update(template)`, and saves the template that `update` returns. |
| `updateListingTemplate(ref, update)` | The same for a listing template. |

- `domain` is the host name in lower case, without `www.`. Example: `shop.example`.
- `ref` is your id for a template, as a string. turbo-crawl gives it back in `updateTemplate` and `updateListingTemplate`, and as `templateFit.templatePath`.
- `template` is JSON. Keep all its properties. turbo-crawl reads `id`, `domain`, `urlPatterns` and many other properties.

**An update must be one operation.** Two calls can fit the same template at the same time, and each call adds a URL pattern. Thus `updateTemplate` and `updateListingTemplate` must read, change and save the template without a different write between these steps. For example, in SQL, read the row with `SELECT … FOR UPDATE` in a transaction. In `update`, turbo-crawl merges the patterns and keeps a maximum of 20 patterns. Your store does not have to merge or limit the patterns. When a pattern already matches the URL, `update` returns the same object that it got. Your store can then skip the write.

turbo-crawl examines each template from the store in the same way as a template file. When a template is not valid, turbo-crawl ignores it and adds a warning to the result, for example `The template row-3 from the store was ignored: …`.

When you give `store`, turbo-crawl does not read or write templates under `dataDir`. Page packets and agent transcripts are still files under `dataDir`, when `writeArtifacts` is `true`.

To move templates from files into your store, read each `<dataDir>/<domain>/templates/<id>.json` and `listings/<id>.json` file, and save it with `saveTemplate` or `saveListingTemplate`. To move them back, write each template to the same paths. The CLI can then use the folder with `--data-dir`.

### `extract(url, { fields?, require? })`

This call reads the page as a detail page. It gives `{ ok: true, data, missing, stale, canonicalUrl, fetchedAt, urlPattern, policy, templateFit, warnings, ... }`.

### `extractHtml({ url, html, fields?, require? })`

This call reads HTML that you rendered, for example with your own browser or render service. It reads the HTML as a detail page and gives the same result as `extract()`.

- `url` is the absolute `http` or `https` URL of the page. turbo-crawl uses `url` as the base for relative links in the HTML.
- `html` is the rendered HTML of the page. The maximum size is 10 MB.

turbo-crawl opens the HTML in its browser at `url`. It does not run the scripts of the page. It does not send requests. It stops all requests for images, styles, scripts and frames. It does not read robots.txt, because you got the page. You must obey the robots.txt of the site.

The result is different from `extract()` in these values:

| Value | `extract(url)` | `extractHtml({ url, html })` |
| --- | --- | --- |
| `finalUrl` | The URL after redirects | `url` |
| `policy.robots` | The result of the robots.txt check | `"unknown"` |
| `policy.httpStatus`, `policy.xRobotsTag` | From the response | `null` |
| `policy.metaRobots` | From the page | From the HTML |

The call uses one of the `maxConcurrentPages` pages. When more calls run, the other calls wait. The call rejects when `url` is not an absolute `http` or `https` URL, or when `html` is empty or larger than 10 MB.

Use HTML from a page that is fully rendered. turbo-crawl does not run scripts, so content that a script adds after the page loads is not in the HTML.

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

A call rejects only in these cases: an argument is not valid, Chromium cannot start, the agent fails when `authoring` is `"allowed"`, or the `store` breaks its contract or fails. For example, `listTemplates` does not give an array.

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
