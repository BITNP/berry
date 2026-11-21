import type { SitePermissions } from "bitnp-authz";
import { fromClaims, fromRoles, realmRolesFromClaims } from "bitnp-authz";

export const MANAGEMENT_ACCESS_ROLE = "permission-management-access";

export type BerryPermissions = SitePermissions & {
  managementAccess?: boolean;
};

export type SenderPrivilege = "privileged" | "standard";

export const permissionsFromRoles = (
  roles: readonly unknown[],
): BerryPermissions => ({
  ...fromRoles(roles),
  managementAccess: roles.includes(MANAGEMENT_ACCESS_ROLE),
});

export function permissionsFromClaims(claims: unknown): BerryPermissions {
  const roles = realmRolesFromClaims(claims);

  return {
    ...fromClaims(claims),
    managementAccess: roles.includes(MANAGEMENT_ACCESS_ROLE),
  };
}

export const hasManagementAccess = (
  permissions: BerryPermissions | null | undefined,
): boolean =>
  Boolean(permissions?.managementAccess) || Boolean(permissions?.systemAdmin);
