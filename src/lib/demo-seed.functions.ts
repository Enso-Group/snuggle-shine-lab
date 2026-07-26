// Demo-data seeding for recordings and walkthroughs (admin-gated).
//
// Every seeded row carries the `demo-` marker in its chat/wa id (or a
// demo-system target for alerts), so ONE wipe call removes everything and can
// never touch real data. Seeding always wipes first — it is idempotent.
//
// Safety with the live engines:
//  * the demo group profile is enabled=false → the posting engine never
//    generates for it;
//  * upcoming demo posts are status 'queued_approval' with a future
//    scheduled_for → the drain never sends them, the disabled-profile sweep
//    never fails them;
//  * demo conversations include bot outbound rows → the non-participated
//    cleanup keeps them.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAdmin } from "@/integrations/supabase/admin-middleware";

const DEMO_GROUP = "demo-120363000000000001@g.us";
const SITE = "https://snuggle-shine-lab.lovable.app";

const DM = (digits: string) => `demo-${digits}@s.whatsapp.net`;

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
const daysAhead = (d: number) => new Date(Date.now() + d * 24 * 3_600_000).toISOString();
const dateNDaysAgo = (n: number) =>
  new Date(Date.now() - n * 24 * 3_600_000).toISOString().slice(0, 10);

import { setDemoView, wipeAll, type LooseDb } from "./demo-seed";

export const wipeDemoData = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAdmin])
  .handler(async () => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const db = supabaseAdmin as unknown as LooseDb;
    const { removed, failed } = await wipeAll(db);
    // Presentation mode off — the dashboard shows real data again.
    await setDemoView(db, false);
    return { ok: Object.keys(failed).length === 0, removed, failed };
  });

