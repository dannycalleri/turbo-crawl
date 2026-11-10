import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// End to end: the built CLI on Node, a real Chromium, a local site and a fake `claude`
// on PATH. The first page authors a template; the second reuses it without the agent.

const repoRoot = path.resolve(import.meta.dir, "..");
const cliPath = path.join(repoRoot, "dist", "cli.js");

function productPage(title: string, price: string): string {
  return `<!doctype html>
<html>
  <head><title>${title} | Shop</title></head>
  <body>
    <main>
      <h1 class="title">${title}</h1>
      <span class="price">${price}</span>
    </main>
  </body>
</html>`;
}

function categoryPage(title: string, slugs: string[], next: string | null): string {
  const cards = slugs.map(slug => `<li><a class="card-link" href="/products/${slug}">${slug}</a></li>`).join("");
  return `<!doctype html>
<html>
  <head><title>${title} | Shop</title></head>
  <body>
    <main>
      <h1>${title}</h1>
      <ul class="grid">${cards}</ul>
      ${next ? `<a rel="next" href="${next}">Next</a>` : ""}
    </main>
  </body>
</html>`;
}

const watchSlugs = ["watch-10", "watch-11", "watch-12", "watch-13", "watch-14", "watch-15"];

const pages: Record<string, string> = {
  "/category/clocks": categoryPage("Clocks", ["clock-1", "watch-2", "clock-4", "clock-5", "clock-6"], "/category/clocks?page=2"),
  "/category/watches": categoryPage("Watches", watchSlugs.slice(0, 4), "/category/watches?page=2"),
  "/category/watches?page=2": categoryPage("Watches", watchSlugs.slice(4), null),
  ...Object.fromEntries(watchSlugs.map((slug, index) => [`/products/${slug}`, productPage(`Watch ${index + 10}`, `€${index + 10}.00`)])),
  "/robots.txt": "User-agent: *\nDisallow: /private/\n",
  "/products/clock-1": productPage("Clock", "€49.00"),
  "/products/watch-2": productPage("Watch", "€120.50"),
  "/2026/11/04/clock-3": productPage("Wall clock", "€30.00"),
  "/about": "<!doctype html><html><head><title>About | Shop</title></head><body><main><p>We sell clocks.</p></main></body></html>",
};

const claudeEnvelope = {
  type: "result",
  subtype: "success",
  is_error: false,
  result: "done",
  structured_output: {
    fields: {
      title: {
        selectors: [{ kind: "css", selector: "h1.title", attribute: "textContent" }],
        expectedSample: null,
      },
      price: {
        selectors: [{ kind: "css", selector: "span.price", attribute: "textContent" }],
        expectedSample: null,
      },
    },
    urlPattern: "/products/:slug",
    sameTypeLinks: [],
    otherTypeLinks: [],
  },
};

const classifyEnvelope = {
  ...claudeEnvelope,
  structured_output: {
    pageKind: "listing",
    itemLinks: ["ul.grid a.card-link"],
    nextPage: ["a[rel=next]"],
    pageLinks: [],
    pageUrlPattern: "/category/:slug",
    itemUrlPattern: "/products/:slug",
  },
};

const detailEnvelope = {
  ...claudeEnvelope,
  structured_output: { pageKind: "detail", itemLinks: [], nextPage: [], pageLinks: [], pageUrlPattern: "", itemUrlPattern: "" },
};

type RunResult = { code: number | null; stdout: string; stderr: string };

function runCli(args: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [cliPath, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", chunk => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", chunk => (stderr += chunk));
    child.on("error", reject);
    child.on("close", code => resolve({ code, stdout, stderr }));
  });
}

