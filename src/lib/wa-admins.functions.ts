// Users & Access → WhatsApp admins: phone numbers that unlock management mode
// over WhatsApp and receive proactive updates. Dashboard-only management —
// deliberately NOT exposed as a tool to the WhatsApp admin agent itself.
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAdmin } from "@/integrations/supabase/admin-middleware";
import { z } from "zod";
import { adminChatId, normalizeAdminPhone, type WaAdmin } from "./agent/wa-admins";

export const listWaAdmins = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAdmin])
  .handler(async (): Promise<WaAdmin[]> => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { loadWaAdmins } = await import("./agent/wa-admins.server");
    return loadWaAdmins(supabaseAdmin);
  });

export const addWaAdmin = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAdmin])
  .inputValidator((d: unknown) =>
    z.object({ phone: z.string().min(5).max(30), label: z.string().min(1).max(80) }).parse(d),
  )
  .handler(async ({ data }): Promise<WaAdmin[]> => {
    const phone = normalizeAdminPhone(data.phone);
    if (!phone) {
      throw new Error("That doesn't look like a valid phone number (use 05… or international digits).");
    }
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { loadWaAdmins, saveWaAdmins } = await import("./agent/wa-admins.server");
    const admins = await loadWaAdmins(supabaseAdmin);
    if (admins.some((a) => a.phone === phone)) {
      throw new Error("That number is already a WhatsApp admin.");
    }
    const next = [
      ...admins,
      { phone, label: data.label.trim(), added_at: new Date().toISOString() },
    ];
    await saveWaAdmins(supabaseAdmin, next);
    const { logDecision } = await import("./agent/decisions.server");
    logDecision(supabaseAdmin, {
      chat_id: adminChatId({ phone, label: data.label }),
      trigger: "scheduled",
      stage: "config",
      summary: `WhatsApp admin added: ${data.label.trim()} (${phone})`,
      data: { admin_phone: phone, admin_label: data.label.trim(), action: "wa_admin_added" },
    });
    return next;
  });

export const removeWaAdmin = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAdmin])
  .inputValidator((d: unknown) => z.object({ phone: z.string().min(5).max(30) }).parse(d))
  .handler(async ({ data }): Promise<WaAdmin[]> => {
    const phone = normalizeAdminPhone(data.phone);
    if (!phone) throw new Error("Invalid phone number.");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { loadWaAdmins, saveWaAdmins } = await import("./agent/wa-admins.server");
    const admins = await loadWaAdmins(supabaseAdmin);
    const removed = admins.find((a) => a.phone === phone);
    if (!removed) return admins;
    const next = admins.filter((a) => a.phone !== phone);
    await saveWaAdmins(supabaseAdmin, next);
    // A pending management command from the removed phone must not execute
    // on the next tick (the processor re-verifies too — belt and suspenders).
    const { supersedeAdminJobsForChat } = await import("./agent/admin-command.server");
    await supersedeAdminJobsForChat(supabaseAdmin, adminChatId(removed));
    const { logDecision } = await import("./agent/decisions.server");
    logDecision(supabaseAdmin, {
      chat_id: adminChatId(removed),
      trigger: "scheduled",
      stage: "config",
      summary: `WhatsApp admin removed: ${removed.label} (${phone})`,
      data: { admin_phone: phone, admin_label: removed.label, action: "wa_admin_removed" },
    });
    return next;
  });
