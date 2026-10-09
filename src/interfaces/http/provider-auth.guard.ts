import type { CanActivate } from '@nestjs/common';

/**
 * Extension point for provider authentication (ARCHITECTURE §6). Not implemented, as the challenge
 * allows: every request passes. With an IdP (Keycloak / Zitadel), this guard would validate the JWT
 * (client credentials, one client per provider) against the IdP's JWKS, take the providerId from a
 * claim and reject a body whose providerId differs (403). Health endpoints never use it.
 */
export class ProviderAuthGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}