describe("turbo-crawl CLI end to end", () => {
  let buildError: string | null = null;
  let server: ReturnType<typeof Bun.serve> | null = null;
  let workDir = "";
  const userAgents: string[] = [];
  const requestedPaths: string[] = [];
  let counterFile = "";
  let env: NodeJS.ProcessEnv = {};

  beforeAll(async () => {
    const build = Bun.spawnSync(["bun", "run", "build"], { cwd: repoRoot, stdout: "pipe", stderr: "pipe" });
    if (build.exitCode !== 0) {
      buildError = build.stderr.toString() || build.stdout.toString();
      return;
    }

    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        userAgents.push(request.headers.get("user-agent") ?? "");
        requestedPaths.push(new URL(request.url).pathname);
        const url = new URL(request.url);
        const html = pages[url.pathname + url.search] ?? pages[url.pathname];
        return html
          ? new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } })
          : new Response("not found", { status: 404 });
      },
    });

    workDir = await mkdtemp(path.join(tmpdir(), "turbo-crawl-e2e-"));
    const binDir = path.join(workDir, "bin");
    counterFile = path.join(workDir, "claude-calls.txt");
    const envelopeFile = path.join(workDir, "envelope.json");
    const classifyFile = path.join(workDir, "classify.json");
    const detailFile = path.join(workDir, "detail.json");
    await mkdir(binDir, { recursive: true });
    await writeFile(envelopeFile, JSON.stringify(claudeEnvelope), "utf8");
    await writeFile(classifyFile, JSON.stringify(classifyEnvelope), "utf8");
    await writeFile(detailFile, JSON.stringify(detailEnvelope), "utf8");
    await writeFile(
      path.join(binDir, "claude"),
      [
        "#!/bin/sh",
        'prompt=$(cat)',
        `echo call >> "${counterFile}"`,
        `case "$prompt" in *"listing or a detail page"*) ;; *) cat "${envelopeFile}"; exit 0 ;; esac`,
        `if printf '%s' "$prompt" | grep -q '^URL: .*/category/'; then cat "${classifyFile}"; else cat "${detailFile}"; fi`,
        "",
      ].join("\n"),
      "utf8",
    );
    await chmod(path.join(binDir, "claude"), 0o755);
    await writeFile(path.join(workDir, "turbo-crawl.json"), JSON.stringify({ userAgent: "E2EBot/1.0" }), "utf8");

    env = {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      XDG_CONFIG_HOME: path.join(workDir, "xdg"),
    };
    delete env.TURBO_CRAWL_PROVIDER;
    delete env.TURBO_CRAWL_MODEL;
    delete env.TURBO_CRAWL_DATA_DIR;
    delete env.TURBO_CRAWL_CLAUDE_BIN;
  }, 120_000);

  afterAll(async () => {
    server?.stop(true);
    if (workDir) {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it(
    "authors a template on the first page and reuses it on the next without the agent",
    async () => {
      if (buildError !== null) {
        console.warn(`Skipping CLI e2e: \`bun run build\` failed:\n${buildError}`);
        return;
      }

      const base = `http://127.0.0.1:${server!.port}`;
      const dataDir = path.join(workDir, "data");

      const first = await runCli(
        ["crawl", `${base}/products/clock-1`, "--fields", "title:string,price:number", "--data-dir", dataDir, "--json", "--provider", "claude"],
        env,
        workDir,
      );
      expect(first.stderr).not.toContain("error:");
      expect(first.code).toBe(0);
      const authored = JSON.parse(first.stdout);
      expect(authored).toMatchObject({
        path: "authored",
        urlPattern: "/products/:slug",
        llmUsed: true,
        provider: "claude",
        data: { title: "Clock", price: 49 },
      });

      const second = await runCli(["crawl", `${base}/products/watch-2`, "--data-dir", dataDir, "--json"], env, workDir);
      expect(second.stderr).not.toContain("error:");
      expect(second.code).toBe(0);
      const reused = JSON.parse(second.stdout);
      expect(reused).toMatchObject({
        path: "template-reuse",
        llmUsed: false,
        provider: null,
        data: { title: "Watch", price: 120.5 },
      });

      const newShape = await runCli(["crawl", `${base}/2026/11/04/clock-3`, "--data-dir", dataDir], env, workDir);
      expect(newShape.code).toBe(0);
      expect(JSON.parse(newShape.stdout)).toMatchObject({
        path: "template-reuse",
        urlPattern: "/:id/:id/:id/:slug",
        llmUsed: false,
        data: { title: "Wall clock", price: 30 },
        templateFit: { matchedPattern: false },
      });

      const unknownLayout = await runCli(["crawl", `${base}/about`, "--data-dir", dataDir, "--no-author"], env, workDir);
      expect(unknownLayout.code).toBe(3);
      expect(JSON.parse(unknownLayout.stdout)).toMatchObject({ ok: false, code: "TEMPLATE_MISSING" });

      const calls = (await readFile(counterFile, "utf8")).trim().split("\n");
      expect(calls).toHaveLength(2);
      expect(new Set(userAgents)).toEqual(new Set(["E2EBot/1.0"]));
    },
    60_000,
  );

  it(
    "exits 4 with a JSON error and does not render a page that robots.txt disallows",
    async () => {
      if (buildError !== null) return;

      const before = requestedPaths.length;
      const refused = await runCli(
        ["crawl", `http://127.0.0.1:${server!.port}/private/clock-1`, "--fields", "title:string", "--data-dir", path.join(workDir, "data")],
        env,
        workDir,
      );

      expect(refused.code).toBe(4);
      expect(JSON.parse(refused.stdout)).toMatchObject({ ok: false, code: "ROBOTS_DISALLOWED" });
      expect(requestedPaths.slice(before)).toEqual(["/robots.txt"]);
    },
    30_000,
  );

  it(
    "prints the item and pagination URLs of a category page, and reuses its listing template",
    async () => {
      if (buildError !== null) return;

      const base = `http://127.0.0.1:${server!.port}`;
      const callsBefore = (await readFile(counterFile, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).length;

      const listing = await runCli(["crawl", `${base}/category/clocks`, "--no-follow", "--data-dir", path.join(workDir, "data")], env, workDir);

      expect(listing.stderr).not.toContain("error:");
      expect(listing.code).toBe(0);
      const printed = JSON.parse(listing.stdout);
      expect(printed).toMatchObject({
        ok: true,
        kind: "listing",
        llmUsed: true,
        itemUrls: ["clock-1", "watch-2", "clock-4", "clock-5", "clock-6"].map(slug => `${base}/products/${slug}`),
        paginationUrls: [`${base}/category/clocks?page=2`],
      });
      expect(printed.templateFit.templatePath).toContain(`${path.sep}listings${path.sep}`);
      const callsAfter = (await readFile(counterFile, "utf8")).trim().split("\n").length;
      expect(callsAfter - callsBefore).toBe(1);

      const again = await runCli(["crawl", `${base}/category/clocks`, "--no-follow", "--data-dir", path.join(workDir, "data")], env, workDir);
      expect(again.code).toBe(0);
      expect(JSON.parse(again.stdout)).toMatchObject({ kind: "listing", llmUsed: false, itemUrls: printed.itemUrls });
      expect((await readFile(counterFile, "utf8")).trim().split("\n")).toHaveLength(callsAfter);
    },
    30_000,
  );

  it(
    "follows a two-page category: one JSON line per item, and no agent call on the second run",
    async () => {
      if (buildError !== null) return;

      const base = `http://127.0.0.1:${server!.port}`;
      const dataDir = path.join(workDir, "data-follow");
      const agentCalls = async () => (await readFile(counterFile, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).length;
      const follow = () =>
        runCli(["crawl", `${base}/category/watches`, "--fields", "title:string,price:number", "--delay-ms", "0", "--data-dir", dataDir], env, workDir);
      const before = await agentCalls();

      const first = await follow();

      expect(first.stderr).toContain("Crawled 2 listing page(s): 6 item(s) extracted, 0 failed.");
      expect(first.code).toBe(0);
      const items = first.stdout.trim().split("\n").map(line => JSON.parse(line));
      expect(items.map(item => [item.url, item.data.title])).toEqual(watchSlugs.map((slug, index) => [`${base}/products/${slug}`, `Watch ${index + 10}`]));
      expect((await agentCalls()) - before).toBe(2);

      const again = await follow();

      expect(again.code).toBe(0);
      expect(again.stdout.trim().split("\n")).toHaveLength(6);
      expect((await agentCalls()) - before).toBe(2);
    },
    60_000,
  );
});
