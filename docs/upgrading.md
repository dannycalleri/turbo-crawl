# Upgrading

## From 0.3 to 0.4

Version 0.4 changes how URL patterns are made and used:

- **The agent writes URL patterns.** `urlPattern` in results can now hold placeholders inside a segment and query keys, such as `/:brand/:slug--id:id.htm` or `/search/index.htm?query=:q`. `templateFit.matchedPattern` is `true` when one of the template's patterns matches the URL.
- **`stale: true` on more sites.** Sites whose URLs differ for every page, such as marketplaces, now get stale results when their layout changes, instead of a new template.
- **One more agent call when a detail page is authored.** The CLI now always asks the agent whether a new page is a listing before it authors a template. `crawler.extract()`, the items of a followed listing, and a URL that matches a saved listing's item pattern do not make this call.
- **A template needs a CSS selector to fit.** A template whose fields read only JSON-LD or meta tags no longer fits a page: at least one required field needs a CSS selector that reads a value. New templates get one from the agent. Author an old JSON-LD-only template again if it stops fitting.
- **Old template files load with merged patterns.** A template whose `urlPatterns` grew by one entry per page loads as a short list, and is saved that way on its next update. Listing templates store `itemUrlPatterns` and still write `itemUrlPattern`, so 0.3 can read them.
- **Duplicate templates.** If a page now fails with `AMBIGUOUS_TEMPLATE` because an old and a new template both fit, delete the older file in `data/<domain>/templates/`.

## From 0.1 to 0.2

Version 0.2 changes some defaults and outputs:

- **The TUI is gone.** `turbo-crawl crawl` always runs headless, and `--tui` is now an unknown option (exit 2).
- **Honest user agent.** Requests send `turbo-crawl/<version> (+https://github.com/dannycalleri/turbo-crawl)` instead of a Chrome user agent. Set your own with `--user-agent`, `turbo-crawl.json` or `~/.config/turbo-crawl/config.json`.
- **robots.txt is respected.** A disallowed URL is not fetched and the CLI exits 4. `--ignore-robots` turns the check off.
- **Templates are chosen by page content, not by URL pattern.** Template files are now `templates/<id>.json` with a list of `urlPatterns`. Files from 0.1.0 (one `urlPattern`) are still read. A `text` field must now have at least 200 characters for a template to fit: use `string` for short values.
- **New exit codes and JSON errors.** Errors print `{ "ok": false, "code", "message" }` on stdout (an unknown option or a missing URL still prints plain text on stderr, exit 2). Exit 3 is `TEMPLATE_MISSING`, exit 4 is `ROBOTS_DISALLOWED`. HTTP 401, 403 and 429 give `BLOCKED`; other 4xx and 5xx give `HTTP_ERROR`.
- **Dates in prose are not parsed.** A `date` field keeps only machine-readable dates (ISO 8601, RFC 2822, Unix time); `4 novembre 2026` becomes `null`.
- **`playwright` is a peer dependency** (`>=1.50 <2`). npm 7 and later install it for you.
