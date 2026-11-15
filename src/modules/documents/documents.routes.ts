import type { Readable } from 'node:stream';
import type { FastifyPluginAsync } from 'fastify';
import { AppError } from '../../shared/errors/app.error.js';
import type { ApiResponse } from '../../shared/http/api-response.js';
import type { AuthGuards } from '../auth/auth.guards.js';
import { InvalidDocumentUploadError } from './documents.errors.js';
import type { DocumentRecord } from './documents.repository.js';
import type { DocumentStatus } from './documents.table.js';
import {
  documentParamsSchema,
  listDocumentsQuerySchema,
  uploadDocumentQuerySchema
} from './documents.schemas.js';
import type {
  DocumentParams,
  ListDocumentsQuery,
  UploadDocumentQuery
} from './documents.schemas.js';
import type { DocumentsService } from './documents.service.js';

export interface DocumentProcessingScheduler {
  schedule(documentId: string): Promise<void>;
}

export interface DocumentsRoutesOptions {
  service: DocumentsService;
  processingScheduler: DocumentProcessingScheduler;
  guards: AuthGuards;
  maximumUploadFiles: number;
}

function documentedResponse(description: string) {
  return {
    description,
    type: 'object',
    additionalProperties: true
  } as const;
}

const documentSecurity = [{ bearerAuth: [] }];
const documentAccessResponses = {
  401: documentedResponse('Authentication required or token is invalid'),
  403: documentedResponse('Active candidate account required')
};

// Source documents are processed until they succeed. The status, not whether
// the upload was deduplicated, decides: a re-upload schedules a document whose
// earlier scheduling failed (still `stored`) or whose processing failed.
// Scheduling twice is harmless, because a document has one active job at most.
const SCHEDULABLE_STATUSES: readonly DocumentStatus[] = ['stored', 'failed'];

export async function scheduleUploadedDocumentProcessing(
  processingScheduler: DocumentProcessingScheduler,
  document: Pick<DocumentRecord, 'documentId' | 'purpose' | 'status'>
): Promise<void> {
  if (
    document.purpose === 'source' &&
    SCHEDULABLE_STATUSES.includes(document.status)
  ) {
    await processingScheduler.schedule(document.documentId);
  }
}

interface DocumentUploadSuccess {
  success: true;
  filename: string;
  document: DocumentRecord;
  deduplicated: boolean;
}

interface DocumentUploadFailure {
  success: false;
  filename: string;
  error: {
    code: string;
    message: string;
  };
}

type DocumentUploadResult = DocumentUploadSuccess | DocumentUploadFailure;

interface DocumentUploadResponse extends ApiResponse<DocumentUploadResult[]> {
  limit?: {
    reached: true;
    maximumFiles: number;
  };
}

function uploadFailure(
  filename: string,
  error: unknown
): DocumentUploadFailure {
  if (error instanceof AppError) {
    return {
      success: false,
      filename,
      error: { code: error.code, message: error.message }
    };
  }

  return {
    success: false,
    filename,
    error: {
      code: 'DOCUMENT_UPLOAD_FAILED',
      message: 'Document upload failed'
    }
  };
}

async function drainFile(stream: Readable): Promise<void> {
  if (stream.destroyed || stream.readableEnded) {
    return;
  }

  for await (const chunk of stream) {
    void chunk;
  }
}

