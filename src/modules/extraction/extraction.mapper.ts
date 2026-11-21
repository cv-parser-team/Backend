import { createHash } from 'node:crypto';
import {
  certificationValuesSchema,
  createCandidateBodySchema,
  educationValuesSchema,
  employmentValuesSchema,
  languageValuesSchema,
  projectValuesSchema,
  skillValuesSchema
} from '../candidates/candidates.schemas.js';
import { InvalidAiOutputError } from './extraction.errors.js';
import {
  AI_OUTPUT_VERSION,
  CLAIM_TYPES,
  ClaimType,
  ExtractedClaim,
  ExtractedField,
  ExtractedProfile,
  ExtractedUnmapped
} from './extraction.schemas.js';
import {
  validateClaim,
  validateEnvelope,
  validateProfile,
  validateUnmapped,
  validatorFor
} from './extraction.validator.js';

export type DraftValues = Record<string, string | string[]>;

export const AUTO_ACCEPT_MIN_CONFIDENCE = 0.95;

// A claim ready to be saved as extracted. Its values use the same shape as
// manual claims.
export interface ClaimDraft {
  type: ClaimType;
  origin: 'extracted';
  status: 'accepted' | 'pending';
  // The lowest confidence among the kept fields: a claim is only as reliable
  // as its weakest value, and an average would hide one doubtful field.
  confidence: number;
  fieldConfidence: Record<string, number>;
  // Set when the end date is written as "Present".
  current: boolean;
  values: DraftValues;
  // Text as the CV wrote it, for fields whose value was read from it, such as
  // "Oct 2023" for a start date of 2023-10.
  rawValues: Record<string, string>;
  // Every line reference that supports the claim, in order of appearance.
  sources: string[];
  fieldSources: Record<string, string[]>;
}

export interface ProfileValues {
  fullName?: string;
  headline?: string;
  summary?: string;
  phone?: string;
  location?: string;
  contactEmail?: string;
  profileLinks?: { label: string; url: string }[];
}

export interface ProfileDraft {
  values: ProfileValues;
  rawValues: Partial<Record<keyof ProfileValues, string>>;
  // For links, the lowest confidence among the kept links.
  confidence: Partial<Record<keyof ProfileValues, number>>;
  sources: Partial<Record<keyof ProfileValues, string[]>>;
}

// Same shape as `document_extractions.unmapped_data`, so items can be stored
// there later.
export interface UnmappedItem {
  label: string;
  text: string;
  sources: string[];
  reason: string;
}

export interface ExtractionReviewIssue {
  field: string | null;
  code: string;
  required: boolean;
}

// A recognized claim that needs a person to complete or correct it before it
// can safely enter the canonical claims tables.
export interface ExtractionReviewItemDraft {
  claimType: ClaimType;
  fields: Record<string, unknown>;
  issues: ExtractionReviewIssue[];
  sources: string[];
  fingerprint: string;
}

export interface MappingResult {
  version: number;
  profile: ProfileDraft;
  claims: ClaimDraft[];
  reviewItems: ExtractionReviewItemDraft[];
  unmapped: UnmappedItem[];
}

interface ClaimRules {
  required: string[];
  // Start and end date fields, checked for format and order.
  dates: [start: string, end: string] | null;
  validateValues: ReturnType<typeof validatorFor>;
}

// Drafts are checked with the same value schemas as manual claims, so every
// draft can become a real claim.
const CLAIM_RULES: Record<ClaimType, ClaimRules> = {
  skill: { required: ['name'], dates: null, validateValues: validatorFor(skillValuesSchema) },
  employment: {
    required: ['employer', 'jobTitle', 'startDate'],
    dates: ['startDate', 'endDate'],
    validateValues: validatorFor(employmentValuesSchema)
  },
  education: {
    required: ['institution', 'degree', 'startDate'],
    dates: ['startDate', 'endDate'],
    validateValues: validatorFor(educationValuesSchema)
  },
  certification: {
    required: ['title', 'issuer', 'issueDate'],
    dates: ['issueDate', 'expiryDate'],
    validateValues: validatorFor(certificationValuesSchema)
  },
  language: { required: ['name'], dates: null, validateValues: validatorFor(languageValuesSchema) },
  project: {
    required: ['name'],
    dates: ['startDate', 'endDate'],
    validateValues: validatorFor(projectValuesSchema)
  }
};

