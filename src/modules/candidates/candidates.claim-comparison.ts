import type {
  ClaimRecord,
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

export interface MergeCandidateClaim extends ComparableClaim {
  claimId: string;
  version: number;
  origin: CreateClaimInput['origin'];
  status: Extract<CreateClaimInput['status'], 'pending' | 'accepted'>;
  candidateEdited: boolean;
  createdAt: Date;
}

export type ClaimSurvivorSelection =
  | {
      result: 'not_comparable';
      reason: 'different_candidate' | 'different_type';
    }
  | {
      result: 'selected';
      survivor: 'left' | 'right';
      reason:
        | 'candidate_authority'
        | 'accepted_status'
        | 'oldest_pending'
        | 'claim_id_tiebreaker';
    }
  | { result: 'candidate_choice_required' };

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
      fields: Record<string, ClaimFieldComparison>;
    };

export type ClaimFieldComparison =
  | ClaimFieldDifference
  | ClaimDateFieldDifference;

type ClaimSurvivorReason = Extract<
  ClaimSurvivorSelection,
  { result: 'selected' }
>['reason'];

export type ClaimMergeProposalResult =
  | {
      result: 'no_proposal';
      reason:
        | 'different_candidate'
        | 'different_type'
        | 'different_identity'
        | 'unsupported_type'
        | 'same_claim'
        | 'rejected_claim'
        | 'superseded_claim';
    }
  | {
      result: 'proposal';
      identity: 'equivalent' | 'suspected_duplicate';
      left: { claimId: string; version: number };
      right: { claimId: string; version: number };
      survivorClaimId: string | null;
      survivorReason: ClaimSurvivorReason | null;
      fields: Record<string, ClaimFieldComparison>;
      proposedValues: ClaimValues;
      proposedCurrent?: boolean | null;
      unresolvedFields: string[];
      requiresCandidateChoice: boolean;
      recommendedAction: 'automatic_coalesce' | 'candidate_review';
    };

type NoMergeProposalReason = Extract<
  ClaimMergeProposalResult,
  { result: 'no_proposal' }
>['reason'];

