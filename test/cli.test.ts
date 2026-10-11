import { describe, expect, it } from "bun:test";
import { createCli, parseCli } from "../src/cli.ts";

describe("createCli", () => {
  it("shows root help output", async () => {
    const { error, output } = await parseCli(["--help"]);

    expect(error).toBeUndefined();
    expect(output).toContain("turbo-crawl <command> [options]");
    expect(output).toContain("crawl <target>");
  });

  it("shows command help output", async () => {
    const { error, output } = await parseCli(["crawl", "--help"]);

    expect(error).toBeUndefined();
    expect(output).toContain("Extract structured data from a page");
    expect(output).toContain("--fields");
    expect(output).toContain("Absolute URL or hostname to crawl.");
  });

  it("fails when target is missing", async () => {
    const { error, output } = await parseCli(["crawl"]);

    expect(error).toBeDefined();
    expect(output).toContain("Not enough non-option arguments");
  });

  it("creates a parser for a valid crawl command", () => {
    const parser = createCli(["crawl", "https://example.com"]);

    expect(parser).toBeDefined();
  });
});
