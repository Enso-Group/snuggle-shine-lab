import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import { isAdminEmail } from "./admin";

// Only the admin email may manage the invite list.
function assertAdmin(context: any) {
  const email = context?.claims?.email as string | undefined;
  if (!isAdminEmail(email)) throw new Error("Forbidden: admin only");
}

export type InvitedEmail = { email: string; invited_by: string | null; created_at: string };

// The full invite list (admin only). This is the source of truth for who can
// access the dashboard.
export const listInvitedEmails = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<InvitedEmail[]> => {
    assertAdmin(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await (supabaseAdmin as any)
      .from("invited_emails")
      .select("email, invited_by, created_at")
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return (data ?? []) as InvitedEmail[];
  });

// Invite an email (idempotent). Stored lowercased.
export const addInvitedEmail = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { email: string }) => z.object({ email: z.string().email() }).parse(d))
  .handler(async ({ data, context }) => {
    assertAdmin(context);
    const email = data.email.trim().toLowerCase();
    const invitedBy = (context?.claims?.email as string | undefined)?.toLowerCase() ?? null;
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await (supabaseAdmin as any)
      .from("invited_emails")
      .upsert({ email, invited_by: invitedBy }, { onConflict: "email" });
    if (error) throw new Error(error.message);

    // If this person already has an account, grant the DB role now. RLS checks
    // user_roles, and the auth trigger only fires on first sign-in — without
    // this, someone invited *after* signing up would see empty data.
    await grantRoleIfUserExists(supabaseAdmin, email);
    return { ok: true };
  });

// Find an existing auth user by email and give them the role RLS looks for.
async function grantRoleIfUserExists(supabaseAdmin: any, email: string) {
  let page = 1;
  for (;;) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) return; // non-fatal: the invite itself succeeded
    const users = data?.users ?? [];
    const match = users.find((u: any) => (u.email ?? "").toLowerCase() === email);
    if (match) {
      await supabaseAdmin
        .from("user_roles")
        .insert({ user_id: match.id, role: "admin" })
        .then(() => undefined, () => undefined); // ignore duplicates
      return;
    }
    if (users.length < 200) return;
    page += 1;
  }
}

// Revoke access by removing an email from the list. Existing account data is
// left untouched — the person simply can't get past the access gate anymore.
export const removeInvitedEmail = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { email: string }) => z.object({ email: z.string().email() }).parse(d))
  .handler(async ({ data, context }) => {
    assertAdmin(context);
    const email = data.email.trim().toLowerCase();
    if (isAdminEmail(email)) throw new Error("The admin email can't be removed from the invite list.");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await (supabaseAdmin as any).from("invited_emails").delete().eq("email", email);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
