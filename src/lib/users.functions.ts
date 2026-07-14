import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import { isAdminEmail } from "./admin";

// Only the admin email may manage user approvals.
function assertAdmin(context: any) {
  const email = context?.claims?.email as string | undefined;
  if (!isAdminEmail(email)) throw new Error("Forbidden: admin only");
}

export type AppRole = "admin" | "manager" | "user";
export type PendingUser = { id: string; email: string; created_at: string };
export type ManagedUser = {
  id: string;
  email: string;
  created_at: string;
  role: AppRole | null; // null = pending (not approved yet)
  isAdminEmail: boolean;
};

const ROLE_RANK: Record<string, number> = { admin: 3, manager: 2, user: 1 };

async function listAuthUsers(supabaseAdmin: any) {
  const all: any[] = [];
  let page = 1;
  for (;;) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(error.message);
    const users = data?.users ?? [];
    all.push(...users);
    if (users.length < 200) break;
    page += 1;
  }
  return all;
}

// All registered users with their status + role, for the User Management page.
export const listAllUsers = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<ManagedUser[]> => {
    assertAdmin(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: roleRows } = await supabaseAdmin.from("user_roles").select("user_id, role");
    const roleByUser = new Map<string, string>();
    for (const r of roleRows ?? []) {
      const cur = roleByUser.get(r.user_id);
      if (!cur || (ROLE_RANK[r.role] ?? 0) > (ROLE_RANK[cur] ?? 0)) roleByUser.set(r.user_id, r.role);
    }

    const users = await listAuthUsers(supabaseAdmin);
    const out: ManagedUser[] = users.map((u) => ({
      id: u.id,
      email: u.email ?? "(no email)",
      created_at: u.created_at,
      role: (roleByUser.get(u.id) as AppRole | undefined) ?? null,
      isAdminEmail: isAdminEmail(u.email),
    }));
    out.sort((a, b) => b.created_at.localeCompare(a.created_at));
    return out;
  });

// Assign a role (this also "approves" a pending user). One role per user.
export const setUserRole = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { userId: string; role: AppRole }) =>
    z.object({ userId: z.string().uuid(), role: z.enum(["admin", "manager", "user"]) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    assertAdmin(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await supabaseAdmin.from("user_roles").delete().eq("user_id", data.userId);
    const { error } = await supabaseAdmin
      .from("user_roles")
      .insert({ user_id: data.userId, role: data.role as any });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// Remove all roles -> user goes back to pending (loses access).
export const setUserPending = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { userId: string }) => z.object({ userId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    assertAdmin(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.from("user_roles").delete().eq("user_id", data.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

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
