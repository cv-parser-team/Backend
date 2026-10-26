import { FastifyError, FastifyPluginAsync } from 'fastify';
import fastifyPlugin from 'fastify-plugin';
import { AppError } from '../../shared/errors/app.error.js';
import { ApiErrorResponse } from '../../shared/http/api-response.js';

function errorResponse(
  code: string,
  message: string,
  details?: unknown
): ApiErrorResponse {
  return {
    success: false,
    error: { code, message, ...(details === undefined ? {} : { details }) },
    timestamp: new Date().toISOString()
  };
}

const registerErrorHandler: FastifyPluginAsync = async (fastify) => {
  fastify.setNotFoundHandler((request, reply) => {
    return reply.status(404).send(
      errorResponse(
        'NOT_FOUND',
        `Route ${request.method} ${request.url} not found`
      )
    );
  });

  fastify.setErrorHandler((error: FastifyError | AppError, _request, reply) => {
    fastify.log.error(error);

    if (error instanceof AppError) {
      return reply
        .status(error.statusCode)
        .send(errorResponse(error.code, error.message, error.details));
    }

    if (error.validation) {
      return reply
        .status(400)
        .send(errorResponse('VALIDATION_ERROR', error.message, error.validation));
    }

    const statusCode = error.statusCode ?? 500;
    return reply
      .status(statusCode)
      .send(errorResponse(error.code || 'INTERNAL_ERROR', error.message));
  });
};

export const errorHandlerPlugin = fastifyPlugin(registerErrorHandler, {
  name: 'error-handler'
});
