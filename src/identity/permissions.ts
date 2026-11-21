import type { SitePermissions } from "bitnp-authz";
import { fromRoles, realmRolesFromClaims } from "bitnp-authz";

export const MANAGEMENT_ACCESS_ROLE = "permission-management-access";

export type BerryPermissions = SitePermissions & {
  managementAccess?: boolean;
};

/**
 * Unified 3-tier access role across QQ gate, agent loop, tools, and console:
 *
 * - `admin`: configured adminQQs, Keycloak system-admin, or management-access
 * - `member`: Keycloak-bound BITNP member (`admitted`)
 * - `guest`: external or unbound user
 */
export type AccessRole = "admin" | "member" | "guest";

export const permissionsFromRoles = (
  roles: readonly unknown[],
): BerryPermissions => ({
  ...fromRoles(roles),
  managementAccess: roles.includes(MANAGEMENT_ACCESS_ROLE),
});

export const permissionsFromClaims = (claims: unknown): BerryPermissions =>
  permissionsFromRoles(realmRolesFromClaims(claims));

export const hasManagementAccess = (
  permissions: BerryPermissions | null | undefined,
): boolean =>
  Boolean(permissions?.managementAccess) || Boolean(permissions?.systemAdmin);

export function resolveAccessRole(input: {
  userId?: string | null;
  adminQQs: readonly string[];
  permissions?: BerryPermissions | null;
  isSystemSource?: boolean;
}): AccessRole {
  if (input.isSystemSource) {
    return "admin";
  }

  if (input.userId && input.adminQQs.includes(input.userId)) {
    return "admin";
  }

  if (hasManagementAccess(input.permissions)) {
    return "admin";
  }

  if (input.permissions?.admitted) {
    return "member";
  }

  return "guest";
}
