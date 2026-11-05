export type RobotsStatus = "allowed" | "disallowed" | "unknown";

type Rule = { allow: boolean; path: string };
type Group = { agents: string[]; rules: Rule[] };

export type RobotsRules = { groups: Group[] };

export function parseRobots(text: string): RobotsRules {
  const groups: Group[] = [];
  let current: Group | null = null;
  let lastWasAgent = false;

  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    const separator = line.indexOf(":");
    if (separator === -1) continue;

    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (key === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }

    lastWasAgent = false;
    if (!current || (key !== "allow" && key !== "disallow") || value === "") continue;
    current.rules.push({ allow: key === "allow", path: canonicalPath(value) });
  }

  return { groups };
}

export function productToken(userAgent: string): string {
  return (userAgent.trim().split(/[\s/]/)[0] ?? "").toLowerCase();
}

export function isPathAllowed(rules: RobotsRules, userAgent: string, pathAndQuery: string): boolean {
  if (pathAndQuery === "/robots.txt") return true;
  const path = canonicalPath(pathAndQuery);

  const token = productToken(userAgent);
  let matching = rules.groups.filter(group => group.agents.includes(token));
  if (matching.length === 0) {
    matching = rules.groups.filter(group => group.agents.includes("*"));
  }

  let best: Rule | null = null;
  for (const rule of matching.flatMap(group => group.rules)) {
    if (!pathMatches(rule.path, path)) continue;
    if (
      !best ||
      rule.path.length > best.path.length ||
      (rule.path.length === best.path.length && rule.allow && !best.allow)
    ) {
      best = rule;
    }
  }

  return best?.allow ?? true;
}

// RFC 9309 2.2.2: compare paths with non-ASCII characters percent-encoded and
// unreserved characters (such as %7E for ~) decoded.
function canonicalPath(value: string): string {
  return value
    .replace(/%([0-9a-fA-F]{2})/g, (match, hex: string) => {
      const char = String.fromCharCode(parseInt(hex, 16));
      return /[A-Za-z0-9\-._~]/.test(char) ? char : match.toUpperCase();
    })
    .replace(/[^\x21-\x7e]/gu, char => encodeURIComponent(char));
}

function pathMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const regex = body
    .split("*")
    .map(part => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${regex}${anchored ? "$" : ""}`).test(path);
}

export type RobotsFetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{
  status: number;
  text(): Promise<string>;
}>;

export type RobotsChecker = {
  check(url: string): Promise<RobotsStatus>;
};

type HostRules = RobotsRules | "allow-all" | "unknown";

export function createRobotsChecker(input: {
  userAgent: string;
  fetch?: RobotsFetch;
  timeoutMs?: number;
}): RobotsChecker {
  const fetchRobots: RobotsFetch = input.fetch ?? ((url, init) => fetch(url, init));
  const byOrigin = new Map<string, Promise<HostRules>>();

  const load = async (origin: string): Promise<HostRules> => {
    try {
      const response = await fetchRobots(`${origin}/robots.txt`, {
        headers: { "user-agent": input.userAgent },
        signal: AbortSignal.timeout(input.timeoutMs ?? 10_000),
      });
      if (response.status >= 200 && response.status < 300) return parseRobots(await response.text());
      if (response.status >= 400 && response.status < 500) return "allow-all";
      return "unknown";
    } catch {
      return "unknown";
    }
  };

  return {
    async check(url) {
      const parsed = new URL(url);
      let rules = byOrigin.get(parsed.origin);
      if (!rules) {
        rules = load(parsed.origin);
        byOrigin.set(parsed.origin, rules);
      }

      const resolved = await rules;
      if (resolved === "unknown") return "unknown";
      if (resolved === "allow-all") return "allowed";
      return isPathAllowed(resolved, input.userAgent, `${parsed.pathname}${parsed.search}`) ? "allowed" : "disallowed";
    },
  };
}
