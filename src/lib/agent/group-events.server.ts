// Group membership events from the Whapi webhook ("groups" event type):
// member joins → tracked + personalized welcome; leaves/removals → tracked.
import { callLLM } from "@/lib/llm.server";
import { logDecision } from "./decisions.server";
import { loadGroupProfile } from "./groups.server";
import { sanitizeParts } from "./stages.server";
import type { AgentDeps, AgentSettings } from "./types";

export type GroupParticipantEvent = {
  groupChatId: string;
  action: "add" | "remove" | "request" | "promote" | "demote";
  participants: Array<{ id: string; name?: string }>;
};

/** Liberal parser for Whapi group webhook payload variants. */
export function parseGroupEvents(payload: Record<string, unknown>): GroupParticipantEvent[] {
  const out: GroupParticipantEvent[] = [];
  const raw =
    (Array.isArray(payload.groups_participants) && payload.groups_participants) ||
    (Array.isArray(payload.groups) && payload.groups) ||
    [];
  for (const ev of raw as Array<Record<string, unknown>>) {
    const groupChatId = String(ev.id ?? ev.group_id ?? ev.chat_id ?? "");
    if (!groupChatId.endsWith("@g.us")) continue;
    const action = String(ev.action ?? ev.type ?? "");
    if (!["add", "remove", "request", "promote", "demote"].includes(action)) continue;
    const list = Array.isArray(ev.participants) ? ev.participants : [];
    const participants = list
      .map((p: unknown) =>
        typeof p === "string"
          ? { id: p }
          : {
              id: String((p as Record<string, unknown>).id ?? ""),
              name: (p as Record<string, unknown>).name as string | undefined,
            },
      )
      .filter((p) => p.id);
    if (participants.length) {
      out.push({ groupChatId, action: action as GroupParticipantEvent["action"], participants });
    }
  }
  return out;
}

export async function handleGroupEvent(
  deps: AgentDeps,
  settings: AgentSettings,
  event: GroupParticipantEvent,
): Promise<{ action: string }> {
  const { supabase } = deps;
  const profile = await loadGroupProfile(supabase, event.groupChatId);

  // Track membership regardless of profile — cheap, and Phase 4 analytics use it.
  for (const p of event.participants) {
    try {
      if (event.action === "add") {
        await supabase.from("group_members").upsert(
          {
            group_chat_id: event.groupChatId,
            wa_id: p.id,
            display_name: p.name ?? null,
            joined_at: new Date().toISOString(),
            left_at: null,
            removed: false,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "group_chat_id,wa_id" },
        );
      } else if (event.action === "remove") {
        await supabase
          .from("group_members")
          .update({ left_at: new Date().toISOString(), updated_at: new Date().toISOString() })
          .eq("group_chat_id", event.groupChatId)
          .eq("wa_id", p.id);
      }
    } catch (e) {
      console.warn("[group-events] member tracking failed:", e);
    }
  }

  if (!profile?.enabled) return { action: "tracked" };

  // Personalized welcome for joins.
  if (event.action === "add" && profile.welcome.enabled) {
    const names = event.participants
      .map((p) => p.name || p.id.replace(/@.*$/, ""))
      .slice(0, 5)
      .join(", ");
    let welcome = "";
    try {
      const res = await callLLM({
        role: "fast",
        source: "agent_welcome",
        overrides: { model_strong: settings.model_strong, model_fast: settings.model_fast },
        messages: [
          {
            role: "system",
            content: `כתוב הודעת ברוכים הבאים קצרה וחמה (1-2 משפטים) לחברים חדשים בקבוצת וואטסאפ, בשפה ${profile.language}.
מטרת הקבוצה: ${profile.purpose ?? "קהילה"}. ${profile.welcome.hint ? `הנחיה מהמנהל: ${profile.welcome.hint}` : ""}
פנה אליהם בשמם, הסבר במשפט מה עושים כאן, בלי חפירות. החזר רק את הטקסט.`,
          },
          { role: "user", content: `הצטרפו עכשיו: ${names}` },
        ],
      });
      welcome = sanitizeParts([res.content.trim()]).parts[0] ?? "";
    } catch (e) {
      console.warn("[group-events] welcome draft failed:", e);
    }
    if (welcome) {
      try {
        await deps.whapi.sendText(event.groupChatId, welcome);
        await supabase.from("moderation_actions").insert({
          group_chat_id: event.groupChatId,
          target_wa_id: event.participants[0]?.id ?? null,
          target_name: names,
          action: "welcome",
          reasoning: "חבר/ה חדש/ה בקבוצה",
          status: "done",
        });
        logDecision(supabase, {
          chat_id: event.groupChatId,
          trigger: deps.trigger,
          stage: "welcome",
          summary: `ברכת הצטרפות נשלחה ל: ${names}`,
          data: { welcome },
        });
        return { action: "welcomed" };
      } catch (e) {
        console.warn("[group-events] welcome send failed:", e);
      }
    }
  }
  return { action: "tracked" };
}
