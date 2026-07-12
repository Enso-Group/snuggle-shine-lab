import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import { isAdminEmail } from "./admin";

// Only the admin email may manage user approvals.
function assertAdmin(context: any) {
  const email = context?.claims?.email as string | undefined;
  if (!isAdminEmail(email)) throw new Error("Forbidden: admin only");
}

export type PendingUser = { id: string; email: string; created_at: string };

// A user is "approved" once they have any row in user_roles. Pending users have
// none. The admin email is always considered approved and is never listed.
export const listPendingUsers = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<PendingUser[]> => {
    assertAdmin(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: roleRows } = await supabaseAdmin.from("user_roles").select("user_id");
    const approved = new Set((roleRows ?? []).map((r: any) => r.user_id));

    const pending: PendingUser[] = [];
    let page = 1;
    // Paginate through auth users.
    for (;;) {
      const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 200 });
      if (error) throw new Error(error.message);
      const users = data?.users ?? [];
      for (const u of users) {
        if (approved.has(u.id)) continue;
        if (isAdminEmail(u.email)) continue;
        pending.push({ id: u.id, email: u.email ?? "(no email)", created_at: u.created_at });
      }
      if (users.length < 200) break;
      page += 1;
    }
    pending.sort((a, b) => b.created_at.localeCompare(a.created_at));
    return pending;
  });

// Approve = grant a role row (which the app treats as "approved" and which the
// existing RLS/server checks already recognize).
export const approveUser = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { userId: string }) => z.object({ userId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    assertAdmin(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin
      .from("user_roles")
      .insert({ user_id: data.userId, role: "admin" });
    // Ignore duplicate (already approved).
    if (error && !String(error.message).toLowerCase().includes("duplicate")) {
      throw new Error(error.message);
    }
    return { ok: true };
  });

// Reject = delete the account entirely (its dashboard data cascades). The person
// can register again later if they wish, and will show up as pending again.
export const rejectUser = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { userId: string }) => z.object({ userId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    assertAdmin(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.auth.admin.deleteUser(data.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
