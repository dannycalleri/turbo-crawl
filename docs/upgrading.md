# Upgrading

## From 0.3 to 0.4

Version 0.4 changes how turbo-crawl makes and uses URL patterns.

- **The agent writes the URL patterns.** A `urlPattern` in a result can now have placeholders in a segment, and query keys. Examples: `/:brand/:slug--id:id.htm` and `/search/index.htm?query=:q`. `templateFit.matchedPattern` is `true` when one of the patterns of the template matches the URL.
- **More sites get `stale: true`.** On some sites, each page has a different URL, for example on marketplaces. When the layout of these sites changes, turbo-crawl now gives a stale result. Before, it authored a new template.
- **One more agent call before a detail page gets a template.** The CLI now asks the agent if a new page is a listing. Then it authors the template. These pages do not get this call:
  - pages from `crawler.extract()`;
  - the items of a listing that turbo-crawl follows;
  - a URL that matches the item pattern of a saved listing.
- **A template must have a CSS selector to fit.** When the fields of a template read only JSON-LD or meta tags, the template does not fit. One or more required fields must have a CSS selector that reads a value. The agent gives a CSS selector for each new template. When an old template stops fitting for this reason, author it again.
- **Old template files load with merged patterns.** In some old templates, `urlPatterns` has one entry for each page. turbo-crawl now loads this list as a short list. It saves the short list when it next updates the file. Listing templates keep `itemUrlPatterns`, and they also keep `itemUrlPattern`. Thus version 0.3 can read them.
- **turbo-crawl downloads Chromium.** When Chromium for Playwright is missing, turbo-crawl downloads it on the first run and shows the progress. You do not need to run `npx playwright install chromium` first.
- **Duplicate templates.** An old template and a new template can both fit a page. The page then fails with `AMBIGUOUS_TEMPLATE`. To correct this, delete the older file in `data/<domain>/templates/`.

## From 0.1 to 0.2

Version 0.2 changes some defaults and outputs.

- **There is no TUI.** `turbo-crawl crawl` always runs in headless mode. `--tui` is now an unknown option, and the CLI exits with code 2.
- **An honest user agent.** turbo-crawl sends `turbo-crawl/<version> (+https://github.com/dannycalleri/turbo-crawl)`. Before, it sent a Chrome user agent. To set a different user agent, use `--user-agent`, `turbo-crawl.json` or `~/.config/turbo-crawl/config.json`.
- **turbo-crawl obeys robots.txt.** It does not get a URL that robots.txt does not allow, and the CLI exits with code 4. To stop the check, use `--ignore-robots`.
- **turbo-crawl selects templates by page content, not by URL pattern.** The template files are now `templates/<id>.json`, with a list of `urlPatterns`. turbo-crawl can still read the files from 0.1.0, which have one `urlPattern`. A `text` field must now have 200 characters or more for a template to fit. For short values, use `string`.
- **New exit codes and JSON errors.** The CLI writes errors to stdout as `{ "ok": false, "code", "message" }`. For an unknown option or a missing URL, it still writes plain text to stderr and exits with code 2. Exit code 3 is `TEMPLATE_MISSING`. Exit code 4 is `ROBOTS_DISALLOWED`. HTTP 401, 403 and 429 give `BLOCKED`. All other 4xx and 5xx statuses give `HTTP_ERROR`.
- **turbo-crawl does not read dates in text.** A `date` field keeps only dates in a machine format: ISO 8601, RFC 2822 or Unix time. For example, `4 novembre 2026` becomes `null`.
- **`playwright` is a peer dependency** (`>=1.50 <2`). npm 7 and later install it for you.
