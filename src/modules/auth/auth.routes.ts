import { FastifyPluginAsync } from 'fastify';
import { ApiResponse } from '../../shared/http/api-response.js';
import { AuthGuards } from './auth.guards.js';
import {
  RegisterBody,
  registerBodySchema,
  SignInBody,
  signInBodySchema
} from './auth.schemas.js';
import { AuthResult, AuthService } from './auth.service.js';

export interface AuthRoutesOptions {
  service: AuthService;
  guards: AuthGuards;
}

export const authRoutes: FastifyPluginAsync<AuthRoutesOptions> = async (
  fastify,
  { service, guards }
) => {
  fastify.post<{ Body: RegisterBody }>(
    '/register',
    { schema: { body: registerBodySchema } },
    async (request, reply) => {
      const data = await service.register(request.body);
      const response: ApiResponse<AuthResult> = {
        success: true,
        data,
        message: 'Candidate registered successfully',
        timestamp: new Date().toISOString()
      };

      return reply.status(201).send(response);
    }
  );

  fastify.post<{ Body: SignInBody }>(
    '/sign-in',
    { schema: { body: signInBodySchema } },
    async (request) => {
      const data = await service.signIn(request.body);
      const response: ApiResponse<AuthResult> = {
        success: true,
        data,
        message: 'Signed in successfully',
        timestamp: new Date().toISOString()
      };

      return response;
    }
  );

  fastify.post(
    '/logout',
    { preHandler: [guards.authenticate, guards.requireActiveAccount] },
    async (request, reply) => {
      await service.logout(request.auth.userId);
      return reply.status(204).send();
    }
  );
};
