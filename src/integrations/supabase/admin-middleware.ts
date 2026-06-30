// Admin-only guard. Builds on requireSupabaseAuth (which authenticates the
// caller and exposes context.supabase + context.userId), then verifies the
// caller actually holds the 'admin' role before the handler runs.
//
// IMPORTANT: server functions that touch the service-role client, Whapi, or
// can send WhatsApp messages MUST use this instead of requireSupabaseAuth —
// RLS does not protect service-role calls, so the role check has to happen here.
import { createMiddleware } from "@tanstack/react-start";
import { requireSupabaseAuth } from "./auth-middleware";

export const requireSupabaseAdmin = createMiddleware({ type: "function" })
  .middleware([requireSupabaseAuth])
  .server(async ({ next, context }) => {
    const { data, error } = await context.supabase.rpc("has_role", {
      _user_id: context.userId,
      _role: "admin",
    });
    if (error) throw new Error(error.message);
    if (!data) throw new Error("Forbidden: admin only");
    return next();
  });
