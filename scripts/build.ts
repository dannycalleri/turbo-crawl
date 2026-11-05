import { chmod, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const outFile = resolve(process.cwd(), "dist/cli.js");
const pkg = (await Bun.file(resolve(process.cwd(), "package.json")).json()) as { version: string };

await rm(resolve(process.cwd(), "dist"), { recursive: true, force: true });
await mkdir(dirname(outFile), { recursive: true });

const result = await Bun.build({
  entrypoints: [resolve(process.cwd(), "src/index.ts")],
  outdir: dirname(outFile),
  naming: { entry: "cli.js", asset: "assets/[name]-[hash].[ext]" },
  target: "node",
  format: "esm",
  packages: "bundle",
  external: ["playwright"],
  banner: "#!/usr/bin/env node\n",
  define: { "process.env.TURBO_CRAWL_VERSION": JSON.stringify(pkg.version) },
  sourcemap: "external",
  throw: false,
});

if (!result.success) {
  for (const log of result.logs) {
    console.error(log);
  }

  process.exit(1);
}

await chmod(outFile, 0o755);
