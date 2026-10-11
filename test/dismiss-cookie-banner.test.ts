import { describe, expect, it } from "bun:test";
import { dismissCookieBanner } from "../src/core/dismissCookieBanner.ts";

type MockLocator = {
  count(): Promise<number>;
  isVisible(): Promise<boolean>;
  click(args?: unknown): Promise<void>;
  first(): MockLocator;
};

function createLocator(options?: {
  count?: number;
  visible?: boolean;
  onClick?: () => void;
}): MockLocator {
  return {
    async count() {
      return options?.count ?? 0;
    },
    async isVisible() {
      return options?.visible ?? false;
    },
    async click() {
      options?.onClick?.();
    },
    first() {
      return this;
    },
  };
}

function createBasePage() {
  const clicked: string[] = [];
  const cookies: unknown[][] = [];
  let reloaded = false;
  let evaluateCalls = 0;

  const page = {
    getByText(pattern: RegExp) {
      if (String(pattern) === String(/accept/i)) {
        return createLocator({
          count: 1,
          visible: true,
          onClick: () => clicked.push("accept"),
        });
      }

      return createLocator();
    },
    locator() {
      return createLocator();
    },
    async waitForTimeout() {},
    url() {
      return "https://example.com";
    },
    context() {
      return {
        async addCookies(input: unknown[]) {
          cookies.push(input);
        },
      };
    },
    async reload() {
      reloaded = true;
    },
    async evaluate() {
      evaluateCalls += 1;
    },
  };

  return {
    page,
    clicked,
    cookies,
    get reloaded() {
      return reloaded;
    },
    get evaluateCalls() {
      return evaluateCalls;
    },
  };
}

describe("dismissCookieBanner", () => {
  it("accepts a visible consent button when one is found", async () => {
    const state = createBasePage();

    const dismissed = await dismissCookieBanner(state.page as never);

    expect(dismissed).toBe(true);
    expect(state.clicked).toEqual(["accept"]);
  });

  it("falls back to attribute selectors when text matching does not work", async () => {
    const clicks: string[] = [];
    const page = {
      getByText() {
        return createLocator();
      },
      locator(selector: string) {
        if (selector === 'button[aria-label*="cookie" i]') {
          return createLocator({
            count: 1,
            visible: true,
            onClick: () => clicks.push("attribute"),
          });
        }

        return createLocator();
      },
      async waitForTimeout() {},
      url() {
        return "https://example.com";
      },
      context() {
        return {
          async addCookies() {},
        };
      },
      async reload() {},
      async evaluate() {},
    };

    const dismissed = await dismissCookieBanner(page as never);

    expect(dismissed).toBe(true);
    expect(clicks).toEqual(["attribute"]);
  });

  it("attempts cookie injection and reload before the dom-removal fallback", async () => {
    const state = createBasePage();
    const counts: number[] = [0, 0];

    state.page.getByText = () =>
      createLocator({
        count: counts.shift() ?? 0,
        visible: false,
      });

    const dismissed = await dismissCookieBanner(state.page as never);

    expect(dismissed).toBe(true);
    expect(state.cookies).toHaveLength(1);
    expect(state.reloaded).toBe(true);
  });

  it("returns false when every fallback path fails", async () => {
    const page = {
      getByText() {
        return createLocator();
      },
      locator() {
        return createLocator();
      },
      async waitForTimeout() {},
      url() {
        return "https://example.com";
      },
      context() {
        return {
          async addCookies() {
            throw new Error("cookie injection failed");
          },
        };
      },
      async reload() {},
      async evaluate() {
        throw new Error("dom cleanup failed");
      },
    };

    const dismissed = await dismissCookieBanner(page as never);

    expect(dismissed).toBe(false);
  });
});
