# Contributing to turbo-crawl

- Toolchain: Bun for development (`bun install`, `bun run test`, `bun run build`). The published CLI runs on Node >= 20 and does not need Bun.
- Quality gates before every commit: `bun run typecheck && bun run test && bun run build`. Run tests through `bun run test`: it runs the plain tests in one Bun process, each `*.browser.test.ts` file in a process of its own, and the `*.e2e.test.ts` files in one more, because in-process Playwright hangs in a hook when it shares a Bun test process with the CLI subprocess or with other test files. A test that launches Chromium goes in a `*.browser.test.ts` file.
- TypeScript ESM with explicit types at module boundaries. Validate untrusted data (model output, files on disk) with Zod.
- Keep layers separate: `src/commands` (CLI) and `src/core` (crawl, templates, providers, storage). Core never imports the CLI.
- Every behaviour change ships with tests in `test/`; bug fixes get a regression test. Inject dependencies (spawn, browser, providers) instead of mocking modules.
- Errors must tell the user what to do next. Never log or store credentials.
