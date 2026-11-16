import { FastifyPluginAsync } from 'fastify';
import { AuthGuards } from '../auth/auth.guards.js';
import { ApiResponse } from '../../shared/http/api-response.js';
import { parseIfMatchVersion, versionEtag } from '../../shared/http/if-match.js';
import { ClaimRecord } from './candidates.repository.js';
import {
  ClaimBody,
  claimBodySchema,
  ClaimCoalesceBody,
  claimCoalesceBodySchema,
  ConfirmClaimMergeBody,
  confirmClaimMergeBodySchema,
  ClaimMergeProposalQuery,
  claimMergeProposalQuerySchema,
  ClaimParams,
  claimParamsSchema,
  CreateCandidateBody,
  createCandidateBodySchema,
  ListClaimsQuery,
  listClaimsQuerySchema,
  ReviewClaimBody,
  reviewClaimBodySchema,
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

function documentedResponse(description: string) {
  return {
    description,
    type: 'object',
    additionalProperties: true
  } as const;
}

const candidateSecurity = [{ bearerAuth: [] }];
const candidateAccessResponses = {
  401: documentedResponse('Authentication required or token is invalid'),
  403: documentedResponse('Active candidate account required')
};
const ifMatchHeadersSchema = {
  type: 'object',
  properties: {
    'if-match': {
      type: 'string',
      description: 'Optional record version used to prevent concurrent overwrites'
    }
  },
  additionalProperties: true
} as const;

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
    {
      schema: {
        tags: ['Candidates'],
        summary: 'Create my candidate profile',
        security: candidateSecurity,
        body: createCandidateBodySchema,
        response: {
          201: documentedResponse('Candidate profile created successfully'),
          400: documentedResponse('Invalid profile details'),
          ...candidateAccessResponses,
          409: documentedResponse('Candidate profile already exists')
        }
      },
      preHandler: candidateOnly
    },
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

  fastify.get(
    '/me',
    {
      schema: {
        tags: ['Candidates'],
        summary: 'Get my candidate profile',
        security: candidateSecurity,
        response: {
          200: documentedResponse('Candidate profile'),
          ...candidateAccessResponses,
          404: documentedResponse('Candidate profile not found')
        }
      },
      preHandler: candidateOnly
    },
    async (request, reply) => {
      const data = await service.getProfile(request.auth.userId);
      const response: ApiResponse<CandidateProfile> = {
        success: true,
        data,
        timestamp: new Date().toISOString()
      };

      return reply.header('etag', versionEtag(data.version)).send(response);
    }
  );

  // Edits accept the version the client last read in `If-Match`; a profile or
  // claim that changed since is refused with 409 VERSION_CONFLICT.
  fastify.patch<{ Body: UpdateCandidateBody }>(
    '/me',
    {
      schema: {
        tags: ['Candidates'],
        summary: 'Update my candidate profile',
        security: candidateSecurity,
        headers: ifMatchHeadersSchema,
        body: updateCandidateBodySchema,
        response: {
          200: documentedResponse('Candidate profile updated successfully'),
          400: documentedResponse('Invalid profile details or If-Match header'),
          ...candidateAccessResponses,
          404: documentedResponse('Candidate profile not found'),
          409: documentedResponse('Profile version conflict')
        }
      },
      preHandler: candidateOnly
    },
    async (request, reply) => {
      const data = await service.updateProfile(
        request.auth.userId,
        request.body,
        parseIfMatchVersion(request.headers['if-match'])
      );
      const response: ApiResponse<CandidateProfile> = {
        success: true,
        data,
        message: 'Candidate profile updated successfully',
        timestamp: new Date().toISOString()
      };

      return reply.header('etag', versionEtag(data.version)).send(response);
    }
  );

  fastify.get(
    '/me/profile',
    {
      schema: {
        tags: ['Candidates'],
        summary: 'Export my structured profile',
        description: 'Returns profile information and accepted claims only.',
        security: candidateSecurity,
        response: {
          200: documentedResponse('Structured candidate profile'),
          ...candidateAccessResponses,
          404: documentedResponse('Candidate profile not found')
        }
      },
      preHandler: candidateOnly
    },
    async (request) => {
      const data = await service.exportProfile(request.auth.userId);
      const response: ApiResponse<ExportedProfile> = {
        success: true,
        data,
        timestamp: new Date().toISOString()
      };

      return response;
    }
  );

  fastify.post<{ Body: ClaimBody }>(
    '/me/claims',
    {
      schema: {
        tags: ['Candidates'],
        summary: 'Add a manual claim',
        security: candidateSecurity,
        body: claimBodySchema,
        response: {
          201: documentedResponse('Claim created successfully'),
          400: documentedResponse('Invalid claim details'),
          ...candidateAccessResponses,
          404: documentedResponse('Candidate profile not found')
        }
      },
      preHandler: candidateOnly
    },
    async (request, reply) => {
      const data = await service.createClaim(request.auth.userId, request.body);
      const response: ApiResponse<ClaimRecord> = {
        success: true,
        data,
        message: 'Claim created successfully',
        timestamp: new Date().toISOString()
      };

      return reply
        .status(201)
        .header('etag', versionEtag(data.version))
        .send(response);
    }
  );

  fastify.get<{ Querystring: ListClaimsQuery }>(
    '/me/claims',
    {
      schema: {
        tags: ['Candidates'],
        summary: 'List my claims',
        security: candidateSecurity,
        querystring: listClaimsQuerySchema,
        response: {
          200: documentedResponse('Candidate claims'),
          400: documentedResponse('Invalid claim filters'),
          ...candidateAccessResponses,
          404: documentedResponse('Candidate profile not found')
        }
      },
      preHandler: candidateOnly
    },
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

  fastify.get<{ Querystring: ClaimMergeProposalQuery }>(
    '/me/claims/merge-proposal',
    {
      schema: {
        tags: ['Candidates'],
        summary: 'Compare two claims and build a merge proposal',
        description: 'Read-only comparison; this endpoint never changes either claim.',
        security: candidateSecurity,
        querystring: claimMergeProposalQuerySchema,
        response: {
          200: documentedResponse('Claim merge proposal'),
          400: documentedResponse('Invalid claim IDs'),
          ...candidateAccessResponses,
          404: documentedResponse('Candidate profile or claim not found')
        }
      },
      preHandler: candidateOnly
    },
    async (request) => {
      const data = await service.getClaimMergeProposal(
        request.auth.userId,
        request.query.leftClaimId,
        request.query.rightClaimId
      );
      const response: ApiResponse<typeof data> = {
        success: true,
        data,
        timestamp: new Date().toISOString()
      };

      return response;
    }
  );

  fastify.post<{ Body: ClaimCoalesceBody }>(
    '/me/claims/coalesce',
    {
      schema: {
        tags: ['Candidates'],
        summary: 'Safely coalesce two pending extracted claims',
        description:
          'Coalesces only automatically safe pairs. The survivor remains pending and is not exported.',
        security: candidateSecurity,
        body: claimCoalesceBodySchema,
        response: {
          200: documentedResponse('Coalesce result'),
          400: documentedResponse('Invalid claim IDs'),
          ...candidateAccessResponses,
          404: documentedResponse('Candidate profile or claim not found'),
          409: documentedResponse('Claim version conflict')
        }
      },
      preHandler: candidateOnly
    },
    async (request) => {
      const data = await service.coalescePendingClaims(
        request.auth.userId,
        request.body.leftClaimId,
        request.body.rightClaimId
      );
      const response: ApiResponse<typeof data> = {
        success: true,
        data,
        timestamp: new Date().toISOString()
      };

      return response;
    }
  );

  fastify.post<{ Body: ConfirmClaimMergeBody }>(
    '/me/claims/merge',
    {
      schema: {
        tags: ['Candidates'],
        summary: 'Confirm and apply a claim merge',
        description:
          'Applies the candidate-confirmed values atomically. The survivor becomes accepted and is included in profile export.',
        security: candidateSecurity,
        body: confirmClaimMergeBodySchema,
        response: {
          200: documentedResponse('Confirmed claim merge result'),
          400: documentedResponse('Invalid claim merge resolution'),
          ...candidateAccessResponses,
          404: documentedResponse('Candidate profile or claim not found'),
          409: documentedResponse('Claim version conflict')
        }
      },
      preHandler: candidateOnly
    },
    async (request) => {
      const data = await service.mergeConfirmedClaims(
        request.auth.userId,
        request.body
      );
      const response: ApiResponse<typeof data> = {
        success: true,
        data,
        message:
          data.result === 'merged'
            ? 'Claims merged and survivor accepted successfully'
            : undefined,
        timestamp: new Date().toISOString()
      };

      return response;
    }
  );

  fastify.get<{ Params: ClaimParams }>(
    '/me/claims/:claimId',
    {
      schema: {
        tags: ['Candidates'],
        summary: 'Get one of my claims',
        security: candidateSecurity,
        params: claimParamsSchema,
        response: {
          200: documentedResponse('Candidate claim'),
          400: documentedResponse('Invalid claim ID'),
          ...candidateAccessResponses,
          404: documentedResponse('Claim not found')
        }
      },
      preHandler: candidateOnly
    },
    async (request, reply) => {
      const data = await service.getClaim(
        request.auth.userId,
        request.params.claimId
      );
      const response: ApiResponse<ClaimRecord> = {
        success: true,
        data,
        timestamp: new Date().toISOString()
      };

      return reply.header('etag', versionEtag(data.version)).send(response);
    }
  );

  fastify.put<{ Params: ClaimParams; Body: ClaimBody }>(
    '/me/claims/:claimId',
    {
      schema: {
        tags: ['Candidates'],
        summary: 'Update one of my claims',
        security: candidateSecurity,
        headers: ifMatchHeadersSchema,
        params: claimParamsSchema,
        body: claimBodySchema,
        response: {
          200: documentedResponse('Claim updated successfully'),
          400: documentedResponse('Invalid claim details, ID, or If-Match header'),
          ...candidateAccessResponses,
          404: documentedResponse('Claim not found'),
          409: documentedResponse('Claim version conflict')
        }
      },
      preHandler: candidateOnly
    },
    async (request, reply) => {
      const data = await service.updateClaim(
        request.auth.userId,
        request.params.claimId,
        request.body,
        parseIfMatchVersion(request.headers['if-match'])
      );
      const response: ApiResponse<ClaimRecord> = {
        success: true,
        data,
        message: 'Claim updated successfully',
        timestamp: new Date().toISOString()
      };

      return reply.header('etag', versionEtag(data.version)).send(response);
    }
  );

  fastify.patch<{ Params: ClaimParams; Body: ReviewClaimBody }>(
    '/me/claims/:claimId/review',
    {
      schema: {
        tags: ['Candidates'],
        summary: 'Review an extracted claim',
        security: candidateSecurity,
        headers: ifMatchHeadersSchema,
        params: claimParamsSchema,
        body: reviewClaimBodySchema,
        response: {
          200: documentedResponse('Claim review saved successfully'),
          400: documentedResponse('Invalid review, claim ID, or If-Match header'),
          ...candidateAccessResponses,
          404: documentedResponse('Claim not found'),
          409: documentedResponse('Claim is not reviewable or has a version conflict')
        }
      },
      preHandler: candidateOnly
    },
    async (request, reply) => {
      const data = await service.reviewClaim(
        request.auth.userId,
        request.params.claimId,
        request.body,
        parseIfMatchVersion(request.headers['if-match'])
      );
      const response: ApiResponse<ClaimRecord> = {
        success: true,
        data,
        message: 'Claim review saved successfully',
        timestamp: new Date().toISOString()
      };

      return reply.header('etag', versionEtag(data.version)).send(response);
    }
  );

  fastify.delete<{ Params: ClaimParams }>(
    '/me/claims/:claimId',
    {
      schema: {
        tags: ['Candidates'],
        summary: 'Delete one of my claims',
        security: candidateSecurity,
        headers: ifMatchHeadersSchema,
        params: claimParamsSchema,
        response: {
          204: documentedResponse('Claim deleted successfully'),
          400: documentedResponse('Invalid claim ID or If-Match header'),
          ...candidateAccessResponses,
          404: documentedResponse('Claim not found'),
          409: documentedResponse('Claim version conflict')
        }
      },
      preHandler: candidateOnly
    },
    async (request, reply) => {
      await service.deleteClaim(
        request.auth.userId,
        request.params.claimId,
        parseIfMatchVersion(request.headers['if-match'])
      );
      return reply.status(204).send();
    }
  );
};
