import type {
  ClaimValues,
  CreateClaimInput
} from './candidates.repository.js';

type ClaimType = CreateClaimInput['claimType'];

export interface ComparableClaim {
  candidateId: string;
  claimType: ClaimType;
  values: ClaimValues;
  current?: boolean;
  currentAsOf?: string;
}

export type ClaimComparisonResult =
  | {
      result: 'not_comparable';
      reason: 'different_candidate' | 'different_type';
    }
  | { result: 'equivalent' }
  | { result: 'different' };

export type ClaimIdentityComparisonResult =
  | {
      result: 'not_comparable';
      reason: 'different_candidate' | 'different_type';
    }
  | { result: 'equivalent' }
  | { result: 'suspected_duplicate' }
  | { result: 'different' }
  | { result: 'unsupported_type' };

export type ComparableClaimDate =
  | { kind: 'date'; value: string }
  | { kind: 'present'; asOf?: string }
  | { kind: 'missing' };

export type ClaimDateComparisonResult =
  | 'same'
  | 'precision_improvement'
  | 'compatible'
  | 'conflict'
  | 'missing'
  | 'uncertain'
  | 'invalid';

export type ClaimDateFieldDifference =
  | { kind: 'same' }
  | {
      kind: 'enrichment';
      value: ComparableClaimDate;
      from: 'left' | 'right';
    }
  | {
      kind: 'precision_improvement';
      value: ComparableClaimDate;
      from: 'left' | 'right';
    }
  | {
      kind: 'compatible' | 'warning' | 'conflict';
      left: ComparableClaimDate;
      right: ComparableClaimDate;
    };

type ComparableFieldValue = ClaimValues[string];

export type ClaimFieldDifference =
  | { kind: 'same'; value?: ComparableFieldValue }
  | {
      kind: 'enrichment';
      value: ComparableFieldValue;
      from: 'left' | 'right' | 'both';
    }
  | {
      kind: 'conflict';
      left: ComparableFieldValue;
      right: ComparableFieldValue;
    };

export type ClaimFieldsComparisonResult =
  | {
      result: 'not_comparable';
      reason: 'different_candidate' | 'different_type';
    }
  | {
      result: 'compared';
      fields: Record<
        string,
        ClaimFieldDifference | ClaimDateFieldDifference
      >;
    };

type ClaimDateFieldName =
  | 'startDate'
  | 'endDate'
  | 'issueDate'
  | 'expiryDate';

const CLAIM_DATE_FIELDS = new Set<ClaimDateFieldName>([
  'startDate',
  'endDate',
  'issueDate',
  'expiryDate'
]);

interface ParsedClaimDate {
  year: number;
  month: number | null;
}

function normalizeComparisonText(value: string): string {
  return value
    .normalize('NFKC')
    .trim()
    .replace(/\s+/gu, ' ')
    .toLowerCase();
}

function normalizeList(values: string[]): string[] {
  return [...new Set(values.map(normalizeComparisonText))].sort();
}

function mergeLists(left: string[], right: string[]): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const value of [...left, ...right]) {
    const normalized = normalizeComparisonText(value);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      merged.push(value);
    }
  }
  return merged;
}

export function compareClaimFieldValues(
  left: ComparableFieldValue | undefined,
  right: ComparableFieldValue | undefined
): ClaimFieldDifference {
  if (left === undefined) {
    if (right === undefined) {
      return { kind: 'same' };
    }
    return { kind: 'enrichment', value: right, from: 'right' };
  }
  if (right === undefined) {
    return { kind: 'enrichment', value: left, from: 'left' };
  }
  if (typeof left === 'string' && typeof right === 'string') {
    return normalizeComparisonText(left) === normalizeComparisonText(right)
      ? { kind: 'same', value: left }
      : { kind: 'conflict', left, right };
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return JSON.stringify(normalizeList(left)) === JSON.stringify(normalizeList(right))
      ? { kind: 'same', value: left }
      : { kind: 'enrichment', value: mergeLists(left, right), from: 'both' };
  }
  return { kind: 'conflict', left, right };
}

function parseClaimDate(value: string): ParsedClaimDate | null {
  const match = /^(\d{4})(?:-(0[1-9]|1[0-2]))?$/u.exec(value);
  if (!match) {
    return null;
  }
  return {
    year: Number(match[1]),
    month: match[2] === undefined ? null : Number(match[2])
  };
}

function lowerMonth(date: ParsedClaimDate): number {
  return date.year * 12 + (date.month ?? 1);
}

function upperMonth(date: ParsedClaimDate): number {
  return date.year * 12 + (date.month ?? 12);
}

