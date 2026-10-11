import { describe, expect, it } from "bun:test";
import {
  DEFAULT_LMSTUDIO_MODEL,
  ProviderSelectionError,
  resolveProvider,
} from "../src/core/llm-extractor/providers/resolveProvider.ts";

function onPath(...commands: string[]) {
  return (command: string) => commands.includes(command);
}

function selectionError(run: () => unknown): ProviderSelectionError {
  try {
    run();
  } catch (error) {
    if (error instanceof ProviderSelectionError) return error;
    throw error;
  }
  throw new Error("expected a ProviderSelectionError");
}

describe("resolveProvider", () => {
  it("lets the --provider flag beat TURBO_CRAWL_PROVIDER", () => {
    const resolved = resolveProvider({
      provider: "codex",
      env: { TURBO_CRAWL_PROVIDER: "claude" },
      isOnPath: onPath("claude", "codex"),
    });

    expect(resolved.name).toBe("codex");
  });

  it("lets TURBO_CRAWL_PROVIDER beat auto-detection", () => {
    const resolved = resolveProvider({ env: { TURBO_CRAWL_PROVIDER: "codex" }, isOnPath: onPath("claude", "codex") });

    expect(resolved.name).toBe("codex");
  });

  it("auto-detects claude first, then codex", () => {
    expect(resolveProvider({ env: {}, isOnPath: onPath("claude", "codex") }).name).toBe("claude");
    expect(resolveProvider({ env: {}, isOnPath: onPath("codex") }).name).toBe("codex");
  });

  it("explains how to proceed when no agent is installed", () => {
    const error = selectionError(() => resolveProvider({ env: {}, isOnPath: onPath() }));

    expect(error.usageError).toBe(false);
    expect(error.message).toContain("--provider lmstudio");
  });

  it("treats an unknown provider as a usage error", () => {
    const error = selectionError(() => resolveProvider({ provider: "gemini", env: {}, isOnPath: onPath("claude") }));

    expect(error.usageError).toBe(true);
    expect(error.message).toContain('Unknown provider "gemini"');
  });

  it("gives lmstudio a default model and leaves coding agents on theirs", () => {
    expect(resolveProvider({ provider: "lmstudio", env: {}, isOnPath: onPath() }).model).toBe(DEFAULT_LMSTUDIO_MODEL);
    expect(resolveProvider({ provider: "claude", env: {}, isOnPath: onPath() }).model).toBeNull();
  });

  it("uses TURBO_CRAWL_MODEL unless --model is given", () => {
    const env = { TURBO_CRAWL_MODEL: "opus" };

    expect(resolveProvider({ provider: "claude", env, isOnPath: onPath() }).model).toBe("opus");
    expect(resolveProvider({ provider: "lmstudio", env, isOnPath: onPath() }).model).toBe("opus");
    expect(resolveProvider({ provider: "claude", model: "sonnet", env, isOnPath: onPath() }).model).toBe("sonnet");
  });
});
