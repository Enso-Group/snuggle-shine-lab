// Administrators are identified by email. They see the behind-the-scenes pages
// (Instructions, Settings, Usage & Costs, Logs, User Management) and can manage
// the invite list. Everyone else who is invited is a regular "editor" user.
export const ADMIN_EMAILS = [
  "itamar.lw@icloud.com",
  "itamarlw2011@gmail.com",
] as const;

// Back-compat for any code importing the old single-value constant.
export const ADMIN_EMAIL = ADMIN_EMAILS[0];

export function isAdminEmail(email: string | null | undefined): boolean {
  const normalized = (email ?? "").trim().toLowerCase();
  return (ADMIN_EMAILS as readonly string[]).includes(normalized);
}