export const seedDemoData = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAdmin])
  .inputValidator((d: unknown) =>
    z
      .object({})
      .optional()
      .parse(d ?? {}),
  )
  .handler(async ({ context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const admin = supabaseAdmin as unknown as LooseDb;
    await wipeAll(admin);

    const created: Record<string, number> = {};
    const bump = (t: string, n = 1) => (created[t] = (created[t] ?? 0) + n);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const insert = async (table: string, rows: any) => {
      const arr = Array.isArray(rows) ? rows : [rows];
      const { data, error } = await admin.from(table).insert(arr).select("id");
      if (error) throw new Error(`${table}: ${error.message}`);
      bump(table, arr.length);
      return (data ?? []) as Array<{ id: string }>;
    };

    // ---------------- People + DM conversations with real dialogue ----------------
    const peopleSpec = [
      {
        digits: "972555000101",
        name: "Noa Peretz (Demo)",
        stage: "lead",
        sentiment: "curious",
        facts: [
          "Runs a boutique marketing agency in Tel Aviv",
          "Asked for pricing for the premium package",
          "Prefers WhatsApp over email",
        ],
        dialogue: [
          { dir: "in", body: "היי, אשמח לשמוע על החבילות שלכם", h: 30 },
          {
            dir: "out",
            body: "היי נועה! בשמחה — יש לנו שלוש חבילות ליווי. איזה היקף פעילות יש לכם היום?",
            h: 29.9,
          },
          { dir: "in", body: "בעיקר סושיאל, בערך 4 קמפיינים בחודש", h: 29.7 },
          {
            dir: "out",
            body: "נשמע מתאים לחבילה המורחבת. אשלח לך פירוט מסודר בהמשך היום 🙏",
            h: 29.6,
          },
        ],
      },
      {
        digits: "972555000202",
        name: "Amit Dahan (Demo)",
        stage: "customer",
        sentiment: "satisfied",
        facts: [
          "Signed the annual retainer in June",
          "Interested in AI tools for his sales team",
          "Asked for an interesting AI report",
        ],
        dialogue: [
          { dir: "in", body: "בוקר טוב! יש לך דוח AI מעניין לשלוח לי?", h: 6 },
          { dir: "out", body: "בוקר אור! בודק את זה עכשיו — אשלח לך אחד ממש שווה בהקדם.", h: 5.9 },
          {
            dir: "out",
            body: "בדקתי — מצאתי דוח מעולה על אימוץ AI בארגונים. שולח אותו אליך 👇",
            h: 5.8,
          },
        ],
      },
      {
        digits: "972555000303",
        name: "Maya Golan (Demo)",
        stage: "vip",
        sentiment: "enthusiastic",
        facts: [
          "Owner of two fitness studios",
          "Renewed early after strong campaign results",
          "Wants a monthly performance summary",
        ],
        dialogue: [
          { dir: "in", body: "הקמפיין החדש נראה מדהים, תודה!", h: 50 },
          {
            dir: "out",
            body: "איזה כיף לשמוע מאיה! נעדכן אותך עם סיכום ביצועים בתחילת החודש 🙌",
            h: 49.8,
          },
        ],
      },
    ];

    const convIds: Record<string, string> = {};
    for (const p of peopleSpec) {
      const chatId = DM(p.digits);
      const [conv] = await insert("conversations", {
        whapi_chat_id: chatId,
        name: p.name,
        is_group: false,
        inbound_count: p.dialogue.filter((d) => d.dir === "in").length,
        consecutive_outbound: 0,
        blocked: false,
        last_message_at: hoursAgo(Math.min(...p.dialogue.map((d) => d.h))),
        created_at: hoursAgo(Math.max(...p.dialogue.map((d) => d.h)) + 1),
      });
      convIds[p.digits] = conv.id;
      await insert(
        "messages",
        p.dialogue.map((d) => ({
          conversation_id: conv.id,
          direction: d.dir === "in" ? "inbound" : "outbound",
          sender_id: d.dir === "in" ? chatId : "bot",
          sender_name: d.dir === "in" ? p.name : "Bot",
          body: d.body,
          created_at: hoursAgo(d.h),
        })),
      );
      await insert("people", {
        wa_id: `demo-${p.digits}`,
        display_name: p.name,
        language: "he",
        sentiment: p.sentiment,
        funnel_stage: p.stage,
        facts: p.facts.map((text, i) => ({ text, at: hoursAgo(40 - i) })),
        tags: ["demo"],
        first_seen_at: hoursAgo(96),
        last_seen_at: hoursAgo(Math.min(...p.dialogue.map((d) => d.h))),
      });
    }

    // ---------------- Demo group: profile, stats, memo, insights, moderation ----------------
    await insert("group_profiles", {
      chat_id: DEMO_GROUP,
      name: "AI Founders IL (Demo)",
      enabled: false, // demo only — the posting engine must not touch it
      purpose: "Community of AI-curious founders; keep it active and helpful",
      audience: "Startup founders and operators",
      tone: "Professional, warm, no fluff",
      language: "he",
      content_pillars: ["טיפ פרקטי", "שאלה לדיון", "חדשות AI"],
      posting_schedule: [
        { day: 0, time: "09:00", pillar: "טיפ פרקטי" },
        { day: 3, time: "12:30", pillar: "שאלה לדיון" },
      ],
      rules: ["No self-promotion without value", "Keep it respectful"],
      moderation: { enabled: true, delete_violations: true, warn_limit: 2, remove_limit: 3 },
      welcome: { enabled: true, hint: "Welcome warmly, point to the pinned intro post" },
      reply_when_mentioned: true,
      reply_to_questions: true,
    });

    await insert(
      "group_daily_stats",
      [6, 5, 4, 3, 2, 1, 0].map((n, i) => ({
        group_chat_id: DEMO_GROUP,
        date: dateNDaysAgo(n),
        messages: 42 + i * 9 + (i % 3) * 5,
        active_members: 18 + i * 2,
        bot_posts: i % 2 === 0 ? 1 : 2,
        post_replies: 6 + i * 3,
        new_members: i === 4 ? 3 : i % 2,
        left_members: i === 2 ? 1 : 0,
      })),
    );

    await insert("strategy_memos", {
      group_chat_id: DEMO_GROUP,
      week_start: dateNDaysAgo(6),
      memo: "Engagement is trending up (+38% replies week over week). Discussion questions outperform tips 2:1 — members answer each other, which compounds reach. Wednesday noon slot is the strongest.",
      recommendations: [
        "Keep two posts per week; lead with a discussion question",
        "Move the practical-tip post to Sunday morning",
        "Welcome new members within the first hour — it doubles their first-week activity",
      ],
    });

    await insert("group_insights", [
      {
        group_chat_id: DEMO_GROUP,
        kind: "engagement",
        content:
          "Yesterday's poll drew 19 votes and 11 replies — the strongest engagement this month.",
      },
      {
        group_chat_id: DEMO_GROUP,
        kind: "topics",
        content:
          "Hot topics this week: AI agents for sales teams, WhatsApp automation, hiring first ML engineer.",
      },
    ]);

    await insert("moderation_actions", [
      {
        group_chat_id: DEMO_GROUP,
        target_name: "Spam Account (Demo)",
        action: "delete",
        rule_violated: "No self-promotion without value",
        reasoning:
          "Third promotional link with no context this week — removed the message and warned privately.",
        status: "done",
        created_at: hoursAgo(20),
      },
      {
        group_chat_id: DEMO_GROUP,
        target_name: "Dana Levi (Demo)",
        action: "welcome",
        reasoning: "New member welcomed with the pinned intro and this week's discussion thread.",
        status: "done",
        created_at: hoursAgo(8),
      },
    ]);

    // ---------------- Posts: sent with engagement, upcoming with poll/image ----------------
    await insert("planned_posts", [
      {
        group_chat_id: DEMO_GROUP,
        source: "schedule",
        pillar: "טיפ פרקטי",
        body: "💡 טיפ למנהלי קהילות: תייגו שאלה אחת פתוחה בכל פוסט. קבוצות שמסיימות פוסט בשאלה מקבלות פי 2 תגובות.",
        status: "sent",
        sent_at: hoursAgo(26),
        engagement: { replies_24h: 14 },
        created_at: hoursAgo(28),
      },
      {
        group_chat_id: DEMO_GROUP,
        source: "reactive",
        pillar: "חדשות AI",
        body: "🤖 יצא הדוח השנתי על אימוץ AI בארגונים — 3 מספרים שכדאי להכיר: 67% מהחברות כבר משתמשות ב-GenAI, החיסכון הממוצע הוא 12 שעות עובד בשבוע, ורק 22% מודדות ROI. מי פה כבר מודד?",
        status: "sent",
        sent_at: hoursAgo(50),
        engagement: { replies_24h: 23 },
        created_at: hoursAgo(52),
      },
      {
        group_chat_id: DEMO_GROUP,
        source: "campaign",
        pillar: "שאלה לדיון",
        body: "🔥 שאלת השבוע: איזה תהליך אחד הייתם נותנים לסוכן AI לנהל לבד כבר מחר? הכי מעניין — נפרסם סיכום.",
        status: "sent",
        sent_at: hoursAgo(74),
        engagement: { replies_24h: 31 },
        created_at: hoursAgo(75),
      },
    ]);

    // Upcoming #1 — poll post, parked safely as awaiting-approval.
    const [pollPost] = await insert("planned_posts", {
      group_chat_id: DEMO_GROUP,
      source: "schedule",
      pillar: "שאלה לדיון",
      body: "סקר שבועי: כמה מהעבודה השיווקית שלכם כבר רצה על AI?",
      status: "queued_approval",
      scheduled_for: daysAhead(1),
      created_at: hoursAgo(3),
    });
    // Upcoming #2 — image post (media lands only if the migration is applied).
    const [imagePost] = await insert("planned_posts", {
      group_chat_id: DEMO_GROUP,
      source: "schedule",
      pillar: "טיפ פרקטי",
      body: "📊 גרף השבוע: ככה נראית קפיצת המעורבות מאז שהבוט מנהל את הקבוצה. הסיפור המלא בתגובה הראשונה.",
      status: "queued_approval",
      scheduled_for: daysAhead(2),
      created_at: hoursAgo(2),
    });
    try {
      await admin
        .from("planned_posts")
        .update({
          media: {
            kind: "image",
            url: `${SITE}/demo/sample-image.png`,
            filename: "engagement-chart.png",
            mime: "image/png",
          },
        })
        .eq("id", imagePost.id);
    } catch (e) {
      console.warn("[demo] media column not migrated yet — image post seeded without media", e);
    }

    // ---------------- Pending approvals (one DM reply with image, one group poll) ----------------
    const approvals = await insert("scheduled_approvals", [
      {
        user_id: context.userId,
        conversation_id: convIds["972555000101"],
        target_chat_id: DM("972555000101"),
        target_name: "Noa Peretz (Demo)",
        body: "היי נועה! מצורף פירוט החבילה המורחבת שדיברנו עליה — כולל דוגמאות מקמפיינים דומים. אשמח לקבוע שיחה קצרה השבוע 🙌",
        source: "ai_reply",
        status: "pending",
        created_at: hoursAgo(1),
      },
      {
        user_id: context.userId,
        target_chat_id: DEMO_GROUP,
        target_name: "AI Founders IL (Demo)",
        body: "סקר שבועי: כמה מהעבודה השיווקית שלכם כבר רצה על AI?",
        source: "group_post",
        planned_post_id: pollPost.id,
        poll: {
          question: "כמה מהעבודה השיווקית שלכם כבר רצה על AI?",
          options: ["רוב העבודה", "בערך חצי", "רק ניסויים", "עדיין כלום"],
          multi: false,
        },
        status: "pending",
        created_at: hoursAgo(0.5),
      },
    ]);
    try {
      await admin
        .from("scheduled_approvals")
        .update({
          media: {
            kind: "image",
            url: `${SITE}/demo/sample-image.png`,
            filename: "package-overview.png",
            mime: "image/png",
          },
        })
        .eq("id", approvals[0].id);
    } catch (e) {
      console.warn("[demo] media column not migrated yet — approval seeded without media", e);
    }

    // ---------------- Activity: one full reply trace + every standalone kind ----------------
    const replyJobId = crypto.randomUUID();
    const researchJobId = crypto.randomUUID();
    const amitChat = DM("972555000202");
    await insert("bot_decisions", [
      // Grouped DM reply trace (kind: reply)
      {
        job_id: replyJobId,
        conversation_id: convIds["972555000202"],
        chat_id: amitChat,
        trigger: "inbound",
        stage: "received",
        summary: "DM received — reply target picked 6s after the message",
        data: { reply_target_in_s: 6 },
        created_at: hoursAgo(6.05),
      },
      {
        job_id: replyJobId,
        conversation_id: convIds["972555000202"],
        chat_id: amitChat,
        trigger: "inbound",
        stage: "context",
        summary: "Loaded 12 history messages + profile with 3 stored facts",
        duration_ms: 140,
        created_at: hoursAgo(6.04),
      },
      {
        job_id: replyJobId,
        conversation_id: convIds["972555000202"],
        chat_id: amitChat,
        trigger: "inbound",
        stage: "intent",
        summary: "Intent: Asking for an interesting AI report | Language: he | Urgency: normal",
        duration_ms: 1500,
        created_at: hoursAgo(6.03),
      },
      {
        job_id: replyJobId,
        conversation_id: convIds["972555000202"],
        chat_id: amitChat,
        trigger: "inbound",
        stage: "draft",
        summary:
          "Promised to look up a strong report — flagged open_question for the research engine",
        duration_ms: 7200,
        created_at: hoursAgo(6.02),
      },
      {
        job_id: replyJobId,
        conversation_id: convIds["972555000202"],
        chat_id: amitChat,
        trigger: "inbound",
        stage: "deliver",
        summary: "Sent 1 message(s)",
        data: {
          latency_breakdown: {
            total_from_message_s: 24,
            llm_s: 9,
            queue_wait_s: 8,
            waited_for_target_s: 4,
            attempt: 1,
          },
        },
        created_at: hoursAgo(6.01),
      },
      // Research promise trail (kind: reply-adjacent, shows the 10-min engine)
      {
        job_id: researchJobId,
        conversation_id: convIds["972555000202"],
        chat_id: amitChat,
        trigger: "research",
        stage: "research",
        summary: "Research done — drafted the promised answer (4 web result(s), 1 KB item(s))",
        data: { tavily_results: 4 },
        created_at: hoursAgo(5.95),
      },
      {
        job_id: researchJobId,
        conversation_id: convIds["972555000202"],
        chat_id: amitChat,
        trigger: "research",
        stage: "deliver",
        summary: "Promised answer delivered 3m40s after the promise",
        data: { promise_to_answer_s: 220, deadline_met: true },
        created_at: hoursAgo(5.9),
      },
      // Standalone kinds
      {
        chat_id: DEMO_GROUP,
        trigger: "inbound",
        stage: "reply_gate",
        status: "skip",
        summary: "Group message not addressed to the bot — stayed quiet",
        created_at: hoursAgo(12),
      },
      {
        chat_id: DEMO_GROUP,
        trigger: "scheduled",
        stage: "post",
        summary: "Scheduled post published to AI Founders IL (Demo) — 14 replies in 24h",
        created_at: hoursAgo(26),
      },
      {
        chat_id: DEMO_GROUP,
        trigger: "inbound",
        stage: "moderation",
        summary:
          "Deleted a promotional message (rule: no self-promotion) and warned the sender privately",
        created_at: hoursAgo(20),
      },
      {
        chat_id: DEMO_GROUP,
        trigger: "inbound",
        stage: "welcome",
        summary: "Welcomed Dana Levi to the group with the pinned intro",
        created_at: hoursAgo(8),
      },
      {
        chat_id: DM("972555000303"),
        conversation_id: convIds["972555000303"],
        trigger: "follow_up",
        stage: "follow_up",
        summary: "Follow-up sent: monthly performance summary reminder",
        created_at: hoursAgo(30),
      },
      {
        chat_id: DEMO_GROUP,
        trigger: "scheduled",
        stage: "insight",
        summary: "Weekly insight: discussion questions outperform tips 2:1",
        created_at: hoursAgo(40),
      },
      {
        chat_id: DEMO_GROUP,
        trigger: "scheduled",
        stage: "config",
        summary:
          "Owner updated the posting schedule via Command Center chat — added Wednesday 12:30 discussion slot",
        created_at: hoursAgo(45),
      },
      {
        chat_id: DM("972555000101"),
        conversation_id: convIds["972555000101"],
        trigger: "inbound",
        stage: "error",
        status: "error",
        summary: "LLM request timed out — retried and delivered on attempt 2",
        created_at: hoursAgo(33),
      },
    ]);

    // Alert (kind: alert on the Activity page)
    await insert("commands_log", {
      user_id: context.userId,
      prompt:
        "[ALERT] Research promise needs a human: no web results for 'מחירון ספקים 2026' (chat demo-972555000101@s.whatsapp.net).",
      target_chat_id: "demo-system",
      target_name: "System alert",
      status: "alert",
      result: "Demo alert — the bot escalates to you when it cannot answer a promise on its own.",
      created_at: hoursAgo(4),
    });

    // Follow-up row seeded as SENT: a 'pending' one would be claimed by the
    // live follow-up engine when it comes due — the demo must display the
    // capability, never arm it.
    await insert("follow_ups", {
      conversation_id: convIds["972555000101"],
      chat_id: DM("972555000101"),
      person_wa_id: "demo-972555000101",
      due_at: hoursAgo(30),
      sent_at: hoursAgo(29.5),
      reason: "Lead considering the extended package — nudged after she went quiet",
      status: "sent",
    });

    // Presentation mode ON: dashboard reads now show demo rows only, so no
    // real contact name or number can appear in the recording. The bot keeps
    // handling real traffic in the background; Wipe restores the real view.
    await setDemoView(admin, true);

    return { ok: true, created };
  });
