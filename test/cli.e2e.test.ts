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

const pages: Record<string, string> = {
  "/products/clock-1": productPage("Clock", "€49.00"),
  "/products/watch-2": productPage("Watch", "€120.50"),
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
  },
};

type RunResult = { code: number | null; stdout: string; stderr: string };

function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [cliPath, ...args], { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"] });
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
        const html = pages[new URL(request.url).pathname];
        return html
          ? new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } })
          : new Response("not found", { status: 404 });
      },
    });

    workDir = await mkdtemp(path.join(tmpdir(), "turbo-crawl-e2e-"));
    const binDir = path.join(workDir, "bin");
    counterFile = path.join(workDir, "claude-calls.txt");
    const envelopeFile = path.join(workDir, "envelope.json");
    await mkdir(binDir, { recursive: true });
    await writeFile(envelopeFile, JSON.stringify(claudeEnvelope), "utf8");
    await writeFile(
      path.join(binDir, "claude"),
      `#!/bin/sh\ncat > /dev/null\necho call >> "${counterFile}"\ncat "${envelopeFile}"\n`,
      "utf8",
    );
    await chmod(path.join(binDir, "claude"), 0o755);

    env = { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` };
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

      const second = await runCli(["crawl", `${base}/products/watch-2`, "--data-dir", dataDir, "--json"], env);
      expect(second.stderr).not.toContain("error:");
      expect(second.code).toBe(0);
      const reused = JSON.parse(second.stdout);
      expect(reused).toMatchObject({
        path: "template-reuse",
        llmUsed: false,
        provider: null,
        data: { title: "Watch", price: 120.5 },
      });

      const calls = (await readFile(counterFile, "utf8")).trim().split("\n");
      expect(calls).toHaveLength(1);
    },
    60_000,
  );
});
