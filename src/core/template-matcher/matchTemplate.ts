import type { TemplateMatchCandidate } from "../domain-store.ts";
import type { TemplateExtractionResult } from "../template-extractor/types.ts";
import { urlMatchesPattern } from "../templating/urlPatterns.ts";

export const MIN_TEXT_FIELD_LENGTH = 200;

export type TemplateTrial = {
  candidate: TemplateMatchCandidate;
  result: TemplateExtractionResult;
};

export type MatchDecision =
  | { kind: "fit"; trial: TemplateTrial; matchedPattern: boolean }
  | { kind: "stale"; trial: TemplateTrial; reasons: string[] }
  | { kind: "ambiguous"; trials: TemplateTrial[] }
  | { kind: "none" };

export type MatchOptions = {
  url: string;
  require?: string[];
  fieldsGiven: boolean;
};

export function decideTemplate(trials: TemplateTrial[], options: MatchOptions): MatchDecision {
  const fits = trials.filter(trial => misfitReasons(trial, options.require).length === 0);

  if (fits.length > 0) {
    const ranked = [...fits].sort((left, right) => compareRank(right, left, options.url));
    const best = ranked[0]!;
    const tied = ranked.filter(trial => compareRank(trial, best, options.url) === 0);

    if (tied.length > 1 && !options.fieldsGiven) {
      return { kind: "ambiguous", trials: tied };
    }

    const chosen = [...tied].sort((left, right) => right.candidate.template.createdAt.localeCompare(left.candidate.template.createdAt))[0]!;
    return { kind: "fit", trial: chosen, matchedPattern: knowsPattern(chosen, options.url) };
  }

  const known = trials
    .filter(trial => knowsPattern(trial, options.url))
    .sort((left, right) => foundCount(right) - foundCount(left));
  if (known.length > 0) {
    const trial = known[0]!;
    return {
      kind: "stale",
      trial,
      reasons: misfitReasons(trial, options.require),
    };
  }

  return { kind: "none" };
}

export function missingFields(schema: Record<string, unknown>, payload: Record<string, unknown>): string[] {
  return Object.keys(schema)
    .filter(name => payload[name] === null || payload[name] === undefined)
    .sort();
}

export function misfitReasons(trial: TemplateTrial, require: string[] | undefined): string[] {
  const { schema } = trial.candidate.template;
  const required = require ?? Object.keys(schema);
  const unknown = required.filter(name => !(name in schema));
  if (required.length === 0 || unknown.length > 0) {
    return [`the template has no field ${unknown.join(", ") || "to require"}`];
  }

  const reasons: string[] = [];
  const empty = required.filter(name => trial.result.fieldResults[name]?.normalizedValue == null);
  if (empty.length > 0) reasons.push(`no value for ${empty.join(", ")}`);

  // Meta and JSON-LD values exist on almost every page of a site; a page-body
  // selector that also reads a value is what ties the template to one layout.
  if (!required.some(name => trial.result.fieldResults[name]?.bodyMatched)) {
    reasons.push("no css selector of a required field reads a value on this page");
  }

  const short = Object.keys(schema).filter(name => {
    const value = trial.result.fieldResults[name]?.normalizedValue;
    return schema[name] === "text" && typeof value === "string" && value.length < MIN_TEXT_FIELD_LENGTH;
  });
  if (short.length > 0) reasons.push(`${short.join(", ")} is shorter than ${MIN_TEXT_FIELD_LENGTH} characters`);

  return reasons;
}

function compareRank(left: TemplateTrial, right: TemplateTrial, url: string): number {
  return (
    foundCount(left) - foundCount(right) ||
    Number(knowsPattern(left, url)) - Number(knowsPattern(right, url))
  );
}

function foundCount(trial: TemplateTrial): number {
  return Object.values(trial.result.fieldResults).filter(field => field.normalizedValue !== null).length;
}

function knowsPattern(trial: TemplateTrial, url: string): boolean {
  return urlMatchesPattern(url, trial.candidate.template.urlPatterns);
}
