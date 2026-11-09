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

// A claim ready to be saved as extracted and pending review. Its values use
// the same shape as manual claims.
export interface ClaimDraft {
  type: ClaimType;
  origin: 'extracted';
  status: 'pending';
  confidence: number;
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

export interface MappingResult {
  version: number;
  profile: ProfileDraft;
  claims: ClaimDraft[];
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

// Year and month only, as manual claims require. A year alone is not enough,
// and no month is invented.
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

function toSnakeCase(fieldName: string): string {
  return fieldName.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
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

function unmappedClaim(claim: ExtractedClaim, reason: string): UnmappedItem {
  const fields = Object.values(claim.fields);
  return {
    label: claim.type,
    text: fields.map(describeField).filter(Boolean).join('; '),
    sources: unique(fields.flatMap((field) => field.sources)),
    reason
  };
}

function trimmed(value: string | string[]): string | string[] {
  return typeof value === 'string' ? value.trim() : value.map((item) => item.trim());
}

function mapClaim(claim: ExtractedClaim): ClaimDraft | UnmappedItem {
  const rules = CLAIM_RULES[claim.type];
  const values: DraftValues = {};
  const rawValues: Record<string, string> = {};
  const fieldSources: Record<string, string[]> = {};
  let current = false;

  for (const [fieldName, field] of Object.entries(claim.fields)) {
    fieldSources[fieldName] = field.sources;
    if (field.raw !== undefined) {
      rawValues[fieldName] = field.raw;
    }
    const isEndDate = rules.dates?.[1] === fieldName;
    if (isEndDate && field.current) {
      current = true;
      continue;
    }
    if (field.value === undefined) {
      continue;
    }
    const isMonth = typeof field.value === 'string' && MONTH.test(field.value);
    if (rules.dates?.includes(fieldName) && !isMonth) {
      return unmappedClaim(claim, 'invalid_date');
    }
    values[fieldName] = trimmed(field.value);
  }

  const missing = rules.required.find((fieldName) => values[fieldName] === undefined);
  if (missing) {
    return unmappedClaim(claim, `missing_${toSnakeCase(missing)}`);
  }

  // YYYY-MM strings sort chronologically.
  const [start, end] = rules.dates ?? [];
  const startDate = start ? values[start] : undefined;
  const endDate = end ? values[end] : undefined;
  if (typeof startDate === 'string' && typeof endDate === 'string' && endDate < startDate) {
    return unmappedClaim(claim, 'invalid_date_order');
  }

  if (!rules.validateValues(values).valid) {
    return unmappedClaim(claim, 'invalid_value');
  }

  return {
    type: claim.type,
    origin: 'extracted',
    status: 'pending',
    confidence: claim.confidence,
    current,
    values,
    rawValues,
    sources: unique(Object.values(claim.fields).flatMap((field) => field.sources)),
    fieldSources
  };
}

function mapProfile(profile: ExtractedProfile, unmapped: UnmappedItem[]): ProfileDraft {
  const draft: ProfileDraft = { values: {}, rawValues: {}, sources: {} };

  for (const fieldName of PROFILE_TEXT_FIELDS) {
    const field = profile[fieldName];
    if (!field || field.value === undefined) {
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
    if (field.raw !== undefined) {
      draft.rawValues[fieldName] = field.raw;
    }
  }

  for (const link of profile.links ?? []) {
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
  }

  return draft;
}

function isClaimDraft(result: ClaimDraft | UnmappedItem): result is ClaimDraft {
  return 'origin' in result;
}

// Turns an AI output into pending claim drafts, a profile draft, and unmapped
// items. Each item is checked on its own, so an invalid item never rejects the
// others; only an unreadable output as a whole is rejected.
export function mapAiOutput(output: unknown): MappingResult {
  const envelope = validateEnvelope(output);
  if (!envelope.valid || !isRecord(output)) {
    throw new InvalidAiOutputError(
      'AI output does not match the expected contract',
      envelope.errors
    );
  }

  const unmapped: UnmappedItem[] = [];
  const claims: ClaimDraft[] = [];

  let profile: ProfileDraft = { values: {}, rawValues: {}, sources: {} };
  if (output.profile !== undefined) {
    if (validateProfile(output.profile).valid) {
      profile = mapProfile(output.profile as ExtractedProfile, unmapped);
    } else {
      unmapped.push(describeInvalid('profile', output.profile, 'invalid_item'));
    }
  }

  for (const item of output.claims as unknown[]) {
    if (!validateClaim(item).valid) {
      const label = isRecord(item) && typeof item.type === 'string' ? item.type : 'unknown';
      unmapped.push(describeInvalid(label, item, 'invalid_item'));
      continue;
    }
    const result = mapClaim(item as ExtractedClaim);
    if (isClaimDraft(result)) {
      claims.push(result);
    } else {
      unmapped.push(result);
    }
  }

  for (const item of (output.unmapped ?? []) as unknown[]) {
    if (validateUnmapped(item).valid) {
      const { label, text, sources } = item as ExtractedUnmapped;
      unmapped.push({ label, text, sources, reason: 'unsupported_section' });
    } else {
      unmapped.push(describeInvalid('unmapped', item, 'invalid_item'));
    }
  }

  return { version: AI_OUTPUT_VERSION, profile, claims, unmapped };
}
