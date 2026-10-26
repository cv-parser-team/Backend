import { FastifyPluginAsync } from 'fastify';
import { AuthService } from './auth.service.js';

export interface AuthRoutesOptions {
  service: AuthService;
}

export const authRoutes: FastifyPluginAsync<AuthRoutesOptions> = async (
  _fastify,
  _options
) => {
  // TODO: register, sign-in, refresh, logout, and logout-all routes.

};
