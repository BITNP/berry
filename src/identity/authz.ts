export const SYSTEM_ADMIN_ROLE = "permission-system-admin";

export type Department = "techdept" | "clinic" | "digimedia" | "techsvc";

export const DEPARTMENTS: readonly Department[] = [
  "techdept",
  "clinic",
  "digimedia",
  "techsvc",
];

export const DEPARTMENT_LABELS: Record<Department, string> = {
  techdept: "技术部",
  clinic: "电脑诊所",
  digimedia: "数字媒体中心",
  techsvc: "技术保障中心",
};

export interface PositionDef {
  roleName: string;
  label: string;
  scope: "association" | "department";
  department: Department | null;
  rank: number;
}

const POSITION_CATALOG: readonly PositionDef[] = [
  {
    roleName: "position-association-chair",
    label: "协会主席",
    scope: "association",
    department: null,
    rank: 100,
  },
  {
    roleName: "position-association-vice-chair-techdept",
    label: "协会副主席（技术部分管）",
    scope: "association",
    department: null,
    rank: 92,
  },
  {
    roleName: "position-association-vice-chair-clinic",
    label: "协会副主席（电脑诊所分管）",
    scope: "association",
    department: null,
    rank: 92,
  },
  {
    roleName: "position-association-vice-chair-digimedia",
    label: "协会副主席（数字媒体中心分管）",
    scope: "association",
    department: null,
    rank: 92,
  },
  {
    roleName: "position-techdept-head",
    label: "技术部部长",
    scope: "department",
    department: "techdept",
    rank: 80,
  },
  {
    roleName: "position-techdept-deputy-head",
    label: "技术部副部长",
    scope: "department",
    department: "techdept",
    rank: 70,
  },
  {
    roleName: "position-techdept-advisor",
    label: "技术部顾问",
    scope: "department",
    department: "techdept",
    rank: 60,
  },
  {
    roleName: "position-techdept-member",
    label: "技术部成员",
    scope: "department",
    department: "techdept",
    rank: 10,
  },
  {
    roleName: "position-clinic-head",
    label: "电脑诊所部长",
    scope: "department",
    department: "clinic",
    rank: 80,
  },
  {
    roleName: "position-clinic-deputy-head",
    label: "电脑诊所副部长",
    scope: "department",
    department: "clinic",
    rank: 70,
  },
  {
    roleName: "position-clinic-advisor",
    label: "电脑诊所顾问",
    scope: "department",
    department: "clinic",
    rank: 60,
  },
  {
    roleName: "position-clinic-member",
    label: "电脑诊所成员",
    scope: "department",
    department: "clinic",
    rank: 10,
  },
  {
    roleName: "position-digimedia-head",
    label: "数字媒体中心部长",
    scope: "department",
    department: "digimedia",
    rank: 80,
  },
  {
    roleName: "position-digimedia-deputy-head",
    label: "数字媒体中心副部长",
    scope: "department",
    department: "digimedia",
    rank: 70,
  },
  {
    roleName: "position-digimedia-advisor",
    label: "数字媒体中心顾问",
    scope: "department",
    department: "digimedia",
    rank: 60,
  },
  {
    roleName: "position-digimedia-member",
    label: "数字媒体中心成员",
    scope: "department",
    department: "digimedia",
    rank: 10,
  },
  {
    roleName: "position-techsvc-director",
    label: "技术保障中心主任",
    scope: "department",
    department: "techsvc",
    rank: 80,
  },
  {
    roleName: "position-techsvc-deputy-director",
    label: "技术保障中心副主任",
    scope: "department",
    department: "techsvc",
    rank: 70,
  },
  {
    roleName: "position-techsvc-member",
    label: "技术保障中心成员",
    scope: "department",
    department: "techsvc",
    rank: 10,
  },
];

const POSITION_BY_ROLE = new Map(
  POSITION_CATALOG.map((def) => [def.roleName, def]),
);

export interface PositionView {
  code: string;
  label: string;
  scope: "association" | "department";
  department: Department | null;
}

export interface SitePermissions {
  admitted: boolean;
  systemAdmin: boolean;
  manager: boolean;
  accessDepartments: Department[];
  managedDepartments: Department[];
  positions: PositionView[];
}

export function realmRolesFromClaims(
  claims: Record<string, unknown>,
): string[] {
  const realmAccess = claims.realm_access;

  if (!realmAccess || typeof realmAccess !== "object") {
    return [];
  }

  const rawRoles = (realmAccess as Record<string, unknown>).roles;

  if (!Array.isArray(rawRoles)) {
    return [];
  }

  return rawRoles.filter(
    (role): role is string => typeof role === "string" && role.trim() !== "",
  );
}

export function positionsFromRoles(roles: string[]): PositionView[] {
  let association: PositionDef | null = null;
  const byDepartment = new Map<Department, PositionDef>();

  for (const role of roles) {
    const pos = POSITION_BY_ROLE.get(role);

    if (!pos) {
      continue;
    }

    if (pos.scope === "association") {
      if (!association || pos.rank > association.rank) {
        association = pos;
      }

      continue;
    }

    if (pos.department) {
      const current = byDepartment.get(pos.department);

      if (!current || pos.rank > current.rank) {
        byDepartment.set(pos.department, pos);
      }
    }
  }

  const views: PositionView[] = [];

  if (association) {
    views.push({
      code: association.roleName,
      label: association.label,
      scope: association.scope,
      department: null,
    });
  }

  for (const department of DEPARTMENTS) {
    const pos = byDepartment.get(department);

    if (pos) {
      views.push({
        code: pos.roleName,
        label: pos.label,
        scope: pos.scope,
        department,
      });
    }
  }

  return views;
}

export function fromRoles(roles: string[]): SitePermissions {
  const roleSet = new Set(roles);
  const systemAdmin = roleSet.has(SYSTEM_ADMIN_ROLE);
  const accessDepartments: Department[] = [];
  const managedDepartments: Department[] = [];

  for (const department of DEPARTMENTS) {
    if (roleSet.has(`permission-${department}-access`)) {
      accessDepartments.push(department);
    }

    if (roleSet.has(`permission-${department}-admin`)) {
      managedDepartments.push(department);
    }
  }

  const manager = systemAdmin || managedDepartments.length > 0;
  const admitted = manager || accessDepartments.length > 0;

  return {
    admitted,
    systemAdmin,
    manager,
    accessDepartments,
    managedDepartments,
    positions: positionsFromRoles(roles),
  };
}

export const fromClaims = (claims: Record<string, unknown>): SitePermissions =>
  fromRoles(realmRolesFromClaims(claims));
