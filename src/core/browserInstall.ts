import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { chromium, type Browser } from "playwright";

export type LaunchChromiumDependencies = {
  launch(): Promise<Browser>;
  install(): Promise<void>;
  log(message: string): void;
};

const defaultDependencies: LaunchChromiumDependencies = {
  launch: () => chromium.launch({ headless: true }),
  install: installChromium,
  log: message => process.stderr.write(`${message}\n`),
};

export async function launchChromium(deps: LaunchChromiumDependencies = defaultDependencies): Promise<Browser> {
  try {
    return await deps.launch();
  } catch (error) {
    if (!isMissingExecutableError(error)) throw error;
  }
  deps.log("Chromium for Playwright is not installed. Downloading it (one time)…");
  await deps.install();
  return deps.launch();
}

export function isMissingExecutableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Executable doesn't exist/i.test(message);
}

// Runs the CLI of the installed playwright package, so the browser matches the version that launches it.
// Its output goes to stderr: stdout carries the crawl's JSON. Playwright draws a progress bar on a terminal.
async function installChromium(): Promise<void> {
  const require = createRequire(import.meta.url);
  const packagePath = require.resolve("playwright/package.json");
  const { bin } = require(packagePath) as { bin: { playwright: string } };
  const cli = path.join(path.dirname(packagePath), bin.playwright);

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "install", "chromium"], { stdio: ["ignore", 2, 2] });
    child.once("error", reject);
    child.once("exit", resolve);
  });
  if (exitCode !== 0) {
    throw new Error(`The Chromium download failed (exit code ${exitCode}). Run \`npx playwright install --with-deps chromium\` and try again.`);
  }
}
