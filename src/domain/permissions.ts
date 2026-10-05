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
  "ticketing.payments.manage",
  "ticketing.refunds.create",
  "ticketing.scan",
  "ticketing.credentials.manage",
  "ticketing.keys.manage",
  /** Run 20: anonymize a buyer on request (Québec Law 25). Irreversible: owner and admin only. */
  "ticketing.buyers.erase",
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
  "ticketing.refunds.create",
  "ticketing.scan",
  "ticketing.credentials.manage",
];

/**
 * Role → Ticketing permissions. Matches the RLS policies: buyer data, order money and
 * refunds for owner/admin/manager; audit and the Client's Stripe account for owner/admin.
 */
const ROLE_PERMISSIONS: Record<WorkspaceRole, ReadonlySet<TicketingPermission>> = {
  owner: new Set<TicketingPermission>([...MANAGE, "ticketing.audit.read", "ticketing.payments.manage", "ticketing.keys.manage", "ticketing.buyers.erase"]),
  admin: new Set<TicketingPermission>([...MANAGE, "ticketing.audit.read", "ticketing.payments.manage", "ticketing.keys.manage", "ticketing.buyers.erase"]),
  manager: new Set<TicketingPermission>(MANAGE),
  editor: new Set<TicketingPermission>([...READ_CATALOG, "ticketing.catalog.write"]),
  // Gate staff scan tickets; they never see buyer data.
  staff: new Set<TicketingPermission>([...READ_CATALOG, "ticketing.scan"]),
  viewer: new Set<TicketingPermission>(READ_CATALOG),
};

export function isWorkspaceRole(value: string): value is WorkspaceRole {
  return (WORKSPACE_ROLES as readonly string[]).includes(value);
}

export function roleHasPermission(role: WorkspaceRole, permission: TicketingPermission): boolean {
  return ROLE_PERMISSIONS[role].has(permission);
}
