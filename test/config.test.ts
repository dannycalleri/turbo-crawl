import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ConfigError, DEFAULT_USER_AGENT, resolveUserAgent, type ConfigLocations } from "../src/core/config.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function layout(): Promise<{ root: string; home: string; above: string; repo: string; cwd: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "turbo-crawl-config-"));
  tempDirs.push(root);
  const home = path.join(root, "home");
  const above = path.join(root, "above");
  const repo = path.join(above, "repo");
  const cwd = path.join(repo, "pkg", "app");
  await mkdir(path.join(repo, ".git"), { recursive: true });
  await mkdir(cwd, { recursive: true });
  await mkdir(home, { recursive: true });
  return { root, home, above, repo, cwd };
}

async function writeConfig(dir: string, value: unknown): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "turbo-crawl.json"), JSON.stringify(value));
}

async function writeUserConfig(configHome: string, value: unknown): Promise<void> {
  const dir = path.join(configHome, "turbo-crawl");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "config.json"), typeof value === "string" ? value : JSON.stringify(value));
}

function locations(cwd: string, home: string, env: NodeJS.ProcessEnv = {}): ConfigLocations {
  return { cwd, home, env };
}

describe("resolveUserAgent", () => {
  it("uses the option before any config file", async () => {
    const { home, repo, cwd } = await layout();
    await writeConfig(repo, { userAgent: "RepoBot/1.0" });

    expect(await resolveUserAgent("CliBot/1.0", locations(cwd, home))).toBe("CliBot/1.0");
  });

  it("uses the nearest repo config before the user config", async () => {
    const { home, repo, cwd } = await layout();
    await writeConfig(repo, { userAgent: "RepoBot/1.0" });
    await writeConfig(path.join(repo, "pkg"), { userAgent: "PkgBot/1.0" });
    await writeUserConfig(path.join(home, ".config"), { userAgent: "HomeBot/1.0" });

    expect(await resolveUserAgent(undefined, locations(cwd, home))).toBe("PkgBot/1.0");
  });

  it("falls back to the user config under XDG_CONFIG_HOME, then ~/.config", async () => {
    const { root, home, cwd } = await layout();
    await writeUserConfig(path.join(home, ".config"), { userAgent: "HomeBot/1.0" });
    await writeUserConfig(path.join(root, "xdg"), { userAgent: "XdgBot/1.0" });

    expect(await resolveUserAgent(undefined, locations(cwd, home))).toBe("HomeBot/1.0");
    expect(await resolveUserAgent(undefined, locations(cwd, home, { XDG_CONFIG_HOME: path.join(root, "xdg") }))).toBe("XdgBot/1.0");
  });

  it("uses the turbo-crawl default when no config sets a user agent", async () => {
    const { home, repo, cwd } = await layout();
    await writeConfig(repo, {});

    expect(await resolveUserAgent(undefined, locations(cwd, home))).toBe(DEFAULT_USER_AGENT);
    expect(DEFAULT_USER_AGENT).toMatch(/^turbo-crawl\/\S+ \(\+https:\/\/github\.com\/dannycalleri\/turbo-crawl\)$/);
  });

  it("does not read a repo config above the git root", async () => {
    const { home, above, cwd } = await layout();
    await writeConfig(above, { userAgent: "AboveBot/1.0" });

    expect(await resolveUserAgent(undefined, locations(cwd, home))).toBe(DEFAULT_USER_AGENT);
  });

  it("reads only the current folder outside a git repository", async () => {
    const { root, home } = await layout();
    const outside = path.join(root, "outside", "child");
    await writeConfig(path.join(root, "outside"), { userAgent: "ParentBot/1.0" });
    await mkdir(outside, { recursive: true });

    expect(await resolveUserAgent(undefined, locations(outside, home))).toBe(DEFAULT_USER_AGENT);
    await writeConfig(outside, { userAgent: "HereBot/1.0" });
    expect(await resolveUserAgent(undefined, locations(outside, home))).toBe("HereBot/1.0");
  });

  it("fails on an invalid file even when a higher source sets the user agent", async () => {
    const { home, repo, cwd } = await layout();
    await writeConfig(repo, { userAgent: "RepoBot/1.0" });
    await writeUserConfig(path.join(home, ".config"), "{not json");

    await expect(resolveUserAgent("CliBot/1.0", locations(cwd, home))).rejects.toThrow(ConfigError);
  });

  it("fails with an error that names an invalid file", async () => {
    const { home, repo, cwd } = await layout();
    await writeUserConfig(path.join(home, ".config"), "{not json");

    const userConfig = path.join(home, ".config", "turbo-crawl", "config.json");
    await expect(resolveUserAgent(undefined, locations(cwd, home))).rejects.toThrow(userConfig);

    await writeConfig(repo, { userAgent: 42 });
    const error = await resolveUserAgent(undefined, locations(cwd, home)).catch(caught => caught);
    expect(error).toBeInstanceOf(ConfigError);
    expect(error.message).toContain(path.join(repo, "turbo-crawl.json"));
    expect(error.message).toContain("userAgent");
  });
});
