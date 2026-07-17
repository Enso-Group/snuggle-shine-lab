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
    return { ok: true };
  });

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
