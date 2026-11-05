import { describe, expect, it } from "bun:test";
import { buildPolicy, failureForStatus, parseRetryAfter, type PolicyInfo } from "../src/core/policy/policy.ts";
import type { PagePacket } from "../src/core/types.ts";

const now = new Date("2026-11-05T12:00:00.000Z");

function policy(httpStatus: number | null): PolicyInfo {
  return { robots: "allowed", tdmReservation: null, tdmPolicyUrl: null, xRobotsTag: null, metaRobots: null, httpStatus };
}

function packet(response: Partial<PagePacket["response"]>, meta: Record<string, string> = {}, robots: string | null = null): PagePacket {
  return {
    response: { status: 200, xRobotsTag: null, tdmReservation: null, tdmPolicy: null, retryAfter: null, ...response },
    metadata: { canonicalUrl: null, description: null, robots, openGraph: {}, twitter: {}, other: meta },
  } as PagePacket;
}

describe("buildPolicy", () => {
  it("reads the TDM reservation and policy from headers first, then meta tags", () => {
    expect(buildPolicy(packet({ tdmReservation: "1", tdmPolicy: "https://a/tdm.json" }, { "tdm-reservation": "0" }), "allowed"))
      .toMatchObject({ tdmReservation: true, tdmPolicyUrl: "https://a/tdm.json" });
    expect(buildPolicy(packet({}, { "tdm-reservation": "0", "tdm-policy": "https://b/tdm.json" }), "allowed"))
      .toMatchObject({ tdmReservation: false, tdmPolicyUrl: "https://b/tdm.json" });
    expect(buildPolicy(packet({}), "unknown")).toMatchObject({ tdmReservation: null, tdmPolicyUrl: null, robots: "unknown" });
  });

  it("reports the status, x-robots-tag and robots meta as read", () => {
    expect(buildPolicy(packet({ status: 203, xRobotsTag: "noai" }, {}, "noindex"), "allowed")).toEqual({
      robots: "allowed",
      tdmReservation: null,
      tdmPolicyUrl: null,
      xRobotsTag: "noai",
      metaRobots: "noindex",
      httpStatus: 203,
    });
  });
});

describe("failureForStatus", () => {
  it("gives no failure below 400", () => {
    expect(failureForStatus("https://a/x", policy(200), null, now)).toBeNull();
    expect(failureForStatus("https://a/x", policy(null), null, now)).toBeNull();
  });

  it("maps 401, 403 and 429 to BLOCKED with the Retry-After delay", () => {
    for (const status of [401, 403, 429]) {
      expect(failureForStatus("https://a/x", policy(status), null, now)?.code).toBe("BLOCKED");
    }
    const failure = failureForStatus("https://a/x", policy(429), "120", now);
    expect(failure).toMatchObject({ code: "BLOCKED", retryAfterSeconds: 120 });
    expect(failure?.policy?.httpStatus).toBe(429);
  });

  it("maps other 4xx and 5xx statuses to HTTP_ERROR", () => {
    expect(failureForStatus("https://a/x", policy(404), null, now)?.code).toBe("HTTP_ERROR");
    expect(failureForStatus("https://a/x", policy(503), "30", now)).toMatchObject({ code: "HTTP_ERROR", retryAfterSeconds: null });
  });
});

describe("parseRetryAfter", () => {
  it("reads seconds and HTTP dates as seconds from now", () => {
    expect(parseRetryAfter("120", now)).toBe(120);
    expect(parseRetryAfter("Thu, 05 Nov 2026 12:01:30 GMT", now)).toBe(90);
    expect(parseRetryAfter("Thu, 05 Nov 2026 11:00:00 GMT", now)).toBe(0);
  });

  it("gives null when the header is absent or unreadable", () => {
    expect(parseRetryAfter(null, now)).toBeNull();
    expect(parseRetryAfter("soon", now)).toBeNull();
  });
});