const PROFILE_TEXT_FIELDS = [
  'fullName',
  'headline',
  'summary',
  'phone',
  'location',
  'contactEmail'
] as const;

const profileProperties = createCandidateBodySchema.properties;
const PROFILE_VALIDATORS = {
  fullName: validatorFor(profileProperties.fullName),
  headline: validatorFor(profileProperties.headline),
  summary: validatorFor(profileProperties.summary),
  phone: validatorFor(profileProperties.phone),
  location: validatorFor(profileProperties.location),
  contactEmail: validatorFor(profileProperties.contactEmail),
  profileLink: validatorFor(profileProperties.profileLinks.items)
};

// Dates keep the precision supplied by the source. A year is valid on its own,
// and no month is invented.
const CLAIM_DATE = /^\d{4}(-(0[1-9]|1[0-2]))?$/;

function dateLowerBound(value: string): string {
  return value.length === 4 ? `${value}-01` : value;
}

function dateUpperBound(value: string): string {
  return value.length === 4 ? `${value}-12` : value;
}

function toSnakeCase(fieldName: string): string {
  return fieldName.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

// References are copied as complete tokens from compact AI input. Keeping
// ranges opaque avoids accepting a range or block row that was never supplied
// to the provider.
const AI_INPUT_REFERENCE = /^(?:## )?(L\d+(?:-\d+)?(?:,\d+(?:-\d+)?)?|B\d+(?:\.\d+)?)\s/;

export function collectAiInputReferences(input: string): ReadonlySet<string> {
  const references = new Set<string>();
  for (const line of input.split('\n')) {
    const reference = AI_INPUT_REFERENCE.exec(line)?.[1];
    if (reference) {
      references.add(reference);
    }
  }
  return references;
}

function sourcesExist(sources: string[], availableSources?: ReadonlySet<string>): boolean {
  return availableSources === undefined || sources.every((source) => availableSources.has(source));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function strings(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value];
  }
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

// The fields of an invalid item: a claim's `fields`, or a profile's fields and
// links.
function fieldsOf(item: unknown): Record<string, unknown>[] {
  if (!isRecord(item)) {
    return [];
  }
  const fields = isRecord(item.fields) ? Object.values(item.fields) : Object.values(item);
  return fields.flatMap((field) => (Array.isArray(field) ? field : [field])).filter(isRecord);
}

// Keeps whatever text and references an item has, even when it is invalid, so
// nothing the AI found is lost.
function describeInvalid(label: string, item: unknown, reason: string): UnmappedItem {
  const texts: string[] = [];
  const sources: string[] = [];
  for (const field of fieldsOf(item)) {
    texts.push(...strings(field.raw ?? field.value));
    sources.push(...strings(field.sources));
  }
  if (isRecord(item)) {
    texts.push(...strings(item.text));
    sources.push(...strings(item.sources));
  } else {
    texts.push(...strings(item));
  }
  return { label, text: texts.join('; '), sources: unique(sources), reason };
}

function describeField(field: ExtractedField): string {
  return field.raw ?? strings(field.value).join(', ');
}

function trimmed(value: string | string[]): string | string[] {
  return typeof value === 'string' ? value.trim() : value.map((item) => item.trim());
}

interface ClaimMapping {
  draft: ClaimDraft | null;
  reviewItems: ExtractionReviewItemDraft[];
}

const DEGREE_ABBREVIATIONS = new Set([
  'aa', 'as', 'ba', 'bas', 'bba', 'beng', 'bfa', 'bs', 'bsc',
  'edd', 'jd', 'ma', 'mba', 'meng', 'mfa', 'ms', 'msc', 'phd'
]);

function isRecognizedDegreePrefix(value: string): boolean {
  const words = value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[’']/gu, '')
    .trim();
  if (/^(associate|bachelor|bachelors|master|masters|doctor|doctorate|diploma)\b/u.test(words)) {
    return true;
  }
  return DEGREE_ABBREVIATIONS.has(words.replace(/[^a-z]/gu, ''));
}

// Providers sometimes keep an explicitly written discipline inside the degree
// even though the contract has a separate field. Only split the unambiguous
// "recognized degree in discipline" form; broader guesses belong in review.
function separateEducationFieldOfStudy(claim: ExtractedClaim): ExtractedClaim {
  if (claim.type !== 'education' || claim.fields.fieldOfStudy) {
    return claim;
  }
  const degree = claim.fields.degree;
  if (!degree || typeof degree.value !== 'string') {
    return claim;
  }
  const match = /^(.*?)\s+in\s+(.+)$/iu.exec(degree.value.trim());
  if (!match) {
    return claim;
  }
  const degreeValue = match[1]?.trim() ?? '';
  const fieldOfStudy = match[2]?.trim() ?? '';
  if (!degreeValue || !fieldOfStudy || !isRecognizedDegreePrefix(degreeValue)) {
    return claim;
  }
  return {
    ...claim,
    fields: {
      ...claim.fields,
      degree: { ...degree, value: degreeValue, raw: degreeValue },
      fieldOfStudy: {
        value: fieldOfStudy,
        raw: fieldOfStudy,
        confidence: degree.confidence,
        sources: degree.sources
      }
    }
  };
}

// A skill claim represents one skill. Preserve the same physical evidence for
// every explicitly comma-delimited item while keeping each item independent.
function separateCommaDelimitedSkills(claim: ExtractedClaim): ExtractedClaim[] {
  if (claim.type !== 'skill') {
    return [claim];
  }
  const name = claim.fields.name;
  if (!name) {
    return [claim];
  }
  const written = typeof name.value === 'string' ? [name.value] : name.value;
  if (
    !written ||
    (written.length === 1 && !written[0]?.includes(','))
  ) {
    return [claim];
  }
  const seen = new Set<string>();
  const names = written
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter((value) => {
      const key = value.toLocaleLowerCase();
      if (!value || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  return names.map((value) => ({
    ...claim,
    fields: {
      ...claim.fields,
      name: { ...name, value, raw: value }
    }
  }));
}

function separateCombinedClaimValues(claim: ExtractedClaim): ExtractedClaim[] {
  return separateCommaDelimitedSkills(separateEducationFieldOfStudy(claim));
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function reviewItem(
  claimType: ClaimType,
  fields: Record<string, unknown>,
  issues: ExtractionReviewIssue[]
): ExtractionReviewItemDraft {
  const sources = unique(
    fieldsOf({ fields }).flatMap((field) => strings(field.sources))
  );
  return {
    claimType,
    fields,
    issues,
    sources,
    fingerprint: createHash('sha256')
      .update(canonicalJson({ claimType, fields }))
      .digest('hex')
  };
}

// An invalid optional field is set aside on its own and the claim keeps its
// other fields. An invalid or missing required field rejects the whole claim,
// because a claim cannot exist without it.
function mapClaim(claim: ExtractedClaim, availableSources?: ReadonlySet<string>): ClaimMapping {
  const rules = CLAIM_RULES[claim.type];
  const kept = new Map<string, ExtractedField>();
  const values: DraftValues = {};
  const issues: ExtractionReviewIssue[] = [];
  let current = false;

  const rejectClaim = (field: string | null, code: string): ClaimMapping => ({
    draft: null,
    reviewItems: [
      reviewItem(claim.type, claim.fields, [
        ...issues,
        { field, code, required: field !== null && rules.required.includes(field) }
      ])
    ]
  });
  // Returns false when the field is required, so the whole claim is rejected.
  const setFieldAside = (fieldName: string, reason: string): boolean => {
    const field = claim.fields[fieldName];
    if (rules.required.includes(fieldName) || !field) {
      return false;
    }
    issues.push({ field: fieldName, code: reason, required: false });
    kept.delete(fieldName);
    delete values[fieldName];
    return true;
  };

  for (const [fieldName, field] of Object.entries(claim.fields)) {
    if (!sourcesExist(field.sources, availableSources)) {
      if (!setFieldAside(fieldName, 'invalid_source')) {
        return rejectClaim(fieldName, 'invalid_source');
      }
      continue;
    }
    if (rules.dates?.[1] === fieldName && field.current) {
      current = true;
      kept.set(fieldName, field);
      continue;
    }
    if (field.value === undefined) {
      if (field.raw !== undefined && !rules.required.includes(fieldName)) {
        setFieldAside(fieldName, 'missing_value');
      }
      continue;
    }
    const isDate = typeof field.value === 'string' && CLAIM_DATE.test(field.value);
    if (rules.dates?.includes(fieldName) && !isDate) {
      if (!setFieldAside(fieldName, 'invalid_date')) {
        return rejectClaim(fieldName, 'invalid_date');
      }
      continue;
    }
    values[fieldName] = trimmed(field.value);
    kept.set(fieldName, field);
  }

  const missing = rules.required.find((fieldName) => values[fieldName] === undefined);
  if (missing) {
    return rejectClaim(missing, `missing_${toSnakeCase(missing)}`);
  }

  // A year-only end spans through December, while a year-only start begins in
  // January. Reject only a range that cannot be chronologically valid.
  const [start, end] = rules.dates ?? [];
  const startDate = start ? values[start] : undefined;
  const endDate = end ? values[end] : undefined;
  if (
    end &&
    typeof startDate === 'string' &&
    typeof endDate === 'string' &&
    dateUpperBound(endDate) < dateLowerBound(startDate)
  ) {
    setFieldAside(end, 'invalid_date_order');
  }

  const check = rules.validateValues(values);
  if (!check.valid) {
    if (!check.fields.every((fieldName) => setFieldAside(fieldName, 'invalid_value'))) {
      const requiredField = check.fields.find((fieldName) => rules.required.includes(fieldName));
      return rejectClaim(requiredField ?? null, 'invalid_value');
    }
    if (!rules.validateValues(values).valid) {
      return rejectClaim(null, 'invalid_value');
    }
  }

  const keptFields = [...kept];
  const fieldConfidence = Object.fromEntries(
    keptFields.map(([fieldName, field]) => [fieldName, field.confidence])
  );
  const confidence = Math.min(...Object.values(fieldConfidence));
  const rawValues: Record<string, string> = {};
  for (const [fieldName, field] of keptFields) {
    if (field.raw !== undefined) {
      rawValues[fieldName] = field.raw;
    }
  }

  return {
    draft: {
      type: claim.type,
      origin: 'extracted',
      status:
        issues.length === 0 && confidence >= AUTO_ACCEPT_MIN_CONFIDENCE
          ? 'accepted'
          : 'pending',
      confidence,
      fieldConfidence,
      current,
      values,
      rawValues,
      sources: unique(keptFields.flatMap(([, field]) => field.sources)),
      fieldSources: Object.fromEntries(
        keptFields.map(([fieldName, field]) => [fieldName, field.sources])
      )
    },
    reviewItems: issues.length > 0 ? [reviewItem(claim.type, claim.fields, issues)] : []
  };
}

function mapProfile(
  profile: ExtractedProfile,
  unmapped: UnmappedItem[],
  availableSources?: ReadonlySet<string>
): ProfileDraft {
  const draft: ProfileDraft = { values: {}, rawValues: {}, confidence: {}, sources: {} };

  for (const fieldName of PROFILE_TEXT_FIELDS) {
    const field = profile[fieldName];
    if (!field) {
      continue;
    }
    if (!sourcesExist(field.sources, availableSources)) {
      unmapped.push({
        label: `profile.${fieldName}`,
        text: describeField(field),
        sources: field.sources,
        reason: 'invalid_source'
      });
      continue;
    }
    if (field.value === undefined) {
      continue;
    }
    const value = typeof field.value === 'string' ? field.value.trim() : field.value;
    if (typeof value !== 'string' || !PROFILE_VALIDATORS[fieldName](value).valid) {
      unmapped.push({
        label: `profile.${fieldName}`,
        text: describeField(field),
        sources: field.sources,
        reason: 'invalid_value'
      });
      continue;
    }
    draft.values[fieldName] = value;
    draft.sources[fieldName] = field.sources;
    draft.confidence[fieldName] = field.confidence;
    if (field.raw !== undefined) {
      draft.rawValues[fieldName] = field.raw;
    }
  }

  for (const link of profile.links ?? []) {
    if (!sourcesExist(link.sources, availableSources)) {
      unmapped.push({
        label: 'profile.links',
        text: describeField(link),
        sources: link.sources,
        reason: 'invalid_source'
      });
      continue;
    }
    const label = link.raw?.trim();
    const url = typeof link.value === 'string' ? link.value.trim() : '';
    if (!label || !PROFILE_VALIDATORS.profileLink({ label, url }).valid) {
      unmapped.push({
        label: 'profile.links',
        text: describeField(link),
        sources: link.sources,
        reason: label ? 'invalid_value' : 'missing_label'
      });
      continue;
    }
    draft.values.profileLinks = [...(draft.values.profileLinks ?? []), { label, url }];
    draft.sources.profileLinks = unique([...(draft.sources.profileLinks ?? []), ...link.sources]);
    draft.confidence.profileLinks = Math.min(
      draft.confidence.profileLinks ?? link.confidence,
      link.confidence
    );
  }

  return draft;
}

// Turns an AI output into pending claim drafts, a profile draft, and unmapped
// items. Each item is checked on its own, so an invalid item never rejects the
// others; only an unreadable output as a whole is rejected.
export function mapAiOutput(
  output: unknown,
  availableSources?: ReadonlySet<string>
): MappingResult {
  const envelope = validateEnvelope(output);
  if (!envelope.valid || !isRecord(output)) {
    throw new InvalidAiOutputError(
      'AI output does not match the expected contract',
      envelope.errors
    );
  }

  const unmapped: UnmappedItem[] = [];
  const claims: ClaimDraft[] = [];
  const reviewItems: ExtractionReviewItemDraft[] = [];

  let profile: ProfileDraft = { values: {}, rawValues: {}, confidence: {}, sources: {} };
  if (output.profile !== undefined) {
    if (validateProfile(output.profile).valid) {
      profile = mapProfile(output.profile as ExtractedProfile, unmapped, availableSources);
    } else {
      unmapped.push(describeInvalid('profile', output.profile, 'invalid_item'));
    }
  }

  for (const item of output.claims as unknown[]) {
    const validation = validateClaim(item);
    if (!validation.valid) {
      const label = isRecord(item) && typeof item.type === 'string' ? item.type : 'unknown';
      const recognizedType = CLAIM_TYPES.find((claimType) => claimType === label);
      if (recognizedType && isRecord(item) && isRecord(item.fields)) {
        reviewItems.push(
          reviewItem(recognizedType, item.fields, [
            { field: null, code: 'invalid_item', required: false }
          ])
        );
      } else {
        unmapped.push(describeInvalid(label, item, 'invalid_item'));
      }
      continue;
    }
    for (const separated of separateCombinedClaimValues(item as ExtractedClaim)) {
      const { draft, reviewItems: claimReviewItems } = mapClaim(
        separated,
        availableSources
      );
      if (draft) {
        claims.push(draft);
      }
      reviewItems.push(...claimReviewItems);
    }
  }

  for (const item of (output.unmapped ?? []) as unknown[]) {
    if (validateUnmapped(item).valid) {
      const { label, text, sources } = item as ExtractedUnmapped;
      unmapped.push({
        label,
        text,
        sources,
        reason: sourcesExist(sources, availableSources) ? 'unsupported_section' : 'invalid_source'
      });
    } else {
      unmapped.push(describeInvalid('unmapped', item, 'invalid_item'));
    }
  }

  return { version: AI_OUTPUT_VERSION, profile, claims, reviewItems, unmapped };
}
