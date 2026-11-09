import { Ajv, ErrorObject } from 'ajv';
import addFormats from 'ajv-formats';
import {
  aiOutputEnvelopeSchema,
  extractedClaimSchema,
  extractedProfileSchema,
  extractedUnmappedSchema
} from './extraction.schemas.js';

// AI output is checked outside HTTP routes, so it has its own Ajv instance.
// Unlike Fastify's route validation, it never removes or coerces values: what
// the AI returned is checked as it is.
const ajv = new Ajv({ allErrors: true });
addFormats.default(ajv);

export interface ValidationResult {
  valid: boolean;
  // Short messages such as "/fields/startDate/sources must NOT have fewer than 1 items".
  errors: string[];
}

function describeErrors(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map(
    (error) => `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`
  );
}

// Compiles a schema once and returns a function that checks values against it.
export function validatorFor(schema: object): (value: unknown) => ValidationResult {
  const validate = ajv.compile(schema);
  return (value) => {
    const valid = validate(value);
    return { valid, errors: valid ? [] : describeErrors(validate.errors) };
  };
}

export const validateEnvelope = validatorFor(aiOutputEnvelopeSchema);
export const validateClaim = validatorFor(extractedClaimSchema);
export const validateProfile = validatorFor(extractedProfileSchema);
export const validateUnmapped = validatorFor(extractedUnmappedSchema);
