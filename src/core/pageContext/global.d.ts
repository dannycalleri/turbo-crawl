export {};

declare global {
  interface Window {
    __turboCrawl?: {
      normalizeWhitespace(input: string): string;
      isStableToken(token: string): boolean;
      cssStringEscape(value: string): string;
      getCssPath(el: Element): string;
    };
  }
}