function attachmentHeader(filename: string): string {
  const encodedFilename = encodeURIComponent(filename).replace(
    /['()*]/g,
    (character) =>
      `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );

  return `attachment; filename*=UTF-8''${encodedFilename}`;
}

export const documentsRoutes: FastifyPluginAsync<DocumentsRoutesOptions> = async (
  fastify,
  { service, processingScheduler, guards, maximumUploadFiles }
) => {
  const candidateOnly = [
    guards.authenticate,
    guards.requireActiveAccount,
    guards.requireRole('candidate')
  ];

  fastify.post<{ Querystring: UploadDocumentQuery }>(
    '/',
    {
      schema: {
        tags: ['Documents'],
        summary: 'Upload candidate documents',
        description:
          "Uploads one or more multipart files using repeated 'file' fields. " +
          'Each file is processed independently.',
        security: documentSecurity,
        consumes: ['multipart/form-data'],
        querystring: uploadDocumentQuerySchema,
        response: {
          200: documentedResponse('All uploaded files were deduplicated'),
          201: documentedResponse('Documents uploaded successfully'),
          207: documentedResponse('Upload completed with per-file results'),
          400: documentedResponse('Invalid purpose or multipart upload'),
          ...documentAccessResponses,
          413: documentedResponse('Upload exceeds the configured size limit')
        }
      },
      config: {
        swaggerTransform: ({ schema, url }) => ({
          url,
          schema: {
            ...schema,
            body: {
              type: 'object',
              required: ['file'],
              properties: {
                file: {
                  type: 'array',
                  minItems: 1,
                  maxItems: maximumUploadFiles,
                  items: { type: 'string', format: 'binary' }
                }
              }
            }
          }
        })
      },
      preHandler: candidateOnly
    },
    async (request, reply) => {
      const results: DocumentUploadResult[] = [];
      let fileCount = 0;
      let limitReached = false;

      try {
        for await (const file of request.files({
          limits: { files: maximumUploadFiles }
        })) {
          fileCount += 1;

          if (file.fieldname !== 'file') {
            await drainFile(file.file);
            results.push(
              uploadFailure(
                file.filename,
                new InvalidDocumentUploadError(
                  "Document files must use the 'file' field"
                )
              )
            );
            continue;
          }

          try {
            const { document, deduplicated } = await service.uploadDocument({
              ownerUserId: request.auth.userId,
              purpose: request.query.purpose,
              originalFilename: file.filename,
              stream: file.file
            });

            await scheduleUploadedDocumentProcessing(processingScheduler, document);

            results.push({
              success: true,
              filename: file.filename,
              document,
              deduplicated
            });
          } catch (error) {
            try {
              await drainFile(file.file);
            } catch (drainError) {
              request.log.error(drainError);
            }
            if (!(error instanceof AppError)) {
              request.log.error(error);
            }
            results.push(uploadFailure(file.filename, error));
          }
        }
      } catch (error) {
        if (!(error instanceof fastify.multipartErrors.FilesLimitError)) {
          throw error;
        }

        limitReached = true;
      }

      if (fileCount === 0) {
        throw new InvalidDocumentUploadError(
          "Upload must contain at least one file in the 'file' field"
        );
      }

      const response: DocumentUploadResponse = {
        success: true,
        data: results,
        ...(limitReached
          ? {
              limit: { reached: true, maximumFiles: maximumUploadFiles }
            }
          : {}),
        timestamp: new Date().toISOString()
      };

      const allSuccessful = results.every((result) => result.success);
      const allDeduplicated = results.every(
        (result) => result.success && result.deduplicated
      );
      const statusCode =
        limitReached || !allSuccessful ? 207 : allDeduplicated ? 200 : 201;
      return reply.status(statusCode).send(response);
    }
  );

  fastify.get<{ Querystring: ListDocumentsQuery }>(
    '/',
    {
      schema: {
        tags: ['Documents'],
        summary: 'List my documents',
        security: documentSecurity,
        querystring: listDocumentsQuerySchema,
        response: {
          200: documentedResponse('Candidate documents'),
          400: documentedResponse('Invalid document filters'),
          ...documentAccessResponses
        }
      },
      preHandler: candidateOnly
    },
    async (request) => {
      const data = await service.listDocuments(
        request.auth.userId,
        request.query
      );
      const response: ApiResponse<DocumentRecord[]> = {
        success: true,
        data,
        timestamp: new Date().toISOString()
      };

      return response;
    }
  );

  fastify.get<{ Params: DocumentParams }>(
    '/:documentId',
    {
      schema: {
        tags: ['Documents'],
        summary: 'Get document metadata',
        security: documentSecurity,
        params: documentParamsSchema,
        response: {
          200: documentedResponse('Document metadata'),
          400: documentedResponse('Invalid document ID'),
          ...documentAccessResponses,
          404: documentedResponse('Document not found')
        }
      },
      preHandler: candidateOnly
    },
    async (request) => {
      const data = await service.getDocument(
        request.auth.userId,
        request.params.documentId
      );
      const response: ApiResponse<DocumentRecord> = {
        success: true,
        data,
        timestamp: new Date().toISOString()
      };

      return response;
    }
  );

  fastify.delete<{ Params: DocumentParams }>(
    '/:documentId',
    {
      schema: {
        tags: ['Documents'],
        summary: 'Delete a document',
        security: documentSecurity,
        params: documentParamsSchema,
        response: {
          204: documentedResponse('Document deleted successfully'),
          400: documentedResponse('Invalid document ID'),
          ...documentAccessResponses,
          404: documentedResponse('Document not found')
        }
      },
      preHandler: candidateOnly
    },
    async (request, reply) => {
      await service.deleteDocument(
        request.auth.userId,
        request.params.documentId
      );

      return reply.status(204).send();
    }
  );

  fastify.get<{ Params: DocumentParams }>(
    '/:documentId/content',
    {
      schema: {
        tags: ['Documents'],
        summary: 'Download document content',
        security: documentSecurity,
        produces: [
          'application/pdf',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          'image/jpeg',
          'image/png'
        ],
        params: documentParamsSchema,
        response: {
          200: {
            description: 'Original document bytes',
            type: 'string'
          },
          400: documentedResponse('Invalid document ID'),
          ...documentAccessResponses,
          404: documentedResponse('Document not found')
        }
      },
      preHandler: candidateOnly
    },
    async (request, reply) => {
      const { document, stream } = await service.openDocument(
        request.auth.userId,
        request.params.documentId
      );
      return reply
        .type(document.mediaType)
        .header('content-length', document.byteSize)
        .header(
          'content-disposition',
          attachmentHeader(document.originalFilename)
        )
        .send(stream);
    }
  );
};
