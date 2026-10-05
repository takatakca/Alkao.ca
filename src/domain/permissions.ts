/** TAKATAK WorkspaceRole (takatak-v1 prisma/schema.prisma enum WorkspaceRole). */
export const WORKSPACE_ROLES = ["owner", "admin", "manager", "editor", "staff", "viewer"] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

export const TICKETING_PERMISSIONS = [
  "ticketing.catalog.read",
  "ticketing.catalog.write",
  "ticketing.inventory.read",
  "ticketing.holds.read",
  "ticketing.orders.read",
  "ticketing.buyers.read",
  "ticketing.audit.read",
] as const;
export type TicketingPermission = (typeof TICKETING_PERMISSIONS)[number];

const READ_CATALOG: TicketingPermission[] = [
  "ticketing.catalog.read",
  "ticketing.inventory.read",
  "ticketing.holds.read",
];
const MANAGE: TicketingPermission[] = [
  ...READ_CATALOG,
  "ticketing.catalog.write",
  "ticketing.orders.read",
  "ticketing.buyers.read",
];

/**
 * Role → Ticketing permissions. Matches the RLS policies: buyer data and order money for
 * owner/admin/manager; audit for owner/admin.
 */
const ROLE_PERMISSIONS: Record<WorkspaceRole, ReadonlySet<TicketingPermission>> = {
  owner: new Set<TicketingPermission>([...MANAGE, "ticketing.audit.read"]),
  admin: new Set<TicketingPermission>([...MANAGE, "ticketing.audit.read"]),
  manager: new Set<TicketingPermission>(MANAGE),
  editor: new Set<TicketingPermission>([...READ_CATALOG, "ticketing.catalog.write"]),
  staff: new Set<TicketingPermission>(READ_CATALOG),
  viewer: new Set<TicketingPermission>(READ_CATALOG),
};

export function isWorkspaceRole(value: string): value is WorkspaceRole {
  return (WORKSPACE_ROLES as readonly string[]).includes(value);
}

export function roleHasPermission(role: WorkspaceRole, permission: TicketingPermission): boolean {
  return ROLE_PERMISSIONS[role].has(permission);
}
