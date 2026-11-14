import type { LlmService } from '../../infrastructure/llm/llm.service.js';
import {
  collectAiInputReferences,
  mapAiOutput,
  type MappingResult
} from './extraction.mapper.js';
import {
  AI_OUTPUT_VERSION,
  aiGenerationSchema
} from './extraction.schemas.js';

export const EXTRACTION_PROMPT_VERSION = 'candidate-extraction-v4';

export const EXTRACTION_PROMPT = `Extract candidate information from the supplied CV text.
Use only explicitly stated information and never infer missing values or source references.

Return one JSON object with this shape:
{
  "version": ${AI_OUTPUT_VERSION},
  "profile": { "fieldName": extractedField, "links": [extractedField] },
  "claims": [{ "type": "claimType", "fields": { "fieldName": extractedField } }],
  "unmapped": [{ "label": "section name", "text": "original text", "sources": ["L1"] }]
}

An extractedField has a nonempty value string or string array, confidence from 0 to 1, and one or more exact source references copied from the input. Every source must directly support that field. Valid references include L5, L5-7, L39-41,44, B3, and B4.1; page and region headers are not references. Keep the original wording in raw when the value is normalized, especially dates.

Profile fields: fullName, headline, summary, phone, location, contactEmail, and links.
Claim fields by type:
- skill: name
- employment: employer, jobTitle, and startDate are required; endDate, location, description, and skills are optional
- education: institution, degree, and startDate are required; fieldOfStudy and endDate are optional
- certification: title, issuer, and issueDate are required; expiryDate and credentialId are optional
- language: name, proficiency
- project: name is required; description, role, url, startDate, endDate, and skills are optional

For a profile link, value is its URL and raw is its visible label; both are required. Dates use YYYY when only a year is stated and YYYY-MM when a month is stated; never invent a month. Split ranges into distinct fields: "2037-2040" becomes startDate value "2037" and endDate value "2040", both with raw "2037-2040"; "2037-Present" becomes startDate value "2037" and endDate current true with raw "Present"; a lone "2037" remains value "2037"; "March 2037-2040" becomes startDate value "2037-03" and endDate value "2040". Never copy a complete range into either date value. Apply the same precision rules to education, project, issueDate, and expiryDate. An explicitly current end date omits value and instead has current true and its original wording in raw. When text clearly belongs to a supported claim type, emit the claim with every explicitly known field even if a required field is absent or one value cannot be normalized; the application will retain it for user review. Put awards, courses, unknown claim types, and genuinely unsupported sections in unmapped with their original text and sources. Consolidate clearly identical claims and combine their source references. Do not emit null, empty values, unknown fields, or unsupported claim types. Return JSON only.`;

export interface CandidateExtractionRequest {
  operationId: string;
  input: string;
}

export interface CandidateExtractionResult extends MappingResult {
  invocationId: string;
}

export interface CandidateExtractionService {
  extract(
    request: CandidateExtractionRequest
  ): Promise<CandidateExtractionResult>;
}

export interface CandidateExtractionServiceDependencies {
  llmService: Pick<LlmService, 'generate'>;
  provider: string;
  model: string;
  timeoutMs: number;
  // Inspection tools may observe the in-memory provider output. Production
  // workflows omit this callback, so the application does not store or log it.
  onProviderOutput?: (output: unknown) => void;
}

export function createCandidateExtractionService({
  llmService,
  provider,
  model,
  timeoutMs,
  onProviderOutput
}: CandidateExtractionServiceDependencies): CandidateExtractionService {
  return {
    async extract(request) {
      const response = await llmService.generate({
        operationId: request.operationId,
        provider,
        promptVersion: EXTRACTION_PROMPT_VERSION,
        contractVersion: AI_OUTPUT_VERSION,
        task: 'candidate_extraction',
        model,
        prompt: EXTRACTION_PROMPT,
        input: request.input,
        outputSchema: aiGenerationSchema,
        timeoutMs
      });

      onProviderOutput?.(response.output);

      return {
        invocationId: response.invocationId,
        ...mapAiOutput(response.output, collectAiInputReferences(request.input))
      };
    }
  };
}
