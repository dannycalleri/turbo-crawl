import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createBrowserSession, type BrowserSession } from "../src/core/crawler.ts";

const articleHtml = `<!doctype html>
<html>
  <head>
    <title>Article</title>
    <link rel="canonical" href="/news/rolex#top">
    <meta name="tdm-reservation" content="1">
  </head>
  <body><main><h1>Rolex</h1></main></body>
</html>`;

describe("page capture on a real browser", () => {
  let server: ReturnType<typeof Bun.serve>;
  let session: BrowserSession;
  const userAgents: string[] = [];

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        userAgents.push(request.headers.get("user-agent") ?? "");
        return new Response(articleHtml, {
          status: 203,
          headers: {
            "content-type": "text/html; charset=utf-8",
            "x-robots-tag": "noai",
            "tdm-reservation": "1",
            "tdm-policy": "https://example.com/tdm.json",
          },
        });
      },
    });
    session = createBrowserSession({ userAgent: "TestBot/1.0", settleTimeoutMs: 500 });
  });

  afterAll(async () => {
    await session.close();
    server.stop(true);
  });

  it("records the response status, policy headers, user agent and an absolute canonical URL", async () => {
    const base = `http://127.0.0.1:${server.port}`;
    let launchFailed = false;

    const packet = await session
      .withRenderedPage(`${base}/a`, ({ pagePacket }) => pagePacket)
      .catch(error => {
        if (/Executable doesn't exist/.test(String(error))) {
          launchFailed = true;
          return null;
        }
        throw error;
      });
    if (launchFailed || !packet) return;

    expect(packet.response).toEqual({
      status: 203,
      xRobotsTag: "noai",
      tdmReservation: "1",
      tdmPolicy: "https://example.com/tdm.json",
      retryAfter: null,
    });
    expect(packet.metadata.canonicalUrl).toBe(`${base}/news/rolex`);
    expect(packet.metadata.other["tdm-reservation"]).toBe("1");
    expect(userAgents[0]).toBe("TestBot/1.0");
  }, 30_000);
});
