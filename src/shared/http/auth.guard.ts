import { Injectable, type CanActivate, type ExecutionContext } from "@nestjs/common";

/**
 * Authentication extension point — intentionally a no-op (see ARCHITECTURE.md, "Authentication").
 *
 * Intended design: provider systems authenticate with an external IdP (Keycloak/Zitadel) using the
 * OAuth2 client-credentials grant; this guard would verify the bearer JWT (issuer, audience,
 * signature via JWKS), map `azp`/`client_id` to a providerId, and reject requests whose body
 * `providerId` differs from the authenticated one. Health and metrics endpoints stay open, and SQS
 * is treated as a trusted internal channel (domain validations still apply).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    return true;
  }
}
