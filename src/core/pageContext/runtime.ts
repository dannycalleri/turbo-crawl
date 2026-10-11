import type { Page } from "playwright";

function initTurboCrawlHelpers() {
  if (window.__turboCrawl) {
    return;
  }

  function normalizeWhitespace(input: string): string {
    return input.replace(/\s+/g, " ").trim();
  }

  function isStableToken(token: string): boolean {
    if (!token) return false;
    if (token.length > 80) return false;

    const lower = token.toLowerCase();

    if (/^[a-f0-9]{8,}$/.test(lower)) return false;
    if (/css-[a-z0-9]{5,}/.test(lower)) return false;
    if (/^_[a-z0-9]+$/.test(lower)) return false;
    if (/\d{5,}/.test(lower)) return false;

    return true;
  }

  function cssStringEscape(value: string): string {
    return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  function getCssPath(el: Element): string {
    const parts: string[] = [];
    let current: Element | null = el;

    while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.body) {
      const tag = current.tagName.toLowerCase();
      const id = current.getAttribute("id");

      if (id && isStableToken(id)) {
        parts.unshift(`${tag}#${CSS.escape(id)}`);
        break;
      }

      const testId =
        current.getAttribute("data-testid") ??
        current.getAttribute("data-test") ??
        current.getAttribute("data-cy");

      if (testId) {
        const attributeName = current.getAttribute("data-testid")
          ? "data-testid"
          : current.getAttribute("data-test")
            ? "data-test"
            : "data-cy";
        parts.unshift(`${tag}[${attributeName}="${cssStringEscape(testId)}"]`);
        break;
      }

      const className = Array.from(current.classList)
        .filter(isStableToken)
        .slice(0, 2)
        .map((cls) => `.${CSS.escape(cls)}`)
        .join("");

      const parent: Element | null = current.parentElement;

      if (!parent) {
        parts.unshift(tag + className);
        break;
      }

      const currentTagName = current.tagName;
      const siblings = Array.from(parent.children).filter(
        (child): child is Element => child.tagName === currentTagName,
      );

      if (className) {
        parts.unshift(tag + className);
      } else if (siblings.length > 1) {
        const index = siblings.indexOf(current) + 1;
        parts.unshift(`${tag}:nth-of-type(${index})`);
      } else {
        parts.unshift(tag);
      }

      current = parent;
    }

    return parts.join(" > ");
  }

  window.__turboCrawl = {
    normalizeWhitespace,
    isStableToken,
    cssStringEscape,
    getCssPath,
  };
}

export async function installPageContextHelpers(page: Page): Promise<void> {
  await page.addInitScript(initTurboCrawlHelpers);

  await page
    .evaluate(initTurboCrawlHelpers)
    .catch(() => {
      // Ignore failures on empty/about:blank transitions; addInitScript handles navigations.
    });
}
