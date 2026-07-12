// The single administrator is identified by email. This person sees the
// behind-the-scenes pages (Instructions, Settings, Usage & Costs, Logs,
// Approval Requests) and can approve/reject new users.
export const ADMIN_EMAIL = "itamar.lw@icloud.com";

export function isAdminEmail(email: string | null | undefined): boolean {
  return (email ?? "").trim().toLowerCase() === ADMIN_EMAIL;
}
