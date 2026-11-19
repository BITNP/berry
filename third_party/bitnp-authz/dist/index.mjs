//#region src/claims.ts
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function realmRolesFromClaims(claims) {
	if (!isRecord(claims) || !isRecord(claims.realm_access)) return [];
	const roles = claims.realm_access.roles;
	if (!Array.isArray(roles)) return [];
	return roles.filter((role) => typeof role === "string" && role.trim() !== "");
}
//#endregion
//#region src/roles.ts
const DEPARTMENTS = Object.freeze([
	"techdept",
	"clinic",
	"digimedia",
	"techsvc"
]);
const departmentLabels = {
	techdept: "技术部",
	clinic: "电脑诊所",
	digimedia: "数字媒体中心",
	techsvc: "技术保障中心"
};
const SYSTEM_ADMIN_ROLE = "permission-system-admin";
function departmentLabel(department) {
	return departmentLabels[department];
}
function accessRole(department) {
	return `permission-${department}-access`;
}
function adminRole(department) {
	return `permission-${department}-admin`;
}
function recognizedRoles() {
	return [SYSTEM_ADMIN_ROLE, ...DEPARTMENTS.flatMap((department) => [accessRole(department), adminRole(department)])];
}
function permissionRoles(roles) {
	const recognized = new Set(recognizedRoles());
	return [...new Set(roles)].filter((role) => typeof role === "string" && recognized.has(role));
}
function unrecognizedPermissionRoles(roles) {
	const recognized = new Set(recognizedRoles());
	return [...new Set(roles)].filter((role) => typeof role === "string" && role.startsWith("permission-") && !recognized.has(role));
}
//#endregion
//#region src/positions.ts
const POSITIONS = Object.freeze([
	{
		roleName: "position-association-chair",
		label: "协会主席",
		scope: "association",
		department: null,
		rank: 100
	},
	{
		roleName: "position-association-vice-chair-techdept",
		label: "协会副主席（技术部分管）",
		scope: "association",
		department: null,
		rank: 92
	},
	{
		roleName: "position-association-vice-chair-clinic",
		label: "协会副主席（电脑诊所分管）",
		scope: "association",
		department: null,
		rank: 92
	},
	{
		roleName: "position-association-vice-chair-digimedia",
		label: "协会副主席（数字媒体中心分管）",
		scope: "association",
		department: null,
		rank: 92
	},
	{
		roleName: "position-techdept-head",
		label: "技术部部长",
		scope: "department",
		department: "techdept",
		rank: 80
	},
	{
		roleName: "position-techdept-deputy-head",
		label: "技术部副部长",
		scope: "department",
		department: "techdept",
		rank: 70
	},
	{
		roleName: "position-techdept-advisor",
		label: "技术部顾问",
		scope: "department",
		department: "techdept",
		rank: 60
	},
	{
		roleName: "position-techdept-member",
		label: "技术部成员",
		scope: "department",
		department: "techdept",
		rank: 10
	},
	{
		roleName: "position-clinic-head",
		label: "电脑诊所部长",
		scope: "department",
		department: "clinic",
		rank: 80
	},
	{
		roleName: "position-clinic-deputy-head",
		label: "电脑诊所副部长",
		scope: "department",
		department: "clinic",
		rank: 70
	},
	{
		roleName: "position-clinic-advisor",
		label: "电脑诊所顾问",
		scope: "department",
		department: "clinic",
		rank: 60
	},
	{
		roleName: "position-clinic-member",
		label: "电脑诊所成员",
		scope: "department",
		department: "clinic",
		rank: 10
	},
	{
		roleName: "position-digimedia-head",
		label: "数字媒体中心部长",
		scope: "department",
		department: "digimedia",
		rank: 80
	},
	{
		roleName: "position-digimedia-deputy-head",
		label: "数字媒体中心副部长",
		scope: "department",
		department: "digimedia",
		rank: 70
	},
	{
		roleName: "position-digimedia-advisor",
		label: "数字媒体中心顾问",
		scope: "department",
		department: "digimedia",
		rank: 60
	},
	{
		roleName: "position-digimedia-member",
		label: "数字媒体中心成员",
		scope: "department",
		department: "digimedia",
		rank: 10
	},
	{
		roleName: "position-techsvc-director",
		label: "技术保障中心主任",
		scope: "department",
		department: "techsvc",
		rank: 80
	},
	{
		roleName: "position-techsvc-deputy-director",
		label: "技术保障中心副主任",
		scope: "department",
		department: "techsvc",
		rank: 70
	},
	{
		roleName: "position-techsvc-member",
		label: "技术保障中心成员",
		scope: "department",
		department: "techsvc",
		rank: 10
	}
].map((position) => Object.freeze(position)));
function positionForRole(role) {
	return POSITIONS.find((position) => position.roleName === role);
}
function positionsFromRoles(roles) {
	let association;
	const byDepartment = /* @__PURE__ */ new Map();
	for (const role of roles) {
		if (typeof role !== "string") continue;
		const position = positionForRole(role);
		if (position === void 0) continue;
		if (position.scope === "association") {
			if (association === void 0 || position.rank > association.rank) association = position;
		} else {
			const current = byDepartment.get(position.department);
			if (current === void 0 || position.rank > current.rank) byDepartment.set(position.department, position);
		}
	}
	const selected = association === void 0 ? [] : [association];
	for (const department of DEPARTMENTS) {
		const position = byDepartment.get(department);
		if (position !== void 0) selected.push(position);
	}
	return Object.freeze(selected.map(toView));
}
function toView(position) {
	const { roleName, rank: _rank, ...view } = position;
	return Object.freeze({
		code: roleName,
		...view
	});
}
//#endregion
//#region src/permissions.ts
function fromRoles(roles) {
	const roleSet = new Set(roles);
	const systemAdmin = roleSet.has(SYSTEM_ADMIN_ROLE);
	const accessDepartments = DEPARTMENTS.filter((department) => roleSet.has(accessRole(department)));
	const managedDepartments = DEPARTMENTS.filter((department) => roleSet.has(adminRole(department)));
	const manager = systemAdmin || managedDepartments.length > 0;
	return Object.freeze({
		admitted: manager || accessDepartments.length > 0,
		systemAdmin,
		manager,
		accessDepartments: Object.freeze(accessDepartments),
		managedDepartments: Object.freeze(managedDepartments),
		positions: positionsFromRoles(roles)
	});
}
function fromClaims(claims) {
	return fromRoles(realmRolesFromClaims(claims));
}
//#endregion
export { DEPARTMENTS, POSITIONS, SYSTEM_ADMIN_ROLE, accessRole, adminRole, departmentLabel, fromClaims, fromRoles, permissionRoles, positionForRole, positionsFromRoles, realmRolesFromClaims, recognizedRoles, unrecognizedPermissionRoles };
