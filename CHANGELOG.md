# Changelog

## 0.2.0

### Breaking changes

- **The TUI is gone.** `turbo-crawl crawl` always runs headless, and `--tui` is now an unknown option (exit 2).
- **Honest user agent.** Requests send `turbo-crawl/<version> (+https://github.com/dannycalleri/turbo-crawl)` instead of a Chrome user agent. Set your own with `--user-agent`, `turbo-crawl.json` or `~/.config/turbo-crawl/config.json`.
- **robots.txt is respected.** A disallowed URL is not fetched and the CLI exits 4. `--ignore-robots` turns the check off.
- **Templates are chosen by page content, not by URL pattern.** Template files are now `templates/<id>.json` with a list of `urlPatterns`. Files from 0.1.0 (one `urlPattern`) are still read. A `text` field must now have at least 200 characters for a template to fit: use `string` for short values.
- **New exit codes and JSON errors.** Errors print `{ "ok": false, "code", "message" }` on stdout (an unknown option or a missing URL still prints plain text on stderr, exit 2). Exit 3 is `TEMPLATE_MISSING`, exit 4 is `ROBOTS_DISALLOWED`. HTTP 401, 403 and 429 give `BLOCKED`; other 4xx and 5xx give `HTTP_ERROR`.
- **Dates in prose are not parsed.** A `date` field keeps only machine-readable dates (ISO 8601, RFC 2822, Unix time); `4 novembre 2026` becomes `null`.
- **`playwright` is a peer dependency** (`>=1.50 <2`). npm 7 and later install it for you.

### New

- **Library API.** `import { createCrawler } from "@fragmentoid/turbo-crawl"` with `extract()`, `links()` and `close()`, typed results, errors that resolve, `authoring: "never"` for CI, and concurrent calls capped by `maxConcurrentPages`.
- **Listing pages.** A category, archive or search page is recognized, and its item and pagination URLs are printed. Its listing template is reused with no agent call.
- **Policy signals** on every result: robots.txt verdict, HTTP status, `X-Robots-Tag`, robots meta tag and TDM reservation.
- **Stale templates.** When a template stops fitting the URL pattern it was made for, the result says `"stale": true` and why.
- New flags: `--user-agent`, `--ignore-robots`, `--no-author`, `--require`, `--no-artifacts`.
- `attr:<name>` selectors read any attribute, such as `time[datetime]`.
- `text` fields keep paragraph breaks and drop scripts and styles.
- One browser serves many pages; the full-page screenshot is no longer taken.

## 0.1.0

Initial public release.
