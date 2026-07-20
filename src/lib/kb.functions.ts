// Knowledge-base CRUD for the dashboard. Admin-only; the bot reads this data
// through src/lib/agent/kb.server.ts and may only state business facts that
// appear here.
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAdmin } from "@/integrations/supabase/admin-middleware";
import { z } from "zod";

export type KnowledgeItem = {
  id: string;
  kind: string;
  title: string;
  content: string;
  url: string | null;
  active: boolean;
  updated_at: string;
  created_at: string;
};

const KINDS = ["fact", "product", "price", "policy", "faq", "link", "doc"] as const;

export const listKnowledge = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAdmin])
  .handler(async (): Promise<KnowledgeItem[]> => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin
      .from("knowledge_base")
      .select("id, kind, title, content, url, active, updated_at, created_at")
      .order("updated_at", { ascending: false })
      .limit(500);
    if (error) throw new Error(error.message);
    return (data ?? []) as KnowledgeItem[];
  });

export const saveKnowledgeItem = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAdmin])
  .inputValidator((d: unknown) =>
    z
      .object({
        id: z.string().uuid().optional(),
        kind: z.enum(KINDS),
        title: z.string().min(1).max(200),
        content: z.string().min(1).max(4000),
        url: z.string().url().max(500).optional().or(z.literal("")),
        active: z.boolean().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }): Promise<KnowledgeItem> => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const patch = {
      kind: data.kind,
      title: data.title.trim(),
      content: data.content.trim(),
      url: data.url?.trim() || null,
      ...(data.active !== undefined ? { active: data.active } : {}),
      updated_at: new Date().toISOString(),
    };
    const query = data.id
      ? supabaseAdmin.from("knowledge_base").update(patch).eq("id", data.id)
      : supabaseAdmin.from("knowledge_base").insert(patch);
    const { data: row, error } = await query
      .select("id, kind, title, content, url, active, updated_at, created_at")
      .single();
    if (error) throw new Error(error.message);
    return row as KnowledgeItem;
  });

export const setKnowledgeActive = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAdmin])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid(), active: z.boolean() }).parse(d))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin
      .from("knowledge_base")
      .update({ active: data.active, updated_at: new Date().toISOString() })
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const deleteKnowledgeItem = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAdmin])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.from("knowledge_base").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