export type AutomaticCoalescePlanResult =
  | {
      result: 'no_merge';
      reason: NoMergeProposalReason | 'same_claim';
    }
  | { result: 'candidate_review_required' }
  | {
      result: 'ready';
      survivor: { claimId: string; expectedVersion: number };
      duplicate: { claimId: string; expectedVersion: number };
      values: ClaimValues;
      current?: boolean;
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

const CLAIM_TYPES_WITH_CURRENT = new Set<ClaimType>([
  'employment',
  'education',
  'project'
]);

export function toMergeCandidateClaim(
  candidateId: string,
  claim: ClaimRecord
): MergeCandidateClaim | null {
  if (claim.status === 'rejected') {
    return null;
  }
  return {
    candidateId,
    claimId: claim.claimId,
    version: claim.version,
    claimType: claim.claimType,
    values: claim.values,
    current: claim.current,
    origin: claim.origin,
    status: claim.status,
    candidateEdited: claim.candidateEdited,
    createdAt: claim.createdAt
  };
}

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

  const fields: Record<string, ClaimFieldComparison> = {};
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

function isCandidateAuthoritative(claim: MergeCandidateClaim): boolean {
  return claim.origin === 'manual' || claim.candidateEdited;
}

function claimAuthority(claim: MergeCandidateClaim): number {
  if (isCandidateAuthoritative(claim)) {
    return 2;
  }
  return claim.status === 'accepted' ? 1 : 0;
}

export function selectClaimSurvivor(
  left: MergeCandidateClaim,
  right: MergeCandidateClaim
): ClaimSurvivorSelection {
  if (left.candidateId !== right.candidateId) {
    return { result: 'not_comparable', reason: 'different_candidate' };
  }
  if (left.claimType !== right.claimType) {
    return { result: 'not_comparable', reason: 'different_type' };
  }

  const leftAuthoritative = isCandidateAuthoritative(left);
  const rightAuthoritative = isCandidateAuthoritative(right);
  if (leftAuthoritative !== rightAuthoritative) {
    return {
      result: 'selected',
      survivor: leftAuthoritative ? 'left' : 'right',
      reason: 'candidate_authority'
    };
  }

  if (left.status !== right.status) {
    return {
      result: 'selected',
      survivor: left.status === 'accepted' ? 'left' : 'right',
      reason: 'accepted_status'
    };
  }

  if (left.status === 'accepted') {
    return { result: 'candidate_choice_required' };
  }

  const createdDifference = left.createdAt.getTime() - right.createdAt.getTime();
  if (createdDifference !== 0) {
    return {
      result: 'selected',
      survivor: createdDifference < 0 ? 'left' : 'right',
      reason: 'oldest_pending'
    };
  }
  return {
    result: 'selected',
    survivor: left.claimId.localeCompare(right.claimId) <= 0 ? 'left' : 'right',
    reason: 'claim_id_tiebreaker'
  };
}

function proposedValue(
  value: ComparableFieldValue | ComparableClaimDate
): ComparableFieldValue | undefined {
  if (typeof value === 'string' || Array.isArray(value)) {
    return value;
  }
  return value.kind === 'date' ? value.value : undefined;
}

function buildProposedValues(
  left: MergeCandidateClaim,
  right: MergeCandidateClaim,
  fields: Record<string, ClaimFieldComparison>,
  survivor: Exclude<ClaimSurvivorSelection, { result: 'not_comparable' }>
): ClaimValues {
  const leftAuthority = claimAuthority(left);
  const rightAuthority = claimAuthority(right);
  const preferred =
    leftAuthority !== rightAuthority
      ? leftAuthority > rightAuthority
        ? left
        : right
      : survivor.result === 'selected' && survivor.survivor === 'right'
        ? right
        : left;
  const fallback = preferred === left ? right : left;
  const values: ClaimValues = {};

  for (const [field, difference] of Object.entries(fields)) {
    if (difference.kind === 'same') {
      const value = preferred.values[field] ?? fallback.values[field];
      if (value !== undefined) {
        values[field] = value;
      }
      continue;
    }
    if (
      difference.kind !== 'enrichment' &&
      difference.kind !== 'precision_improvement'
    ) {
      continue;
    }

    const value = proposedValue(difference.value);
    if (value !== undefined) {
      values[field] = value;
    }
  }

  return values;
}

function buildProposedCurrent(
  left: MergeCandidateClaim,
  right: MergeCandidateClaim,
  fields: Record<string, ClaimFieldComparison>
): boolean | null | undefined {
  if (!CLAIM_TYPES_WITH_CURRENT.has(left.claimType)) {
    return undefined;
  }

  const endDate = fields.endDate;
  if (endDate === undefined) {
    return false;
  }
  if (endDate.kind === 'same') {
    return left.current === true && right.current === true;
  }
  if (!('value' in endDate)) {
    return null;
  }

  const value = endDate.value;
  return typeof value === 'object' && !Array.isArray(value)
    ? value.kind === 'present'
    : false;
}

export function buildClaimMergeProposal(
  left: MergeCandidateClaim,
  right: MergeCandidateClaim
): ClaimMergeProposalResult {
  const identity = compareClaimIdentity(left, right);
  if (identity.result === 'not_comparable') {
    return { result: 'no_proposal', reason: identity.reason };
  }
  if (identity.result === 'different') {
    return { result: 'no_proposal', reason: 'different_identity' };
  }
  if (identity.result === 'unsupported_type') {
    return { result: 'no_proposal', reason: 'unsupported_type' };
  }

  const fieldComparison = compareClaimFields(left, right);
  const survivor = selectClaimSurvivor(left, right);
  if (fieldComparison.result === 'not_comparable') {
    return {
      result: 'no_proposal',
      reason: fieldComparison.reason
    };
  }
  if (survivor.result === 'not_comparable') {
    return { result: 'no_proposal', reason: survivor.reason };
  }

  const unresolvedFields = Object.entries(fieldComparison.fields)
    .filter(([, difference]) =>
      difference.kind === 'conflict' ||
      difference.kind === 'warning' ||
      difference.kind === 'compatible'
    )
    .map(([field]) => field);
  const requiresSurvivorChoice = survivor.result === 'candidate_choice_required';
  const proposedCurrent = buildProposedCurrent(
    left,
    right,
    fieldComparison.fields
  );
  const canAutomaticallyCoalesce =
    left.origin === 'extracted' &&
    right.origin === 'extracted' &&
    left.status === 'pending' &&
    right.status === 'pending' &&
    !left.candidateEdited &&
    !right.candidateEdited &&
    identity.result === 'equivalent' &&
    !requiresSurvivorChoice &&
    proposedCurrent !== null &&
    unresolvedFields.length === 0;

  return {
    result: 'proposal',
    identity: identity.result,
    left: { claimId: left.claimId, version: left.version },
    right: { claimId: right.claimId, version: right.version },
    survivorClaimId:
      survivor.result === 'selected'
        ? survivor.survivor === 'left'
          ? left.claimId
          : right.claimId
        : null,
    survivorReason:
      survivor.result === 'selected' ? survivor.reason : null,
    fields: fieldComparison.fields,
    proposedValues: buildProposedValues(
      left,
      right,
      fieldComparison.fields,
      survivor
    ),
    ...(proposedCurrent !== undefined ? { proposedCurrent } : {}),
    unresolvedFields,
    requiresCandidateChoice:
      requiresSurvivorChoice || unresolvedFields.length > 0,
    recommendedAction: canAutomaticallyCoalesce
      ? 'automatic_coalesce'
      : 'candidate_review'
  };
}

export function buildAutomaticCoalescePlan(
  left: MergeCandidateClaim,
  right: MergeCandidateClaim
): AutomaticCoalescePlanResult {
  if (left.claimId === right.claimId) {
    return { result: 'no_merge', reason: 'same_claim' };
  }

  const proposal = buildClaimMergeProposal(left, right);
  if (proposal.result === 'no_proposal') {
    return { result: 'no_merge', reason: proposal.reason };
  }
  if (
    proposal.recommendedAction !== 'automatic_coalesce' ||
    proposal.survivorClaimId === null
  ) {
    return { result: 'candidate_review_required' };
  }

  const survivorIsLeft = proposal.survivorClaimId === left.claimId;
  const survivor = survivorIsLeft ? left : right;
  const duplicate = survivorIsLeft ? right : left;
  return {
    result: 'ready',
    survivor: {
      claimId: survivor.claimId,
      expectedVersion: survivor.version
    },
    duplicate: {
      claimId: duplicate.claimId,
      expectedVersion: duplicate.version
    },
    values: proposal.proposedValues,
    ...(typeof proposal.proposedCurrent === 'boolean'
      ? { current: proposal.proposedCurrent }
      : {})
  };
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
