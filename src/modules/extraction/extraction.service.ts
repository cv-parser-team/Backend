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

export const EXTRACTION_PROMPT_VERSION = 'candidate-extraction-v2';

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

For a profile link, value is its URL and raw is its visible label; both are required. Use YYYY-MM for dates and never invent a month from a year-only date. An explicitly current end date omits value and instead has current true and its original wording in raw. Put unsupported or incomplete information, including year-only dates, awards, and courses, in unmapped with its original text and sources. Consolidate clearly identical claims and combine their source references. Do not emit null, empty values, unknown fields, or unsupported claim types. Return JSON only.`;

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
}

export function createCandidateExtractionService({
  llmService,
  provider,
  model,
  timeoutMs
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

      return {
        invocationId: response.invocationId,
        ...mapAiOutput(response.output, collectAiInputReferences(request.input))
      };
    }
  };
}
