import type { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, expect, it } from "bun:test";
import type { Browser } from "playwright";
import { installChromium, launchChromium } from "../src/core/browserInstall.ts";

const browser = {} as Browser;
const missing = new Error("browserType.launch: Executable doesn't exist at /tmp/ms-playwright/chromium-1200/chrome");

function fakes(launches: Array<Error | Browser>, install: () => Promise<void> = async () => {}) {
  const calls = { launch: 0, install: 0, log: [] as string[] };
  return {
    calls,
    deps: {
      async launch() {
        const next = launches[calls.launch++]!;
        if (next instanceof Error) throw next;
        return next;
      },
      async install() {
        calls.install += 1;
        await install();
      },
      log: (message: string) => calls.log.push(message),
    },
  };
}

describe("launchChromium", () => {
  it("downloads Chromium once when it is missing, says so, and launches again", async () => {
    const { calls, deps } = fakes([missing, browser]);

    expect(await launchChromium(deps)).toBe(browser);
    expect(calls).toEqual({ launch: 2, install: 1, log: ["Chromium for Playwright is not installed. Downloading it (one time)…"] });
  });

  it("does not download when the launch fails for another reason", async () => {
    const { calls, deps } = fakes([new Error("browserType.launch: Host system is missing dependencies to run browsers.")]);

    await expect(launchChromium(deps)).rejects.toThrow("missing dependencies");
    expect(calls.install).toBe(0);
  });

  it("stops with the download error and does not launch again", async () => {
    const { calls, deps } = fakes([missing, browser], async () => {
      throw new Error("The Chromium download failed (exit code 1).");
    });

    await expect(launchChromium(deps)).rejects.toThrow("The Chromium download failed");
    expect(calls.launch).toBe(1);
  });
});

describe("installChromium", () => {
  function fakeSpawn(exitCode: number) {
    const calls: Array<{ args: readonly string[]; stdio: unknown }> = [];
    const spawnProcess = ((_command: string, args: readonly string[], options: { stdio: unknown }) => {
      calls.push({ args, stdio: options.stdio });
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", exitCode));
      return child;
    }) as unknown as typeof spawn;
    return { calls, spawnProcess };
  }

  it("installs only the headless shell, with its output on stderr", async () => {
    const { calls, spawnProcess } = fakeSpawn(0);

    await installChromium(spawnProcess);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args.slice(1)).toEqual(["install", "--only-shell", "chromium"]);
    expect(calls[0]!.stdio).toEqual(["ignore", 2, 2]);
  });

  it("names the manual command when the installer fails", async () => {
    const { spawnProcess } = fakeSpawn(1);

    await expect(installChromium(spawnProcess)).rejects.toThrow("npx playwright install --with-deps --only-shell chromium");
  });
});
