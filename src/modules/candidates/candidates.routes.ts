import { FastifyPluginAsync } from 'fastify';
import { AuthGuards } from '../auth/auth.guards.js';
import { ApiResponse } from '../../shared/http/api-response.js';
import { ClaimRecord } from './candidates.repository.js';
import {
  ClaimBody,
  claimBodySchema,
  ClaimParams,
  claimParamsSchema,
  CreateCandidateBody,
  createCandidateBodySchema,
  ListClaimsQuery,
  listClaimsQuerySchema,
  UpdateCandidateBody,
  updateCandidateBodySchema
} from './candidates.schemas.js';
import {
  CandidateProfile,
  CandidatesService,
  ExportedProfile
} from './candidates.service.js';

export interface CandidatesRoutesOptions {
  service: CandidatesService;
  guards: AuthGuards;
}

export const candidatesRoutes: FastifyPluginAsync<CandidatesRoutesOptions> = async (
  fastify,
  { service, guards }
) => {
  const candidateOnly = [
    guards.authenticate,
    guards.requireActiveAccount,
    guards.requireRole('candidate')
  ];

  fastify.post<{ Body: CreateCandidateBody }>(
    '/me',
    { schema: { body: createCandidateBodySchema }, preHandler: candidateOnly },
    async (request, reply) => {
      const data = await service.createProfile(request.auth.userId, request.body);
      const response: ApiResponse<CandidateProfile> = {
        success: true,
        data,
        message: 'Candidate profile created successfully',
        timestamp: new Date().toISOString()
      };

      return reply.status(201).send(response);
    }
  );

  fastify.get('/me', { preHandler: candidateOnly }, async (request) => {
    const data = await service.getProfile(request.auth.userId);
    const response: ApiResponse<CandidateProfile> = {
      success: true,
      data,
      timestamp: new Date().toISOString()
    };

    return response;
  });

  fastify.patch<{ Body: UpdateCandidateBody }>(
    '/me',
    { schema: { body: updateCandidateBodySchema }, preHandler: candidateOnly },
    async (request) => {
      const data = await service.updateProfile(request.auth.userId, request.body);
      const response: ApiResponse<CandidateProfile> = {
        success: true,
        data,
        message: 'Candidate profile updated successfully',
        timestamp: new Date().toISOString()
      };

      return response;
    }
  );

  fastify.get('/me/profile', { preHandler: candidateOnly }, async (request) => {
    const data = await service.exportProfile(request.auth.userId);
    const response: ApiResponse<ExportedProfile> = {
      success: true,
      data,
      timestamp: new Date().toISOString()
    };

    return response;
  });

  fastify.post<{ Body: ClaimBody }>(
    '/me/claims',
    { schema: { body: claimBodySchema }, preHandler: candidateOnly },
    async (request, reply) => {
      const data = await service.createClaim(request.auth.userId, request.body);
      const response: ApiResponse<ClaimRecord> = {
        success: true,
        data,
        message: 'Claim created successfully',
        timestamp: new Date().toISOString()
      };

      return reply.status(201).send(response);
    }
  );

  fastify.get<{ Querystring: ListClaimsQuery }>(
    '/me/claims',
    { schema: { querystring: listClaimsQuerySchema }, preHandler: candidateOnly },
    async (request) => {
      const data = await service.listClaims(request.auth.userId, request.query);
      const response: ApiResponse<ClaimRecord[]> = {
        success: true,
        data,
        timestamp: new Date().toISOString()
      };

      return response;
    }
  );

  fastify.put<{ Params: ClaimParams; Body: ClaimBody }>(
    '/me/claims/:claimId',
    {
      schema: { params: claimParamsSchema, body: claimBodySchema },
      preHandler: candidateOnly
    },
    async (request) => {
      const data = await service.updateClaim(
        request.auth.userId,
        request.params.claimId,
        request.body
      );
      const response: ApiResponse<ClaimRecord> = {
        success: true,
        data,
        message: 'Claim updated successfully',
        timestamp: new Date().toISOString()
      };

      return response;
    }
  );

  fastify.delete<{ Params: ClaimParams }>(
    '/me/claims/:claimId',
    { schema: { params: claimParamsSchema }, preHandler: candidateOnly },
    async (request, reply) => {
      await service.deleteClaim(request.auth.userId, request.params.claimId);
      return reply.status(204).send();
    }
  );
};
