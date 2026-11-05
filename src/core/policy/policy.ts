import type { PagePacket } from "../types.ts";
import type { RobotsStatus } from "./robots.ts";

export type PolicyInfo = {
  robots: RobotsStatus;
  tdmReservation: boolean | null;
  tdmPolicyUrl: string | null;
  xRobotsTag: string | null;
  metaRobots: string | null;
  httpStatus: number | null;
};

export type CrawlFailureCode = "ROBOTS_DISALLOWED" | "BLOCKED" | "HTTP_ERROR" | "TIMEOUT";

export class CrawlFailure extends Error {
  constructor(
    readonly code: CrawlFailureCode,
    message: string,
    readonly policy: PolicyInfo | null,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = "CrawlFailure";
  }
}

export function buildPolicy(pagePacket: PagePacket, robots: RobotsStatus): PolicyInfo {
  const meta = pagePacket.metadata.other;
  return {
    robots,
    tdmReservation: parseTdmReservation(pagePacket.response.tdmReservation ?? meta["tdm-reservation"] ?? null),
    tdmPolicyUrl: pagePacket.response.tdmPolicy ?? meta["tdm-policy"] ?? null,
    xRobotsTag: pagePacket.response.xRobotsTag,
    metaRobots: pagePacket.metadata.robots,
    httpStatus: pagePacket.response.status,
  };
}

function parseTdmReservation(value: string | null): boolean | null {
  const trimmed = value?.trim();
  if (trimmed === "1") return true;
  if (trimmed === "0") return false;
  return null;
}

export function failureForStatus(
  url: string,
  policy: PolicyInfo,
  retryAfter: string | null,
  now: Date = new Date(),
): CrawlFailure | null {
  const status = policy.httpStatus;
  if (status === null || status < 400) return null;

  if (status === 401 || status === 403 || status === 429) {
    return new CrawlFailure(
      "BLOCKED",
      `${url} answered ${status}: the site refused the request. Wait before trying this host again.`,
      policy,
      parseRetryAfter(retryAfter, now),
    );
  }

  return new CrawlFailure(
    "HTTP_ERROR",
    `${url} answered ${status}. Check that the URL is right${status >= 500 ? ", or try again later" : ""}.`,
    policy,
  );
}

export function parseRetryAfter(value: string | null, now: Date = new Date()): number | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) return Number(trimmed);

  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.max(0, Math.ceil((date - now.getTime()) / 1000));
}
