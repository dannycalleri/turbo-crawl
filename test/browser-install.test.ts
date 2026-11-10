import { describe, expect, it } from "bun:test";
import type { Browser } from "playwright";
import { launchChromium } from "../src/core/browserInstall.ts";

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
