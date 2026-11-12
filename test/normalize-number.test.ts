import { describe, expect, it } from "bun:test";
import { normalizeValue } from "../src/core/llm-extractor/validation/normalizeValue.ts";

const number = (value: unknown) => normalizeValue({ value, type: "number" });

describe("number values", () => {
  it("reads one separator before exactly 3 digits as a thousands separator", () => {
    expect(number("10.000 €")).toBe(10000);
    expect(number("€ 10.000")).toBe(10000);
    expect(number("CHF 8,500")).toBe(8500);
    expect(number("$12,500")).toBe(12500);
  });

  it("reads one separator kind used more than once as a thousands separator", () => {
    expect(number("1.250.000 €")).toBe(1250000);
    expect(number("1,250,000")).toBe(1250000);
    expect(number("1.25.000")).toBeNull();
    expect(number("12345.678.901")).toBeNull();
  });

  it("reads the last separator as the decimal separator when both kinds are there", () => {
    expect(number("9.850,00 €")).toBe(9850);
    expect(number("1,250,000.50")).toBe(1250000.5);
  });

  it("reads any other single separator as the decimal separator", () => {
    expect(number("12,5")).toBe(12.5);
    expect(number("3.75")).toBe(3.75);
    expect(number("0.500 kg")).toBe(0.5);
    expect(number("1234")).toBe(1234);
  });
});
