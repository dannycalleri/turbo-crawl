import { describe, expect, it } from "bun:test";
import { createRobotsChecker, isPathAllowed, parseRobots, type RobotsFetch } from "../src/core/policy/robots.ts";

const BOT = "ExampleBot/1.0 (+https://example.com/bot)";

describe("isPathAllowed", () => {
  it("uses the * group when no group names the product token", () => {
    const rules = parseRobots("User-agent: *\nDisallow: /private/\n");

    expect(isPathAllowed(rules, BOT, "/private/a")).toBe(false);
    expect(isPathAllowed(rules, BOT, "/public/a")).toBe(true);
  });

  it("uses the group of the product token instead of *", () => {
    const rules = parseRobots(`
User-agent: *
Allow: /

User-agent: examplebot
Disallow: /
`);

    expect(isPathAllowed(rules, BOT, "/news/a")).toBe(false);
    expect(isPathAllowed(rules, "OtherBot/2.0", "/news/a")).toBe(true);
  });

  it("applies the rules to every user agent listed above them", () => {
    const rules = parseRobots("User-agent: a-bot\nUser-agent: ExampleBot\nDisallow: /x # comment\n");

    expect(isPathAllowed(rules, BOT, "/x/1")).toBe(false);
    expect(isPathAllowed(rules, "a-bot", "/x/1")).toBe(false);
  });

  it("lets the longest match win, and Allow win a tie", () => {
    const rules = parseRobots(`
User-agent: *
Disallow: /news/
Allow: /news/public/
Disallow: /tie
Allow: /tie
`);

    expect(isPathAllowed(rules, BOT, "/news/a")).toBe(false);
    expect(isPathAllowed(rules, BOT, "/news/public/a")).toBe(true);
    expect(isPathAllowed(rules, BOT, "/tie")).toBe(true);
  });

  it("supports * and $ in paths and matches the query string", () => {
    const rules = parseRobots("User-agent: *\nDisallow: /*.pdf$\nDisallow: /*?print=\n");

    expect(isPathAllowed(rules, BOT, "/files/report.pdf")).toBe(false);
    expect(isPathAllowed(rules, BOT, "/files/report.pdf?x=1")).toBe(true);
    expect(isPathAllowed(rules, BOT, "/news/a?print=1")).toBe(false);
  });

  it("compares paths in one percent-encoded form", () => {
    const rules = parseRobots("User-agent: *\nDisallow: /café/\nDisallow: /%7Euser/\n");

    expect(isPathAllowed(rules, BOT, new URL("https://site.com/café/a").pathname)).toBe(false);
    expect(isPathAllowed(rules, BOT, "/caf%c3%a9/a")).toBe(false);
    expect(isPathAllowed(rules, BOT, "/~user/x")).toBe(false);
    expect(isPathAllowed(rules, BOT, "/cafe/a")).toBe(true);
  });

  it("measures the longest match on the percent-encoded form", () => {
    const rules = parseRobots("User-agent: *\nAllow: /café/x\nDisallow: /caf%C3%A9/\n");

    expect(isPathAllowed(rules, BOT, new URL("https://a.com/café/x").pathname)).toBe(true);
    expect(isPathAllowed(rules, BOT, new URL("https://a.com/café/y").pathname)).toBe(false);
  });

  it("ignores an empty Disallow and always allows /robots.txt", () => {
    expect(isPathAllowed(parseRobots("User-agent: *\nDisallow:\n"), BOT, "/a")).toBe(true);
    expect(isPathAllowed(parseRobots("User-agent: *\nDisallow: /\n"), BOT, "/robots.txt")).toBe(true);
  });
});

describe("createRobotsChecker", () => {
  function fakeFetch(answer: () => Promise<{ status: number; body?: string }>) {
    const requests: Array<{ url: string; userAgent: string }> = [];
    const fetch: RobotsFetch = async (url, init) => {
      requests.push({ url, userAgent: init.headers["user-agent"] ?? "" });
      const { status, body } = await answer();
      return { status, text: async () => body ?? "" };
    };
    return { fetch, requests };
  }

  it("fetches robots.txt once per host with the user agent, even for concurrent checks", async () => {
    const { fetch, requests } = fakeFetch(async () => ({ status: 200, body: "User-agent: *\nDisallow: /private/" }));
    const checker = createRobotsChecker({ userAgent: BOT, fetch });

    const results = await Promise.all([
      checker.check("https://site.com/a"),
      checker.check("https://site.com/private/b"),
      checker.check("https://site.com/c"),
      checker.check("https://other.com/private/b"),
    ]);

    expect(results).toEqual(["allowed", "disallowed", "allowed", "disallowed"]);
    expect(requests).toEqual([
      { url: "https://site.com/robots.txt", userAgent: BOT },
      { url: "https://other.com/robots.txt", userAgent: BOT },
    ]);
  });

  it("allows everything when robots.txt answers 4xx", async () => {
    const { fetch } = fakeFetch(async () => ({ status: 404 }));

    expect(await createRobotsChecker({ userAgent: BOT, fetch }).check("https://site.com/private/a")).toBe("allowed");
  });

  it("reports unknown when robots.txt answers 5xx or the fetch fails", async () => {
    const serverError = fakeFetch(async () => ({ status: 503 }));
    const networkError = fakeFetch(async () => {
      throw new Error("ECONNREFUSED");
    });

    expect(await createRobotsChecker({ userAgent: BOT, fetch: serverError.fetch }).check("https://site.com/a")).toBe("unknown");
    expect(await createRobotsChecker({ userAgent: BOT, fetch: networkError.fetch }).check("https://site.com/a")).toBe("unknown");
  });
});
