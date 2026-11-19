//#region src/claims.d.ts
export declare function realmRolesFromClaims(claims: unknown): string[];
//#endregion
//#region src/roles.d.ts
export declare const DEPARTMENTS: readonly ["techdept", "clinic", "digimedia", "techsvc"];
type Department = (typeof DEPARTMENTS)[number];
export declare const SYSTEM_ADMIN_ROLE = "permission-system-admin";
export declare function departmentLabel(department: Department): string;
export declare function accessRole(department: Department): string;
export declare function adminRole(department: Department): string;
export declare function recognizedRoles(): string[];
export declare function permissionRoles(roles: readonly unknown[]): string[];
export declare function unrecognizedPermissionRoles(roles: readonly unknown[]): string[];
//#endregion
//#region src/positions.d.ts
type PositionScope = "association" | "department";
type PositionLocation = {
  readonly scope: "association";
  readonly department: null;
} | {
  readonly scope: "department";
  readonly department: Department;
};
type Position = PositionLocation & {
  readonly roleName: string;
  readonly label: string;
  readonly rank: number;
};
type PositionView = PositionLocation & {
  readonly code: string;
  readonly label: string;
};
export declare const POSITIONS: readonly Position[];
export declare function positionForRole(role: string): Position | undefined;
export declare function positionsFromRoles(roles: readonly unknown[]): readonly PositionView[];
//#endregion
//#region src/permissions.d.ts
interface SitePermissions {
  readonly admitted: boolean;
  readonly systemAdmin: boolean;
  readonly manager: boolean;
  readonly accessDepartments: readonly Department[];
  readonly managedDepartments: readonly Department[];
  readonly positions: readonly PositionView[];
}
export declare function fromRoles(roles: readonly unknown[]): SitePermissions;
export declare function fromClaims(claims: unknown): SitePermissions;
//#endregion
export type { Department, Position, PositionScope, PositionView, SitePermissions };