# Contributing to turbo-crawl

- Toolchain: Bun (`bun install`, `bun test`, `bun run build`). The published CLI runs on Node >= 20; the TUI needs Bun.
- Quality gates before every commit: `bun run typecheck && bun test && bun run build`.
- TypeScript ESM with explicit types at module boundaries. Validate untrusted data (model output, files on disk) with Zod.
- Keep layers separate: `src/commands` (CLI), `src/core` (crawl, templates, providers, storage), `src/core/session-state.ts` (pure TUI state), `src/ui` (OpenTUI). Core never imports UI.
- Every behaviour change ships with tests in `test/`; bug fixes get a regression test. Inject dependencies (spawn, browser, providers) instead of mocking modules.
- Errors must tell the user what to do next. Never log or store credentials.
