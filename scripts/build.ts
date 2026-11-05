import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const outFile = resolve(process.cwd(), "dist/cli.js");
const pkg = (await Bun.file(resolve(process.cwd(), "package.json")).json()) as { version: string };

await rm(resolve(process.cwd(), "dist"), { recursive: true, force: true });
await mkdir(dirname(outFile), { recursive: true });

const common: Omit<Bun.BuildConfig, "entrypoints"> = {
  outdir: dirname(outFile),
  target: "node",
  format: "esm",
  packages: "bundle",
  external: ["playwright"],
  define: { "process.env.TURBO_CRAWL_VERSION": JSON.stringify(pkg.version) },
  sourcemap: "external",
  throw: false,
};

const [result, library] = await Promise.all([
  Bun.build({
    ...common,
    entrypoints: [resolve(process.cwd(), "src/index.ts")],
    naming: { entry: "cli.js", asset: "assets/[name]-[hash].[ext]" },
    banner: "#!/usr/bin/env node\n",
  }),
  Bun.build({ ...common, entrypoints: [resolve(process.cwd(), "src/lib.ts")], naming: { entry: "lib.js" } }),
]);

for (const build of [result, library]) {
  if (!build.success) {
    for (const log of build.logs) {
      console.error(log);
    }

    process.exit(1);
  }
}

await chmod(outFile, 0o755);

const publicTypes = await readFile(resolve(process.cwd(), "src/lib-types.ts"), "utf8");
await writeFile(
  resolve(dirname(outFile), "lib.d.ts"),
  `${publicTypes}\nexport declare function createCrawler(options: CrawlerOptions): Crawler;\n`,
);
