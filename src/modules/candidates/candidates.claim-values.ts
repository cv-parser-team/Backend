import { Ajv, type ErrorObject } from 'ajv';
import addFormats from 'ajv-formats';
import { InvalidClaimDatesError, InvalidClaimValuesError } from './candidates.errors.js';
import type { ClaimValues } from './candidates.repository.js';
import {
  certificationValuesSchema,
  educationValuesSchema,
  employmentValuesSchema,
  languageValuesSchema,
  projectValuesSchema,
  skillValuesSchema,
  type ClaimBody
} from './candidates.schemas.js';

const ajv = new Ajv({ allErrors: true });
addFormats.default(ajv);

const validators = {
  skill: ajv.compile(skillValuesSchema),
  employment: ajv.compile(employmentValuesSchema),
  education: ajv.compile(educationValuesSchema),
  certification: ajv.compile(certificationValuesSchema),
  language: ajv.compile(languageValuesSchema),
  project: ajv.compile(projectValuesSchema)
};

function validationDetails(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map(
    (error) => `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`
  );
}

function normalizeClaimValues(values: ClaimBody['values']): ClaimValues {
  const normalized: ClaimValues = {};

  for (const [fieldName, value] of Object.entries(values)) {
    if (typeof value === 'string') {
      normalized[fieldName] = value.trim();
    } else if (Array.isArray(value) && value.length > 0) {
      normalized[fieldName] = [...new Set(value.map((item) => item.trim()))];
    }
  }

  return normalized;
}

// A year-only start begins in January and a year-only end extends through
// December. This rejects only ranges that cannot overlap without inventing a
// month, such as start 2024 and end 2023.
function dateLowerBound(value: string): string {
  return value.length === 4 ? `${value}-01` : value;
}

function dateUpperBound(value: string): string {
  return value.length === 4 ? `${value}-12` : value;
}

function dateRangeIsReversed(start: string, end: string): boolean {
  return dateUpperBound(end) < dateLowerBound(start);
}

function assertValidClaimDates(input: ClaimBody): void {
  switch (input.type) {
    case 'employment':
    case 'education':
      if (
        input.values.endDate &&
        dateRangeIsReversed(input.values.startDate, input.values.endDate)
      ) {
        throw new InvalidClaimDatesError('End date cannot be before start date');
      }
      break;
    case 'certification':
      if (
        input.values.expiryDate &&
        dateRangeIsReversed(input.values.issueDate, input.values.expiryDate)
      ) {
        throw new InvalidClaimDatesError('Expiry date cannot be before issue date');
      }
      break;
    case 'project':
      if (
        input.values.startDate &&
        input.values.endDate &&
        dateRangeIsReversed(input.values.startDate, input.values.endDate)
      ) {
        throw new InvalidClaimDatesError('End date cannot be before start date');
      }
      break;
    case 'skill':
    case 'language':
      break;
  }
}

export function prepareClaimValues(input: ClaimBody): ClaimValues {
  assertValidClaimDates(input);
  return normalizeClaimValues(input.values);
}

export function prepareUnknownClaimValues(
  type: ClaimBody['type'],
  values: unknown
): ClaimValues {
  const validate = validators[type];
  if (!validate(values)) {
    throw new InvalidClaimValuesError(validationDetails(validate.errors));
  }

  // The type-specific validator above proves the same contract represented by
  // ClaimBody. Keeping the discriminator server-side prevents type changes.
  return prepareClaimValues({ type, values } as ClaimBody);
}
