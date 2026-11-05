import { describe, expect, it } from "bun:test";
import { renderSkeleton, type SkeletonNode } from "../src/core/pageContext/skeleton.ts";

function node(tag: string, text: string, children: SkeletonNode[] = []): SkeletonNode {
  return { tag, attrs: "", text, children };
}

describe("renderSkeleton", () => {
  const tree = node("body", "", [
    node("main", "", [node("section", "", [node("p", "deep paragraph text")])]),
  ]);

  it("drops the deepest levels first to fit the budget", () => {
    const full = renderSkeleton(tree, 10_000);
    const shallow = renderSkeleton(tree, full.bytes - 1);

    expect(full.truncated).toBe(false);
    expect(full.text).toContain("deep paragraph text");
    expect(shallow.truncated).toBe(true);
    expect(shallow.text).not.toContain("deep paragraph text");
    expect(shallow.bytes).toBeLessThanOrEqual(full.bytes - 1);
  });

  it("returns an empty skeleton for a page without a body", () => {
    expect(renderSkeleton(null, 100)).toEqual({ text: "", bytes: 0, truncated: false });
  });
});
