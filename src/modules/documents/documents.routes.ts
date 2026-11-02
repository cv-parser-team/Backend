import type { Readable } from 'node:stream';
import type { FastifyPluginAsync } from 'fastify';
import { AppError } from '../../shared/errors/app.error.js';
import type { ApiResponse } from '../../shared/http/api-response.js';
import type { AuthGuards } from '../auth/auth.guards.js';
import { InvalidDocumentUploadError } from './documents.errors.js';
import type { DocumentRecord } from './documents.repository.js';
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

export interface DocumentsRoutesOptions {
  service: DocumentsService;
  guards: AuthGuards;
  maximumUploadFiles: number;
}

interface DocumentUploadSuccess {
  success: true;
  filename: string;
  document: DocumentRecord;
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
  { service, guards, maximumUploadFiles }
) => {
  const candidateOnly = [
    guards.authenticate,
    guards.requireActiveAccount,
    guards.requireRole('candidate')
  ];

  fastify.post<{ Querystring: UploadDocumentQuery }>(
    '/',
    {
      schema: { querystring: uploadDocumentQuerySchema },
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
            const document = await service.uploadDocument({
              ownerUserId: request.auth.userId,
              purpose: request.query.purpose,
              originalFilename: file.filename,
              stream: file.file
            });
            results.push({
              success: true,
              filename: file.filename,
              document
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

      const statusCode =
        !limitReached && results.every((result) => result.success) ? 201 : 207;
      return reply.status(statusCode).send(response);
    }
  );

  fastify.get<{ Querystring: ListDocumentsQuery }>(
    '/',
    {
      schema: { querystring: listDocumentsQuerySchema },
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
      schema: { params: documentParamsSchema },
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
      schema: { params: documentParamsSchema },
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
      schema: { params: documentParamsSchema },
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
