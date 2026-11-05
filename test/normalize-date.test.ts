import { describe, expect, it } from "bun:test";
import { normalizeValue } from "../src/core/llm-extractor/validation/normalizeValue.ts";

const date = (value: unknown) => normalizeValue({ value, type: "date", baseUrl: "https://site.com/" });

describe("date normalization", () => {
  it("turns ISO 8601 with an offset, RFC 2822 and Unix timestamps into UTC ISO strings", () => {
    expect(date("2026-11-04T09:30:00Z")).toBe("2026-11-04T09:30:00.000Z");
    expect(date("2026-11-04T10:30:00+01:00")).toBe("2026-11-04T09:30:00.000Z");
    expect(date("Tue, 04 Nov 2026 09:30:00 GMT")).toBe("2026-11-04T09:30:00.000Z");
    expect(date("04 Nov 2026 10:30:00 +0100")).toBe("2026-11-04T09:30:00.000Z");
    expect(date("1793784600")).toBe("2026-11-04T09:30:00.000Z");
    expect(date("1793784600000")).toBe("2026-11-04T09:30:00.000Z");
  });

  it("keeps a date or a local time without an offset as written", () => {
    expect(date("2026-11-04")).toBe("2026-11-04");
    expect(date("2026-11-04T09:30")).toBe("2026-11-04T09:30");
    expect(date("2026-11-04 09:30:00")).toBe("2026-11-04T09:30:00");
    expect(date("2026-11-04 10:30:00+01:00")).toBe("2026-11-04T09:30:00.000Z");
  });

  it("gives null for dates in words, other text and impossible dates", () => {
    expect(date("4 novembre 2026")).toBeNull();
    expect(date("Nov 4, 2026")).toBeNull();
    expect(date("Leggi anche")).toBeNull();
    expect(date("2026-13-45")).toBeNull();
    expect(date("2026-02-30")).toBeNull();
    expect(date("2026-04-31T10:00")).toBeNull();
    expect(date("2026-02-30T10:00:00Z")).toBeNull();
  });
});
