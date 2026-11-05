import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDomainStore, saveTemplate } from "../src/core/domain-store.ts";
import { createFieldTemplate } from "../src/core/template-author/validateSelectors.ts";

const repoRoot = path.resolve(import.meta.dir, "..");
const body = "The new Daytona keeps the calibre 4131 and a ceramic bezel. ".repeat(6);

const pages: Record<string, string> = {
  "/robots.txt": "User-agent: *\nAllow: /\n",
  "/news/rolex-daytona": `<!doctype html><html><head><title>Rolex</title>
    <link rel="canonical" href="/news/rolex-daytona#top"></head>
    <body><article><h1 class="headline">Rolex Daytona</h1><div class="body"><p>${body}</p></div></article></body></html>`,
};

function run(command: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv }) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", chunk => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", chunk => (stderr += chunk));
    child.on("error", reject);
    child.on("close", code => resolve({ code, stdout, stderr }));
  });
}

describe("library on Node", () => {
  let server: ReturnType<typeof Bun.serve>;
  let workDir = "";
  let base = "";

  beforeAll(async () => {
    const build = Bun.spawnSync(["bun", "run", "build"], { cwd: repoRoot, stdout: "pipe", stderr: "pipe" });
    if (build.exitCode !== 0) throw new Error(`bun run build failed:\n${build.stderr.toString()}`);

    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        const html = pages[new URL(request.url).pathname];
        return html ? new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } }) : new Response("not found", { status: 404 });
      },
    });
    base = `http://127.0.0.1:${server.port}`;
    workDir = await mkdtemp(path.join(tmpdir(), "turbo-crawl-lib-e2e-"));

    const store = createDomainStore({ targetUrl: base, rootPath: path.join(workDir, "templates") });
    const css = (selector: string) => [{ kind: "css" as const, selector, attribute: "textContent" as const, score: 90, reusable: true }];
    await saveTemplate(store, {
      id: "template_0123456789abcdef",
      domain: store.domain,
      urlPatterns: ["/news/:slug"],
      schema: { headline: "string", body: "text" },
      createdFromUrl: `${base}/news/rolex-daytona`,
      createdAt: "2026-11-05T00:00:00.000Z",
      fields: {
        headline: createFieldTemplate({ fieldName: "headline", type: "string", selectors: css("h1.headline"), rawValue: null, normalizedValue: null }),
        body: createFieldTemplate({ fieldName: "body", type: "text", selectors: css("div.body"), rawValue: null, normalizedValue: null }),
      },
    });
    await writeFile(path.join(workDir, "package.json"), JSON.stringify({ type: "module" }), "utf8");
    await mkdir(path.join(workDir, "node_modules", "@fragmentoid"), { recursive: true });
    await symlink(repoRoot, path.join(workDir, "node_modules", "@fragmentoid", "turbo-crawl"));
  }, 120_000);

  afterAll(async () => {
    server?.stop(true);
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  it("extracts with a saved template and starts no agent", async () => {
    await writeFile(
      path.join(workDir, "ci.mjs"),
      `import { createCrawler } from "@fragmentoid/turbo-crawl";
const crawler = createCrawler({ dataDir: "templates", userAgent: "LibBot/1.0", authoring: "never" });
const [article, index] = await Promise.all([
  crawler.extract(${JSON.stringify(`${base}/news/rolex-daytona`)}),
  crawler.links(${JSON.stringify(`${base}/news/rolex-daytona`)}),
]);
await crawler.close();
console.log(JSON.stringify({ article, index }));
`,
      "utf8",
    );
    const node = Bun.spawnSync(["node", "-p", "process.execPath"]).stdout.toString().trim();
    const binDir = path.join(workDir, "bin");
    await mkdir(binDir, { recursive: true });
    await symlink(node, path.join(binDir, "node"));

    // Only node on PATH: a call that tried to start claude or codex would fail.
    const result = await run(node, ["ci.mjs"], { cwd: workDir, env: { PATH: binDir, HOME: process.env.HOME } });

    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    const { article, index } = JSON.parse(result.stdout);
    expect(article).toMatchObject({
      ok: true,
      schemaVersion: 1,
      canonicalUrl: `${base}/news/rolex-daytona`,
      urlPattern: "/news/:slug",
      data: { headline: "Rolex Daytona" },
      missing: [],
      stale: false,
      templateFit: { templateId: "template_0123456789abcdef", matchedPattern: true },
    });
    expect(index).toMatchObject({ ok: false, schemaVersion: 1, code: "TEMPLATE_MISSING" });
  }, 60_000);

  it("type-checks a consumer against dist/lib.d.ts", async () => {
    await writeFile(
      path.join(workDir, "consumer.ts"),
      `import { createCrawler, type ExtractResult } from "@fragmentoid/turbo-crawl";
const crawler = createCrawler({ dataDir: "t", userAgent: "X/1", authoring: "never", maxConcurrentPages: 2 });
const result: ExtractResult = await crawler.extract("https://a.com/x", { require: ["headline"] });
const canonical: string | null = result.ok ? result.canonicalUrl : result.policy?.httpStatus === 429 ? null : null;
console.log(canonical);
`,
      "utf8",
    );

    const tsc = await run(
      path.join(repoRoot, "node_modules", ".bin", "tsc"),
      ["--noEmit", "--strict", "--module", "nodenext", "--moduleResolution", "nodenext", "--target", "es2022", "consumer.ts"],
      { cwd: workDir },
    );

    expect(tsc.stdout + tsc.stderr).toBe("");
    expect(tsc.code).toBe(0);
  }, 60_000);
});