export function compareClaimDates(
  left: ComparableClaimDate,
  right: ComparableClaimDate
): ClaimDateComparisonResult {
  if (left.kind === 'missing' || right.kind === 'missing') {
    return 'missing';
  }
  if (left.kind === 'present' && right.kind === 'present') {
    return 'same';
  }
  if (left.kind === 'date' && right.kind === 'date') {
    const leftDate = parseClaimDate(left.value);
    const rightDate = parseClaimDate(right.value);
    if (!leftDate || !rightDate) {
      return 'invalid';
    }
    if (leftDate.year !== rightDate.year) {
      return 'conflict';
    }
    if (leftDate.month === rightDate.month) {
      return 'same';
    }
    return leftDate.month === null || rightDate.month === null
      ? 'precision_improvement'
      : 'conflict';
  }

  const present = left.kind === 'present' ? left : right;
  const explicit = left.kind === 'date' ? left : right;
  if (present.kind !== 'present' || explicit.kind !== 'date') {
    return 'invalid';
  }
  if (present.asOf === undefined) {
    return 'uncertain';
  }

  const asOfDate = parseClaimDate(present.asOf);
  const explicitDate = parseClaimDate(explicit.value);
  if (!asOfDate || !explicitDate) {
    return 'invalid';
  }

  // "Present" means the claim continued through its reliable source date.
  // An explicit end is compatible when it could be on or after that date.
  return upperMonth(explicitDate) < lowerMonth(asOfDate)
    ? 'conflict'
    : 'compatible';
}

export function compareClaimDateFieldValues(
  left: ComparableClaimDate,
  right: ComparableClaimDate
): ClaimDateFieldDifference {
  if (left.kind === 'missing' && right.kind === 'missing') {
    return { kind: 'same' };
  }
  if (left.kind === 'missing') {
    return { kind: 'enrichment', value: right, from: 'right' };
  }
  if (right.kind === 'missing') {
    return { kind: 'enrichment', value: left, from: 'left' };
  }

  const comparison = compareClaimDates(left, right);
  if (comparison === 'same') {
    return { kind: 'same' };
  }
  if (
    comparison === 'precision_improvement' &&
    left.kind === 'date' &&
    right.kind === 'date'
  ) {
    return left.value.length > right.value.length
      ? { kind: 'precision_improvement', value: left, from: 'left' }
      : { kind: 'precision_improvement', value: right, from: 'right' };
  }
  if (comparison === 'compatible') {
    return { kind: 'compatible', left, right };
  }
  if (comparison === 'uncertain') {
    return { kind: 'warning', left, right };
  }
  return { kind: 'conflict', left, right };
}

function requiredTextFieldsMatch(
  left: ClaimValues,
  right: ClaimValues,
  fields: string[]
): boolean {
  return fields.every((field) => {
    const leftValue = left[field];
    const rightValue = right[field];
    if (typeof leftValue !== 'string' || typeof rightValue !== 'string') {
      return false;
    }
    const normalizedLeftValue = normalizeComparisonText(leftValue);
    return (
      normalizedLeftValue.length > 0 &&
      normalizedLeftValue === normalizeComparisonText(rightValue)
    );
  });
}

function dateValue(
  values: ClaimValues,
  field: ClaimDateFieldName
): ComparableClaimDate {
  const value = values[field];
  return typeof value === 'string'
    ? { kind: 'date', value }
    : { kind: 'missing' };
}

function isClaimDateField(field: string): field is ClaimDateFieldName {
  return CLAIM_DATE_FIELDS.has(field as ClaimDateFieldName);
}

function endDateValue(claim: ComparableClaim): ComparableClaimDate | null {
  const endDate = claim.values.endDate;
  if (claim.current === true && typeof endDate === 'string') {
    return null;
  }
  if (claim.current === true) {
    return { kind: 'present', asOf: claim.currentAsOf };
  }
  return typeof endDate === 'string'
    ? { kind: 'date', value: endDate }
    : { kind: 'missing' };
}

function compareDatedIdentity(
  left: ComparableClaim,
  right: ComparableClaim
): Extract<ClaimIdentityComparisonResult, { result: 'equivalent' | 'suspected_duplicate' }> {
  const startComparison = compareClaimDates(
    dateValue(left.values, 'startDate'),
    dateValue(right.values, 'startDate')
  );
  if (startComparison !== 'same' && startComparison !== 'precision_improvement') {
    return { result: 'suspected_duplicate' };
  }

  const leftEndDate = endDateValue(left);
  const rightEndDate = endDateValue(right);
  if (!leftEndDate || !rightEndDate) {
    return { result: 'suspected_duplicate' };
  }
  const endComparison = compareClaimDates(leftEndDate, rightEndDate);
  return endComparison === 'conflict' ||
    endComparison === 'uncertain' ||
    endComparison === 'invalid'
    ? { result: 'suspected_duplicate' }
    : { result: 'equivalent' };
}

