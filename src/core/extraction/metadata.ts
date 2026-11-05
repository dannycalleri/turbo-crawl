import type { Page } from "playwright";

export interface PageMetadata {
    canonicalUrl: string | null;
    description: string | null;
    robots: string | null;
    openGraph: Record<string, string>;
    twitter: Record<string, string>;
    other: Record<string, string>;
}

export async function extractMetadata(page: Page): Promise<PageMetadata> {
  return page.evaluate(() => {
    const canonical = absoluteWithoutFragment(document.querySelector<HTMLLinkElement>('link[rel="canonical"]'));

    const openGraph: Record<string, string> = {};
    const twitter: Record<string, string> = {};
    const other: Record<string, string> = {};

    for (const meta of Array.from(document.querySelectorAll("meta"))) {
      const name = meta.getAttribute("name");
      const property = meta.getAttribute("property");
      const content = meta.getAttribute("content")?.trim();

      if (!content) continue;

      const key = property || name;
      if (!key) continue;

      if (key.startsWith("og:")) {
        openGraph[key] = content;
      } else if (key.startsWith("twitter:")) {
        twitter[key] = content;
      } else {
        other[key] = content;
      }
    }

    function absoluteWithoutFragment(link: HTMLLinkElement | null): string | null {
        if (!link?.getAttribute("href")) return null;
        try {
            const url = new URL(link.href);
            url.hash = "";
            return url.toString();
        } catch {
            return null;
        }
    }

    function getMetaByName(name: string): string | null {
        const el = document.querySelector(`meta[name="${CSS.escape(name)}"]`);
        return el?.getAttribute("content")?.trim() || null;
    }

    return {
      canonicalUrl: canonical,
      description: getMetaByName("description"),
      robots: getMetaByName("robots"),
      openGraph,
      twitter,
      other,
    };
  });
}