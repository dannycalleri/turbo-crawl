<h1 align="center">turbo-crawl</h1>

<p align="center"><strong>Turn any web page into structured JSON, without writing selectors.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@fragmentoid/turbo-crawl"><img alt="npm" src="https://img.shields.io/npm/v/@fragmentoid/turbo-crawl?label=npm&color=CB3837"></a>
  <a href="https://github.com/dannycalleri/turbo-crawl/actions/workflows/release.yml"><img alt="Build" src="https://img.shields.io/github/actions/workflow/status/dannycalleri/turbo-crawl/release.yml?branch=main&label=build"></a>
  <a href="https://www.npmjs.com/package/@fragmentoid/turbo-crawl"><img alt="npm provenance" src="https://img.shields.io/badge/provenance-signed-2EA44F?logo=npm"></a>
  <img alt="Node 20" src="https://img.shields.io/badge/node-%E2%89%A520-339933?logo=nodedotjs&logoColor=white">
  <img alt="Works with Claude Code and Codex" src="https://img.shields.io/badge/agents-Claude%20Code%20%C2%B7%20Codex-D97757">
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/github/license/dannycalleri/turbo-crawl?color=blue"></a>
</p>

<p align="center">
  <a href="#get-started">Get started</a> ·
  <a href="#examples">Examples</a> ·
  <a href="docs/reference.md">Reference</a> ·
  <a href="docs/upgrading.md">Upgrading</a> ·
  <a href="CHANGELOG.md">Changelog</a>
</p>

The first time turbo-crawl sees a page layout, it asks a coding agent you already use (**Claude Code** or **Codex**) to write an extraction template: CSS, JSON-LD, meta or table selectors for each field. Every selector is checked on the live page, and the ones that fail go back to the agent to fix. After that, every page with the same layout is read with the saved template, with **no model call**.

## Get started

You need Node.js 20 or later, and one template author, installed and logged in: [Claude Code](https://docs.claude.com/en/docs/claude-code) (`claude`, the default) or the [Codex CLI](https://github.com/openai/codex) (`codex`). A local [LM Studio](https://lmstudio.ai) server works too, with `--provider lmstudio`. The agent is needed only where a template is written.

```sh
npm install -g @fragmentoid/turbo-crawl
npx playwright install chromium
```

Crawl a product page and name the fields you want:

```console
$ turbo-crawl crawl https://bookshop.example/catalogue/a-light-in-the-attic_1000/index.html \
    --fields title:string,price:number,availability:string,upc:string
Rendering https://bookshop.example/catalogue/a-light-in-the-attic_1000/index.html…
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
```

Crawl another page with the same layout. The saved template reads it, and no model is called:

```console
$ turbo-crawl crawl https://bookshop.example/catalogue/sapiens-a-brief-history-of-humankind_996/index.html
Extracted with the saved template data/bookshop.example/templates/dc69babc39c9291d.json.
{
  "ok": true,
  "kind": "item",
  "path": "template-reuse",
  "llmUsed": false,
  "data": { "title": "Sapiens: A Brief History of Humankind", "price": 54.23, ... }
}
```

You can also run it without installing: `npx @fragmentoid/turbo-crawl crawl <url> ...`.

## Why turbo-crawl

| You get | In practice |
|---|---|
| **One model call per layout** | The agent writes a template once. Every later page with that layout is read with no model call. |
| **No selectors to write** | Name the fields, or let the agent suggest them. turbo-crawl tests each selector on the live page. |
| **New URLs are no problem** | A template is matched by what the page contains, not by its URL. |
| **You know when a site changes** | When a known page stops fitting its template, the result is marked `stale`. |
| **Whole listings** | Give it a category or search page. It extracts every item and follows the next pages. |
| **The agent you already use** | Claude Code or Codex, with your own login. No API keys, and the agent never sees your files. |
| **Your user agent, your rules** | Set your own with `--user-agent`, a [config file](docs/reference.md#user-agent) or the library option. robots.txt is respected by default. |
| **No model in production** | Templates are plain JSON. Commit them and extract in CI with no agent. |

## Examples

**Let the agent choose the fields.** Leave out `--fields`, and the agent suggests the fields for the page:

```sh
turbo-crawl crawl https://news.example/2026/11/04/clock-3
```

**Crawl a listing.** Every item of a category page, following its next pages, as NDJSON:

```console
$ turbo-crawl crawl https://bookshop.example/catalogue/category/books/mystery_3/index.html \
    --fields title:string,price:number --max-items 25 > books.ndjson
Crawled 2 listing page(s): 25 item(s) extracted, 0 failed.

$ head -1 books.ndjson
{"ok":true,"kind":"item","url":"https://bookshop.example/catalogue/sharp-objects_997/index.html","data":{"title":"Sharp Objects","price":47.82},...}
```

**Never call a model.** With `--no-author`, only saved templates are used. When none fits, the CLI exits 3:

```sh
turbo-crawl crawl https://bookshop.example/catalogue/sharp-objects_997/index.html --no-author --data-dir templates
```

**Use it from Node.** Author templates on your machine, commit them, and extract in CI with `authoring: "never"`:

```ts
import { createCrawler } from "@fragmentoid/turbo-crawl";

const crawler = createCrawler({
  dataDir: "templates",                                  // templates you authored and committed
  userAgent: "MyBot/1.0 (+https://example.com/bot)",     // required, no default
  authoring: "never",                                    // never start an agent
});

const index = await crawler.links("https://news.example/archive");
if (index.ok) {
  for (const item of index.itemUrls) {
    const article = await crawler.extract(item.url, { require: ["headline", "body"] });
    if (article.ok) console.log(article.canonicalUrl, article.data);
    else console.error(article.code, article.message);
  }
}

await crawler.close();
```

Install it in a project with `npm install @fragmentoid/turbo-crawl playwright`.

## How it works

```mermaid
flowchart LR
    render["Render the page<br/>in Chromium"] --> match{"Does a saved<br/>template fit?"}
    match -- yes --> extract["Extract<br/>no model call"]
    match -- no --> author["Agent writes<br/>the selectors"]
    author --> validate["Run each selector<br/>on the live page"]
    validate -- failures --> author
    validate --> save["Save the template"] --> extract
```

The [reference](docs/reference.md#how-it-works) has the details of each step.

## Documentation

- [Reference](docs/reference.md): every CLI option, exit codes, listing pages, how turbo-crawl selects a template, URL patterns, user agent, robots.txt, environment variables, the library API and the data layout.
- [Upgrading](docs/upgrading.md): what changed in 0.2 and 0.4.
- [Changelog](CHANGELOG.md).

## Contributing

```sh
bun install
bun run dev crawl <url>   # run from source
bun run typecheck
bun run test              # plain, browser and e2e tests
bun run build             # dist/cli.js and dist/lib.js, run on Node
```

See [AGENTS.md](AGENTS.md) for conventions. Commits follow Conventional Commits. Every merge to `main` updates a release pull request built by [release-please](https://github.com/googleapis/release-please); merging it publishes the package to npm with provenance.

## License

[MIT](LICENSE)