export function compareClaimFields(
  left: ComparableClaim,
  right: ComparableClaim
): ClaimFieldsComparisonResult {
  if (left.candidateId !== right.candidateId) {
    return { result: 'not_comparable', reason: 'different_candidate' };
  }
  if (left.claimType !== right.claimType) {
    return { result: 'not_comparable', reason: 'different_type' };
  }

  const fieldNames = new Set([
    ...Object.keys(left.values),
    ...Object.keys(right.values)
  ]);
  if (left.current === true || right.current === true) {
    fieldNames.add('endDate');
  }

  const fields: Record<
    string,
    ClaimFieldDifference | ClaimDateFieldDifference
  > = {};
  for (const field of [...fieldNames].sort()) {
    if (!isClaimDateField(field)) {
      fields[field] = compareClaimFieldValues(
        left.values[field],
        right.values[field]
      );
      continue;
    }

    if (field === 'endDate') {
      const leftEndDate = endDateValue(left);
      const rightEndDate = endDateValue(right);
      if (!leftEndDate || !rightEndDate) {
        fields[field] = {
          kind: 'conflict',
          left: leftEndDate ?? dateValue(left.values, field),
          right: rightEndDate ?? dateValue(right.values, field)
        };
      } else {
        fields[field] = compareClaimDateFieldValues(leftEndDate, rightEndDate);
      }
      continue;
    }

    fields[field] = compareClaimDateFieldValues(
      dateValue(left.values, field),
      dateValue(right.values, field)
    );
  }

  return { result: 'compared', fields };
}

export function strictClaimComparisonKey(
  claimType: ClaimType,
  values: ClaimValues
): string {
  const normalizedValues = Object.entries(values)
    .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
    .map(([key, value]) => [
      key,
      Array.isArray(value) ? normalizeList(value) : normalizeComparisonText(value)
    ]);

  return JSON.stringify([claimType, normalizedValues]);
}

export function compareClaims(
  left: ComparableClaim,
  right: ComparableClaim
): ClaimComparisonResult {
  if (left.candidateId !== right.candidateId) {
    return { result: 'not_comparable', reason: 'different_candidate' };
  }
  if (left.claimType !== right.claimType) {
    return { result: 'not_comparable', reason: 'different_type' };
  }

  return strictClaimComparisonKey(left.claimType, left.values) ===
    strictClaimComparisonKey(right.claimType, right.values)
    ? { result: 'equivalent' }
    : { result: 'different' };
}

export function compareClaimIdentity(
  left: ComparableClaim,
  right: ComparableClaim
): ClaimIdentityComparisonResult {
  if (left.candidateId !== right.candidateId) {
    return { result: 'not_comparable', reason: 'different_candidate' };
  }
  if (left.claimType !== right.claimType) {
    return { result: 'not_comparable', reason: 'different_type' };
  }

  if (left.claimType === 'employment') {
    if (!requiredTextFieldsMatch(left.values, right.values, ['employer', 'jobTitle'])) {
      return { result: 'different' };
    }
    return compareDatedIdentity(left, right);
  }

  if (left.claimType === 'education') {
    if (!requiredTextFieldsMatch(left.values, right.values, ['institution', 'degree'])) {
      return { result: 'different' };
    }

    const leftField = left.values.fieldOfStudy;
    const rightField = right.values.fieldOfStudy;
    if (
      typeof leftField === 'string' &&
      typeof rightField === 'string' &&
      normalizeComparisonText(leftField) !== normalizeComparisonText(rightField)
    ) {
      return { result: 'suspected_duplicate' };
    }
    return compareDatedIdentity(left, right);
  }

  if (left.claimType === 'project') {
    if (!requiredTextFieldsMatch(left.values, right.values, ['name'])) {
      return { result: 'different' };
    }

    const leftUrl = left.values.url;
    const rightUrl = right.values.url;
    if (typeof leftUrl === 'string' && typeof rightUrl === 'string') {
      const normalizedLeftUrl = leftUrl.trim();
      return normalizedLeftUrl.length > 0 && normalizedLeftUrl === rightUrl.trim()
        ? { result: 'equivalent' }
        : { result: 'suspected_duplicate' };
    }

    return compareDatedIdentity(left, right);
  }

  const identityFields =
    left.claimType === 'skill' || left.claimType === 'language'
      ? ['name']
      : left.claimType === 'certification'
        ? ['title', 'issuer']
        : null;
  if (!identityFields) {
    return { result: 'unsupported_type' };
  }

  for (const field of identityFields) {
    const leftValue = left.values[field];
    const rightValue = right.values[field];
    if (typeof leftValue !== 'string' || typeof rightValue !== 'string') {
      return { result: 'different' };
    }
    const normalizedLeftValue = normalizeComparisonText(leftValue);
    if (
      normalizedLeftValue.length === 0 ||
      normalizedLeftValue !== normalizeComparisonText(rightValue)
    ) {
      return { result: 'different' };
    }
  }

  return { result: 'equivalent' };
}
