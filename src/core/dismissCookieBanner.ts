import type { Page } from "playwright";

const acceptPatterns = [
  /accept/i,
  /agree/i,
  /allow/i,
  /consent/i,
  /consenti/i,
  /consenti.*tutto/i,
  /consenti.*tutti/i,
  /consenti tutto/i,
  /consenti tutti/i,
  /accetta/i,
  /accetta.*tutto/i,
  /accetta.*tutti/i,
  /accetta i cookie/i,
  /accept all/i,
  /accept cookies/i,
  /allow all/i,
  /consenti i cookie/i,
];
const genericPattern = /cookie|cookies|consent|consenso|consenti|accetta|preferenze|impostazioni/i;
const attributeSelectors = [
  'button[aria-label*="cookie" i]',
  'button[aria-label*="consent" i]',
  '[data-testid*=cookie i]',
  '[data-test*=cookie i]',
  '[id*=cookie i]',
  '[class*=cookie i]',
  '[role=dialog] [id*=cookie i]',
  '[role=dialog] [class*=cookie i]',
  'div[role="dialog"] >> text=/cookie|consent|consenso|consenti|accetta/i',
];

export async function dismissCookieBanner(page: Page, options?: { timeout?: number; }) {
  const timeout = options?.timeout ?? 3000;

  // 1) Try targeted accept/consent text matches (prefer these)
  for (const pat of acceptPatterns) {
    try {
      const btn = page.getByText(pat, { exact: false }).first();
      if (await btn.count() && await btn.isVisible()) {
        await btn.click({ force: true });
        await page.waitForTimeout(200);
        return true;
      }
    } catch {
      // continue
    }
  }

  // 2) Try generic cookie text (may catch "Manage cookies" then try to accept inside)
  try {
    const generic = page.getByText(genericPattern, { exact: false }).first();
    if (await generic.count() && await generic.isVisible()) {
      await generic.click({ force: true });
      await page.waitForTimeout(200);
      // After opening dialog, try accept patterns again
      for (const pat of acceptPatterns) {
        try {
          const inner = page.getByText(pat, { exact: false }).first();
          if (await inner.count() && await inner.isVisible()) {
            await inner.click({ force: true });
            await page.waitForTimeout(200);
            return true;
          }
        } catch { }
      }
      return true;
    }
  } catch { }

  // 3) Attribute-based selectors fallback
  for (const sel of attributeSelectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.count() && await el.isVisible()) {
        await el.click({ force: true });
        await page.waitForTimeout(200);
        return true;
      }
    } catch { }
  }

  // 4) As last resort, try to set common consent cookies via context (best-effort)
  try {
    const url = page.url();
    const urlObj = new URL(url);
    const domain = urlObj.hostname;
    const cookieCandidates = [
      { name: 'cookie_consent', value: 'true', domain, path: '/' },
      { name: 'cookies_accepted', value: '1', domain, path: '/' },
      { name: 'euConsent', value: 'true', domain, path: '/' },
      { name: 'CONSENT', value: 'YES+1', domain, path: '/' },
    ];
    // addCookies requires a BrowserContext; try via page.context()
    await page.context().addCookies(cookieCandidates);
    await page.reload();
    await page.waitForTimeout(300);
    // verify banner gone
    const still = await page.getByText(genericPattern).first();
    if (!await still.count()) return true;
  } catch { }

  // 5) Final fallback: remove DOM nodes that look like cookie banners (non-destructive to site state)
  try {
    await page.evaluate(() => {
      const nodes = Array.from(document.querySelectorAll(
        '[id*=cookiei],[id*=cookie],[class*=cookiei],[class*=cookie],[data-testid*=cookie],[data-test*=cookie],[role=dialog]'
      ));
      nodes.forEach(n => {
        // try to detect small banner/dialogs by size or text
        try {
          if (n.textContent && /cookie|consent|consenso|consenti|accetta/i.test(n.textContent)) {
            n.remove();
          }
        } catch { }
      });
    });
    await page.waitForTimeout(200);
    return true;
  } catch { }

  return false;
}
