// ---------------------------------------------------------------------------
// DEMO MODE — self-contained sample data for product demos / screen recordings.
//
// HOW IT WORKS
//   Flip DEMO_MODE to true to fill the UI with realistic fake data WITHOUT a
//   WhatsApp connection and WITHOUT touching the database. When false, the app
//   behaves exactly as in production.
//
// HOW TO REMOVE
//   1. Set DEMO_MODE = false (instant off), or
//   2. Delete this file and remove the `DEMO_MODE ? demo... :` guards that
//      reference "@/lib/demo" across src/routes and src/hooks.
//
// Nothing here writes to the DB or calls any external service.
// ---------------------------------------------------------------------------

export const DEMO_MODE = false;

// --- relative timestamps so the data always looks fresh -----------------------
const now = Date.now();
const minsAgo = (m: number) => new Date(now - m * 60_000).toISOString();
const hoursAgo = (h: number) => new Date(now - h * 3_600_000).toISOString();
const daysAgo = (d: number) => new Date(now - d * 86_400_000).toISOString();

// --- people & groups ----------------------------------------------------------
const CONTACTS = [
  { phone: "972501234567", name: "Dana Cohen" },
  { phone: "972502345678", name: "Yossi Levi" },
  { phone: "972503456789", name: "Michal Abraham" },
  { phone: "972504567890", name: "Avi Friedman" },
  { phone: "972505678901", name: "Noa Shapira" },
  { phone: "972506789012", name: "Ron Biton" },
  { phone: "972507890123", name: "Shira Mizrahi" },
  { phone: "972508901234", name: "Omer Golan" },
  { phone: "972509012345", name: "Tal Rosen" },
  { phone: "972521112233", name: "Lior Alon" },
];

const GROUPS = [
  { id: "120363011111111111@g.us", name: "VIP Customers" },
  { id: "120363022222222222@g.us", name: "Sales Team" },
  { id: "120363033333333333@g.us", name: "Product Updates" },
  { id: "120363044444444444@g.us", name: "Technical Support" },
  { id: "120363055555555555@g.us", name: "Community Managers" },
];

const contactChatId = (phone: string) => `${phone}@s.whatsapp.net`;

// --- connection (demo pretends a business number is linked) -------------------
export const demoConnection = {
  ok: true,
  status: "AUTH" as const,
  connected: true,
  userName: "Demo Business",
  fullHistory: true,
  error: null,
};

// --- dashboard ----------------------------------------------------------------
export const demoDashboardStats = {
  conversations: 128,
  messages: 3427,
  commands: 214,
};

// --- send / schedule target pickers ------------------------------------------
export const demoWhapiTargets = {
  groups: GROUPS.map((g) => ({ id: g.id, name: g.name })),
  chats: CONTACTS.map((c) => ({ id: contactChatId(c.phone), name: c.name, type: "contact" })),
  contacts: CONTACTS.map((c) => ({ id: contactChatId(c.phone), name: c.name })),
};

// --- chats list ---------------------------------------------------------------
type DemoConv = {
  id: string;
  name: string;
  whapi_chat_id: string;
  is_group: boolean;
  last_message_at: string;
};

export const demoConversations: DemoConv[] = [
  {
    id: "demo-conv-1",
    name: "Dana Cohen",
    whapi_chat_id: contactChatId("972501234567"),
    is_group: false,
    last_message_at: minsAgo(4),
  },
  {
    id: "demo-conv-2",
    name: "VIP Customers",
    whapi_chat_id: GROUPS[0].id,
    is_group: true,
    last_message_at: minsAgo(18),
  },
  {
    id: "demo-conv-3",
    name: "Yossi Levi",
    whapi_chat_id: contactChatId("972502345678"),
    is_group: false,
    last_message_at: hoursAgo(1),
  },
  {
    id: "demo-conv-4",
    name: "Michal Abraham",
    whapi_chat_id: contactChatId("972503456789"),
    is_group: false,
    last_message_at: hoursAgo(3),
  },
  {
    id: "demo-conv-5",
    name: "Sales Team",
    whapi_chat_id: GROUPS[1].id,
    is_group: true,
    last_message_at: hoursAgo(5),
  },
  {
    id: "demo-conv-6",
    name: "Avi Friedman",
    whapi_chat_id: contactChatId("972504567890"),
    is_group: false,
    last_message_at: hoursAgo(9),
  },
  {
    id: "demo-conv-7",
    name: "Noa Shapira",
    whapi_chat_id: contactChatId("972505678901"),
    is_group: false,
    last_message_at: daysAgo(1),
  },
  {
    id: "demo-conv-8",
    name: "Product Updates",
    whapi_chat_id: GROUPS[2].id,
    is_group: true,
    last_message_at: daysAgo(2),
  },
];

type DemoMsg = {
  id: string;
  direction: string;
  sender_name: string | null;
  body: string | null;
  created_at: string;
};

const CONVERSATION_SCRIPTS: Record<
  string,
  Array<[dir: "in" | "out", name: string, body: string, mins: number]>
> = {
  "demo-conv-1": [
    ["in", "Dana Cohen", "Hi, can I get details about the business package?", 60],
    [
      "out",
      "Bot",
      "Sure! The business package includes automatic conversation management, message scheduling, and reports. Want me to send a price list?",
      59,
    ],
    ["in", "Dana Cohen", "Yes please", 58],
    [
      "out",
      "Bot",
      "Great, I sent you an email with all the details 😊 Is there anything else I can help with?",
      57,
    ],
    ["in", "Dana Cohen", "Perfect, thank you so much!", 4],
  ],
  "demo-conv-2": [
    ["in", "Ron Biton", "When does the new sale start?", 40],
    [
      "out",
      "Bot",
      "The sale goes live this coming Sunday, with 20% off for all VIP members 🎉",
      39,
    ],
    ["in", "Shira Mizrahi", "Can you set an item aside for me in advance?", 20],
    [
      "out",
      "Bot",
      "Of course Shira, I've set one aside. We'll let you know the moment the sale opens.",
      18,
    ],
  ],
  "demo-conv-3": [
    ["in", "Yossi Levi", "My order still hasn't arrived", 70],
    [
      "out",
      "Bot",
      "Sorry to hear that! I checked — the shipment went out yesterday and should arrive today by the evening 📦",
      69,
    ],
    ["in", "Yossi Levi", "Great, thanks for the quick update", 61],
  ],
};

const DEFAULT_SCRIPT: Array<[dir: "in" | "out", name: string, body: string, mins: number]> = [
  ["in", "Customer", "Hi, I have a question", 30],
  ["out", "Bot", "Hi! I'm here, how can I help?", 29],
  ["in", "Customer", "I just wanted to check a status", 28],
  ["out", "Bot", "Everything is fine and up to date ✅ Anything else?", 27],
];

export function demoConversationMessages(convId: string): DemoMsg[] {
  const script = CONVERSATION_SCRIPTS[convId] ?? DEFAULT_SCRIPT;
  return script.map(([dir, name, body, mins], i) => ({
    id: `${convId}-m${i}`,
    direction: dir === "out" ? "outbound" : "inbound",
    sender_name: name,
    body,
    created_at: minsAgo(mins),
  }));
}

export function demoConversationMeta(convId: string) {
  const c = demoConversations.find((x) => x.id === convId);
  return { name: c?.name ?? "Chat", whapi_chat_id: c?.whapi_chat_id ?? "" };
}

// --- participants -------------------------------------------------------------
export const demoGroupConversations = GROUPS.map((g) => ({ whapi_chat_id: g.id, name: g.name }));

const PARTICIPANT_LINES = [
  "Thanks for the help!",
  "When does the sale start?",
  "Can I get more details?",
  "Great, sounds excellent",
  "I'm interested in the business package",
  "Joining the meeting tomorrow",
  "I sent the documents",
  "Awesome, thank you so much 🙏",
];

export function demoParticipants(groupId: string) {
  const group = GROUPS.find((g) => g.id === groupId) ?? GROUPS[0];
  const rows = CONTACTS.slice(0, 8).map((c, i) => ({
    sender_id: c.phone,
    sender_name: c.name,
    message_count: 5 + ((i * 7 + 3) % 40),
    last_message_at: hoursAgo(i + 1),
    last_body: PARTICIPANT_LINES[i % PARTICIPANT_LINES.length],
  }));
  return {
    rows,
    groupName: group.name,
    participantsCount: rows.length + 6,
    messagesScanned: 342,
  };
}

export function demoParticipantMessages(senderId: string) {
  const idx = CONTACTS.findIndex((c) => c.phone === senderId);
  const base = idx >= 0 ? idx : 0;
  return Array.from({ length: 5 }).map((_, i) => ({
    id: `demo-pm-${senderId}-${i}`,
    body: PARTICIPANT_LINES[(base + i) % PARTICIPANT_LINES.length],
    created_at: hoursAgo(i + 1),
    source: (i % 2 === 0 ? "live" : "db") as "live" | "db",
  }));
}

// --- weekly scheduler ---------------------------------------------------------
export const demoScheduledMessages = [
  {
    id: "demo-sched-1",
    day_of_week: 0,
    send_time: "09:00:00",
    target_chat_id: GROUPS[0].id,
    target_name: "VIP Customers",
    body: "Good morning! A reminder that this week's sale starts today ☀️",
    mode: "direct",
    enabled: true,
    require_approval: false,
    last_sent_at: daysAgo(7),
  },
  {
    id: "demo-sched-2",
    day_of_week: 3,
    send_time: "12:30:00",
    target_chat_id: GROUPS[2].id,
    target_name: "Product Updates",
    body: "Write a short, friendly update about a new feature released this week",
    mode: "ai",
    enabled: true,
    require_approval: true,
    last_sent_at: daysAgo(4),
  },
  {
    id: "demo-sched-3",
    day_of_week: 4,
    send_time: "17:00:00",
    target_chat_id: GROUPS[1].id,
    target_name: "Sales Team",
    body: "Weekly sales targets summary — great work everyone! 💪",
    mode: "direct",
    enabled: false,
    require_approval: false,
    last_sent_at: null,
  },
];

// --- approvals ----------------------------------------------------------------
export const demoApprovals = [
  {
    id: "demo-appr-1",
    target_chat_id: contactChatId("972503456789"),
    target_name: "Michal Abraham",
    body: "Hi Michal! I saw you were interested in the business package — want to set up a quick call this week?",
    source: "ai_reply",
    created_at: minsAgo(6),
    media: {
      kind: "image",
      url: "/demo/sample-image.png",
      filename: "package-overview.png",
      mime: "image/png",
    },
  },
  {
    id: "demo-appr-2",
    target_chat_id: GROUPS[2].id,
    target_name: "Product Updates",
    body: "Update: this week we launched smart message scheduling — you can now schedule AI messages that are rewritten on every send ✨",
    source: "schedule",
    created_at: minsAgo(35),
  },
  {
    id: "demo-appr-3",
    target_chat_id: contactChatId("972506789012"),
    target_name: "Ron Biton",
    body: "Thanks for reaching out Ron! The support team will get back to you within an hour 🙏",
    source: "manual",
    created_at: hoursAgo(2),
  },
];

// --- logs ---------------------------------------------------------------------
export const demoLogs = [
  {
    id: "demo-log-1",
    prompt: "Send sale reminder to the VIP group",
    target_chat_id: GROUPS[0].id,
    target_name: "VIP Customers",
    result: "Good morning! A reminder that this week's sale starts today ☀️",
    status: "sent",
    created_at: minsAgo(12),
  },
  {
    id: "demo-log-2",
    prompt: "AI reply to a customer",
    target_chat_id: contactChatId("972501234567"),
    target_name: "Dana Cohen",
    result: "I sent you an email with all the details 😊",
    status: "sent",
    created_at: minsAgo(57),
  },
  {
    id: "demo-log-3",
    prompt: "Scheduled message (AI)",
    target_chat_id: GROUPS[2].id,
    target_name: "Product Updates",
    result: "Waiting for admin approval",
    status: "pending",
    created_at: hoursAgo(2),
  },
  {
    id: "demo-log-4",
    prompt: "Send sales summary",
    target_chat_id: GROUPS[1].id,
    target_name: "Sales Team",
    result: "Weekly sales targets summary — great work! 💪",
    status: "sent",
    created_at: hoursAgo(6),
  },
  {
    id: "demo-log-5",
    prompt: "AI reply to a customer",
    target_chat_id: contactChatId("972502345678"),
    target_name: "Yossi Levi",
    result: "The shipment went out yesterday and should arrive today by the evening 📦",
    status: "sent",
    created_at: hoursAgo(9),
  },
  {
    id: "demo-log-6",
    prompt: "Manual send",
    target_chat_id: contactChatId("972509012345"),
    target_name: "Tal Rosen",
    result: "Whapi 429: rate limit — try again",
    status: "error",
    created_at: daysAgo(1),
  },
];

// --- usage & costs ------------------------------------------------------------
const usageSeries = Array.from({ length: 7 }).map((_, i) => {
  const date = new Date(now - (6 - i) * 86_400_000).toISOString().slice(0, 10);
  const calls = 40 + ((i * 13 + 7) % 60);
  return { date, calls, cost: +(calls * 0.0011).toFixed(4), tokens: calls * 820 };
});

export const demoUsageSummary = {
  totals: {
    calls: 512,
    llmCalls: 468,
    toolCalls: 44,
    errorCount: 3,
    totalTokens: 415_300,
    totalCostUsd: 0.5217,
    avgLatencyMs: 940,
  },
  byModel: {
    "google/gemini-2.5-flash": {
      calls: 468,
      promptTokens: 286_400,
      completionTokens: 128_900,
      totalTokens: 415_300,
      cost: 0.5217,
    },
  },
  byTool: {
    web_search: { calls: 38, errors: 1 },
    search_conversations: { calls: 6, errors: 0 },
  },
  series: usageSeries,
};

export const demoUsageFilters = {
  models: ["google/gemini-2.5-flash"],
  tools: ["web_search", "search_conversations"],
};

const SOURCES = ["whatsapp", "schedule", "dashboard", "sourcing"];
export const demoUsageList = {
  page: 1,
  pageSize: 25,
  total: 512,
  rows: Array.from({ length: 12 }).map((_, i) => {
    const isTool = i % 5 === 4;
    const prompt = 380 + ((i * 41) % 900);
    const completion = 120 + ((i * 23) % 400);
    const err = i === 7;
    return {
      id: `demo-usage-${i}`,
      created_at: minsAgo(i * 27 + 3),
      kind: isTool ? "tool" : "llm",
      model: isTool ? null : "google/gemini-2.5-flash",
      tool_name: isTool ? "web_search" : null,
      provider: isTool ? "duckduckgo" : "google",
      source: SOURCES[i % SOURCES.length],
      status: err ? "error" : "success",
      http_status: err ? 429 : 200,
      prompt_tokens: isTool ? null : prompt,
      completion_tokens: isTool ? null : completion,
      total_tokens: isTool ? null : prompt + completion,
      cost_usd: isTool ? null : +((prompt + completion) * 0.0000012).toFixed(6),
      duration_ms: 400 + ((i * 137) % 1600),
      error_message: err ? "rate limit exceeded" : null,
      meta: { step: 0, source: SOURCES[i % SOURCES.length] },
    };
  }),
};

// --- AI chat ------------------------------------------------------------------
export const demoThreads = [
  {
    id: "demo-thread-1",
    title: "Testing the bot's style",
    mode: "test-bot",
    updated_at: minsAgo(10),
  },
  {
    id: "demo-thread-2",
    title: "How many chats this week?",
    mode: "admin",
    updated_at: hoursAgo(2),
  },
  { id: "demo-thread-3", title: "Holiday campaign ideas", mode: "general", updated_at: daysAgo(1) },
];

const THREAD_MESSAGES: Record<
  string,
  Array<[role: "user" | "assistant", content: string, mins: number]>
> = {
  "demo-thread-1": [
    ["user", "Write in the bot's style: a customer asks if you're open on Friday", 12],
    [
      "assistant",
      "Hi! On Friday we're here until 2 PM, then we're back Sunday morning 🙂 Anything I can help with before then?",
      12,
    ],
  ],
  "demo-thread-2": [
    ["user", "How many active chats did we have this week?", 120],
    [
      "assistant",
      'This week there were 128 active chats, 41 of them in groups. The most active: "VIP Customers". Want a breakdown by day?',
      119,
    ],
  ],
  "demo-thread-3": [
    ["user", "Give me 3 ideas for a holiday message to customers", 1440],
    [
      "assistant",
      '1) "Happy holidays! We\'ve prepared 15% off just for the holiday 🎁"\n2) "Wishing you a holiday of calm and light — and see you with lots of news soon ✨"\n3) "A little holiday gift inside — take a peek?"',
      1439,
    ],
  ],
};

export function demoThreadMessages(threadId: string) {
  const thread = demoThreads.find((t) => t.id === threadId) ?? demoThreads[0];
  const script = THREAD_MESSAGES[threadId] ?? [];
  return {
    thread: { id: thread.id, title: thread.title, mode: thread.mode },
    messages: script.map(([role, content, mins], i) => ({
      id: `${threadId}-m${i}`,
      role,
      content,
      created_at: minsAgo(mins),
    })),
  };
}

// --- candidates (talent sourcing) --------------------------------------------
export const demoCandidates = [
  {
    id: "demo-cand-1",
    name: "Adi Sharon",
    role: "Frontend Developer",
    title: "Senior Frontend Engineer",
    company: "Wix",
    companyFull: "Wix.com",
    matchReason:
      "Mentioned 5 years of experience with React and TypeScript, and is looking for a new challenge.",
    groupName: "Community Managers",
    groupId: GROUPS[4].id,
    sourceMessage: "I've worked with React for 5 years, happy to hear about opportunities",
    email: "adi.sharon@example.com",
    phone: "+972 50-123-4567",
    linkedinUrl: "https://linkedin.com/in/adi-sharon",
    enrichedVia: ["apollo", "apify"],
  },
  {
    id: "demo-cand-2",
    name: "Mor Levin",
    role: "Product Manager",
    title: "Product Manager",
    company: "Monday",
    companyFull: "monday.com",
    matchReason: "Wrote about product management in B2B SaaS and leading a team of 6.",
    groupName: "Community Managers",
    groupId: GROUPS[4].id,
    sourceMessage: "Product manager in SaaS, leading a team of 6",
    email: "mor.levin@example.com",
    phone: "+972 52-987-6543",
    linkedinUrl: "https://linkedin.com/in/mor-levin",
    enrichedVia: ["apollo"],
  },
  {
    id: "demo-cand-3",
    name: "Yael Dror",
    role: "Data Scientist",
    title: "Data Scientist",
    company: undefined,
    companyFull: undefined,
    matchReason: "Mentioned working with Python and ML models in fintech.",
    groupName: "Product Updates",
    groupId: GROUPS[2].id,
    sourceMessage: "Working on ML models in fintech, mostly Python",
    linkedinUrl: "https://linkedin.com/in/yael-dror",
    enrichedVia: ["apify"],
  },
];

export const demoSourcingGroups = GROUPS.map((g) => ({ id: g.id, name: g.name }));

// --- overview chart ----------------------------------------------------------
export function demoOverviewSeries(range: "today" | "week" | "month") {
  if (range === "today") {
    return Array.from({ length: 12 }).map((_, i) => ({
      label: `${String(i * 2).padStart(2, "0")}:00`,
      messages: 4 + ((i * 7 + 3) % 28),
    }));
  }
  if (range === "week") {
    const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    return days.map((d, i) => ({ label: d, messages: 38 + ((i * 17 + 11) % 80) }));
  }
  // month: last 30 days
  return Array.from({ length: 30 }).map((_, i) => ({
    label: `${i + 1}`,
    messages: 28 + ((i * 13 + 7) % 90),
  }));
}

// ===========================================================================
// Datasets for the CURRENT five-page structure (Command Center / Activity /
// Profiles / Approvals / Behind the Scenes). Everything below is pure static
// content — no DB, no WhatsApp, no server calls.
// ===========================================================================

const dayStr = (n: number) => new Date(now - n * 86_400_000).toISOString().slice(0, 10);

// --- Command Center: managed groups -----------------------------------------
const demoGroupProfile = (chatId: string, name: string, enabled: boolean, purpose: string) => ({
  id: `demo-profile-${chatId.slice(0, 8)}`,
  chat_id: chatId,
  name,
  enabled,
  instructions:
    "Keep the group active and helpful. Lead with discussion questions, share one practical tip a week, welcome every new member personally.",
  purpose,
  audience: "Startup founders and operators",
  tone: "Professional, warm, no fluff",
  language: "he",
  content_pillars: ["טיפ פרקטי", "שאלה לדיון", "חדשות AI"],
  posting_schedule: [
    { day: 0, time: "09:00", pillar: "טיפ פרקטי" },
    { day: 3, time: "12:30", pillar: "שאלה לדיון" },
  ],
  rules: ["No self-promotion without value", "Keep it respectful"],
  forbidden_topics: ["פוליטיקה"],
  moderation: { enabled: true, delete_violations: true, warn_limit: 2, remove_limit: 3 },
  welcome: { enabled: true, hint: "Welcome warmly, point to the pinned intro post" },
  reply_when_mentioned: true,
  reply_to_questions: true,
  allow_reactive_posts: enabled,
  escalation_rules: "Refunds, legal topics or angry members — alert the owner immediately.",
  kpis: "Replies per post, weekly active members",
  owner_dm: null,
  created_at: daysAgo(30),
  updated_at: hoursAgo(4),
});

export const AI_FOUNDERS = "120363011111111111@g.us";
export const demoManagedGroups = [
  {
    chat_id: AI_FOUNDERS,
    whatsapp_name: "AI Founders IL 🚀",
    profile: demoGroupProfile(
      AI_FOUNDERS,
      "AI Founders IL 🚀",
      true,
      "Community of AI-curious founders; keep it active and helpful",
    ),
  },
  {
    chat_id: GROUPS[0].id.replace("1111", "2222"),
    whatsapp_name: "VIP Customers",
    profile: demoGroupProfile(
      GROUPS[0].id.replace("1111", "2222"),
      "VIP Customers",
      true,
      "Keep VIP customers engaged and informed about launches",
    ),
  },
  {
    chat_id: GROUPS[2].id,
    whatsapp_name: "Product Updates",
    profile: demoGroupProfile(
      GROUPS[2].id,
      "Product Updates",
      false,
      "Announcement channel — bot assists but does not post autonomously",
    ),
  },
];

// --- Command Center: per-group activity -------------------------------------
export function demoGroupActivity(chatId: string) {
  const boost = chatId === AI_FOUNDERS ? 1 : 0.6;
  const stats = [6, 5, 4, 3, 2, 1, 0].map((n, i) => ({
    date: dayStr(n),
    messages: Math.round((42 + i * 9 + (i % 3) * 5) * boost),
    active_members: Math.round((18 + i * 2) * boost),
    bot_posts: i % 2 === 0 ? 1 : 2,
    post_replies: Math.round((6 + i * 3) * boost),
    new_members: i === 4 ? 3 : i % 2,
    left_members: i === 2 ? 1 : 0,
  }));
  return {
    posts: [
      {
        id: `demo-post-up1-${chatId.slice(0, 6)}`,
        source: "schedule",
        pillar: "שאלה לדיון",
        prompt: null,
        body: "סקר שבועי: כמה מהעבודה השיווקית שלכם כבר רצה על AI?",
        status: "queued_approval",
        reasoning: null,
        sent_at: null,
        engagement: {},
        media: null,
        created_at: hoursAgo(3),
      },
      {
        id: `demo-post-up2-${chatId.slice(0, 6)}`,
        source: "schedule",
        pillar: "טיפ פרקטי",
        prompt: null,
        body: "📊 גרף השבוע: ככה נראית קפיצת המעורבות מאז שהבוט מנהל את הקבוצה.",
        status: "queued_approval",
        reasoning: null,
        sent_at: null,
        engagement: {},
        media: { kind: "image", url: "/demo/sample-image.png", filename: "engagement-chart.png" },
        created_at: hoursAgo(2),
      },
      {
        id: `demo-post-s1-${chatId.slice(0, 6)}`,
        source: "reactive",
        pillar: "חדשות AI",
        prompt: null,
        body: "🤖 יצא הדוח השנתי על אימוץ AI בארגונים — 3 מספרים שכדאי להכיר: 67% מהחברות כבר משתמשות ב-GenAI, החיסכון הממוצע הוא 12 שעות עובד בשבוע, ורק 22% מודדות ROI. מי פה כבר מודד?",
        status: "sent",
        reasoning: null,
        sent_at: hoursAgo(26),
        engagement: { replies_24h: Math.round(23 * boost) },
        media: null,
        created_at: hoursAgo(28),
      },
      {
        id: `demo-post-s2-${chatId.slice(0, 6)}`,
        source: "schedule",
        pillar: "טיפ פרקטי",
        prompt: null,
        body: "💡 טיפ למנהלי קהילות: תסיימו כל פוסט בשאלה פתוחה אחת. קבוצות שעושות את זה מקבלות פי 2 תגובות.",
        status: "sent",
        reasoning: null,
        sent_at: hoursAgo(50),
        engagement: { replies_24h: Math.round(14 * boost) },
        media: null,
        created_at: hoursAgo(52),
      },
      {
        id: `demo-post-s3-${chatId.slice(0, 6)}`,
        source: "campaign",
        pillar: "שאלה לדיון",
        prompt: null,
        body: "🔥 שאלת השבוע: איזה תהליך אחד הייתם נותנים לסוכן AI לנהל לבד כבר מחר?",
        status: "sent",
        reasoning: null,
        sent_at: hoursAgo(74),
        engagement: { replies_24h: Math.round(31 * boost) },
        media: null,
        created_at: hoursAgo(75),
      },
    ],
    actions: [
      {
        id: `demo-mod-1-${chatId.slice(0, 6)}`,
        action: "delete",
        target_name: "Spam Account",
        rule_violated: "No self-promotion without value",
        reasoning:
          "Third promotional link with no context this week — removed the message and warned privately.",
        status: "done",
        created_at: hoursAgo(20),
      },
      {
        id: `demo-mod-2-${chatId.slice(0, 6)}`,
        action: "welcome",
        target_name: "Dana Levi",
        rule_violated: null,
        reasoning: "New member welcomed with the pinned intro and this week's discussion thread.",
        status: "done",
        created_at: hoursAgo(8),
      },
    ],
    insights: [
      {
        id: `demo-ins-1-${chatId.slice(0, 6)}`,
        kind: "engagement",
        content:
          "Yesterday's poll drew 19 votes and 11 replies — the strongest engagement this month.",
        created_at: hoursAgo(14),
      },
      {
        id: `demo-ins-2-${chatId.slice(0, 6)}`,
        kind: "topics",
        content:
          "Hot topics this week: AI agents for sales teams, WhatsApp automation, hiring a first ML engineer.",
        created_at: hoursAgo(30),
      },
    ],
    stats,
    memo: {
      week_start: dayStr(6),
      memo: "Engagement is trending up (+38% replies week over week). Discussion questions outperform tips 2:1 — members answer each other, which compounds reach. The Wednesday noon slot is the strongest.",
      recommendations: [
        "Keep two posts per week; lead with a discussion question",
        "Move the practical-tip post to Sunday morning",
        "Welcome new members within the first hour — it doubles their first-week activity",
      ],
      created_at: hoursAgo(20),
    },
  };
}

// --- Command Center: steering chat ------------------------------------------
export function demoCommandReply(message: string): {
  reply: string;
  actions: Array<{ tool: string; summary: string }>;
} {
  const m = message.toLowerCase();
  if (m.includes("week") || m.includes("שבוע") || m.includes("how did")) {
    return {
      reply:
        "Great week for this group 📈 Messages are up 38% and the Wednesday poll was the strongest post this month (31 replies). Discussion questions keep outperforming tips 2:1 — I recommend leading with one every week. Want me to adjust the schedule?",
      actions: [
        {
          tool: "get_group_status",
          summary: "Pulled the last 7 days of stats and the weekly memo",
        },
      ],
    };
  }
  if (m.includes("post") || m.includes("פוסט")) {
    return {
      reply:
        "Done — I planned a post for tomorrow at 09:00 on that topic. It will go through your approval queue first, so you'll see the draft before anything is published.",
      actions: [{ tool: "plan_post", summary: "Planned a scheduled post for tomorrow 09:00" }],
    };
  }
  return {
    reply:
      "Got it — I've updated the group profile accordingly and will apply it starting with the next post. You can see the exact change in the Activity page under Config.",
    actions: [{ tool: "update_group_profile", summary: "Updated the group's instructions" }],
  };
}

// --- Profiles ----------------------------------------------------------------
const demoFact = (text: string, d: number) => ({ text, at: daysAgo(d) });

export const demoPeople = [
  {
    id: "11111111-1111-4111-8111-111111111101",
    wa_id: "972555000101",
    display_name: "Noa Peretz",
    language: "he",
    sentiment: "curious",
    funnel_stage: "lead",
    facts: [
      demoFact("Runs a boutique marketing agency in Tel Aviv", 4),
      demoFact("Asked for pricing for the premium package", 2),
      demoFact("Prefers WhatsApp over email", 2),
    ],
    last_seen_at: hoursAgo(2),
    first_seen_at: daysAgo(5),
  },
  {
    id: "11111111-1111-4111-8111-111111111102",
    wa_id: "972555000202",
    display_name: "Amit Dahan",
    language: "he",
    sentiment: "satisfied",
    funnel_stage: "customer",
    facts: [
      demoFact("Signed the annual retainer in June", 30),
      demoFact("Interested in AI tools for his sales team", 6),
      demoFact("Asked for an interesting AI report", 1),
    ],
    last_seen_at: hoursAgo(6),
    first_seen_at: daysAgo(60),
  },
  {
    id: "11111111-1111-4111-8111-111111111103",
    wa_id: "972555000303",
    display_name: "Maya Golan",
    language: "he",
    sentiment: "enthusiastic",
    funnel_stage: "vip",
    facts: [
      demoFact("Owner of two fitness studios", 45),
      demoFact("Renewed early after strong campaign results", 12),
      demoFact("Wants a monthly performance summary", 3),
    ],
    last_seen_at: daysAgo(1),
    first_seen_at: daysAgo(90),
  },
  {
    id: "11111111-1111-4111-8111-111111111104",
    wa_id: "972555000404",
    display_name: "Daniel Katz",
    language: "en",
    sentiment: "neutral",
    funnel_stage: "lead",
    facts: [
      demoFact("Found us through the AI Founders group", 1),
      demoFact("Comparing us with two other agencies", 1),
    ],
    last_seen_at: hoursAgo(20),
    first_seen_at: daysAgo(1),
  },
  {
    id: "11111111-1111-4111-8111-111111111105",
    wa_id: "972555000505",
    display_name: "Shir Aloni",
    language: "he",
    sentiment: "happy",
    funnel_stage: "community",
    facts: [demoFact("Active member in AI Founders — answers other members often", 8)],
    last_seen_at: daysAgo(2),
    first_seen_at: daysAgo(40),
  },
];

export function demoPersonDetail(personId: string) {
  const person = demoPeople.find((p) => p.id === personId) ?? demoPeople[0];
  const timelines: Record<string, Array<[dir: "in" | "out", body: string, h: number]>> = {
    "972555000101": [
      ["in", "היי, אשמח לשמוע על החבילות שלכם", 30],
      ["out", "היי נועה! בשמחה — יש לנו שלוש חבילות ליווי. איזה היקף פעילות יש לכם היום?", 29.9],
      ["in", "בעיקר סושיאל, בערך 4 קמפיינים בחודש", 29.7],
      ["out", "נשמע מתאים לחבילה המורחבת. אשלח לך פירוט מסודר בהמשך היום 🙏", 29.6],
      ["in", "מעולה, תודה!", 2],
    ],
    "972555000202": [
      ["in", "בוקר טוב! יש לך דוח AI מעניין לשלוח לי?", 7],
      ["out", "בוקר אור! בודק את זה עכשיו — אשלח לך אחד ממש שווה בהקדם.", 6.9],
      ["out", "בדקתי — מצאתי דוח מעולה על אימוץ AI בארגונים. שולח אותו אליך 👇", 6.8],
      ["in", "וואו מהיר! תודה רבה", 6.5],
    ],
  };
  const script = timelines[person.wa_id] ?? [
    ["in", "היי, רציתי לבדוק משהו", 26],
    ["out", "היי! כאן, איך אפשר לעזור?", 25.9],
    ["in", "מעולה, אשלח פרטים בהמשך", 25.5],
  ];
  return {
    person,
    timeline: script.map(([dir, body, h]) => ({
      direction: dir === "in" ? "inbound" : "outbound",
      sender_name: dir === "in" ? person.display_name : "Bot",
      body,
      created_at: hoursAgo(h),
    })),
    intents: [
      {
        intent: "Asking about pricing and packages",
        sentiment: "curious",
        urgency: "normal",
        at: hoursAgo(30),
      },
      {
        intent: "Requesting an AI industry report",
        sentiment: "positive",
        urgency: "normal",
        at: hoursAgo(7),
      },
    ],
    groups:
      person.funnel_stage === "community" || person.funnel_stage === "vip"
        ? ["AI Founders IL 🚀"]
        : [],
  };
}

export function demoAskAnswer(question: string): string {
  void question;
  return "Based on the conversation history: she's a warm lead who asked for premium-package pricing two days ago and prefers WhatsApp over email. Best next step — send the detailed package overview she was promised and offer a short call this week. Her replies come fastest in the morning.";
}

// --- Activity feed ------------------------------------------------------------
type DemoStage = {
  stage: string;
  status: string;
  summary: string | null;
  data: Record<string, unknown>;
  duration_ms: number | null;
  created_at: string;
};
type DemoActivityEntry = {
  id: string;
  ts: string;
  kind: string;
  chat_id: string | null;
  chat_name: string | null;
  title: string;
  stages: DemoStage[];
};

const stage = (
  s: string,
  summary: string,
  h: number,
  extra: Partial<DemoStage> = {},
): DemoStage => ({
  stage: s,
  status: "ok",
  summary,
  data: {},
  duration_ms: null,
  created_at: hoursAgo(h),
  ...extra,
});

function demoActivityEntries(): DemoActivityEntry[] {
  return [
    {
      id: "demo-act-reply-1",
      ts: hoursAgo(2),
      kind: "reply",
      chat_id: "972555000101@s.whatsapp.net",
      chat_name: "Noa Peretz",
      title: "Replied in 24s — pricing question answered from the knowledge base",
      stages: [
        stage("received", "DM received — reply target picked 6s after the message", 2.06),
        stage("context", "Loaded 12 history messages + profile with 3 stored facts", 2.05, {
          duration_ms: 140,
        }),
        stage("intent", "Intent: Asking about pricing | Language: he | Urgency: normal", 2.04, {
          duration_ms: 1500,
        }),
        stage("draft", "Answered from the knowledge base — premium package details", 2.03, {
          duration_ms: 7200,
        }),
        stage("deliver", "Sent 1 message(s)", 2.02, {
          data: {
            latency_breakdown: {
              total_from_message_s: 24,
              llm_s: 9,
              queue_wait_s: 8,
              waited_for_target_s: 4,
              attempt: 1,
            },
          },
        }),
      ],
    },
    {
      id: "demo-act-research-1",
      ts: hoursAgo(6.5),
      kind: "reply",
      chat_id: "972555000202@s.whatsapp.net",
      chat_name: "Amit Dahan",
      title: "Promise kept: researched the web and delivered the answer in 3m40s",
      stages: [
        stage(
          "research",
          "Reply promised to check and get back — tracked research job enqueued, answer due within 10 minutes",
          6.9,
        ),
        stage(
          "research",
          "Research done — drafted the promised answer (4 web results, 1 KB item)",
          6.85,
          { duration_ms: 9200 },
        ),
        stage("deliver", "Promised answer delivered 3m40s after the promise", 6.8, {
          data: { promise_to_answer_s: 220, deadline_met: true },
        }),
      ],
    },
    {
      id: "demo-act-post-1",
      ts: hoursAgo(26),
      kind: "post",
      chat_id: AI_FOUNDERS,
      chat_name: "AI Founders IL 🚀",
      title: "Scheduled post published — 23 replies in 24h",
      stages: [stage("post", "Scheduled post published to AI Founders IL — 23 replies in 24h", 26)],
    },
    {
      id: "demo-act-mod-1",
      ts: hoursAgo(20),
      kind: "moderation",
      chat_id: AI_FOUNDERS,
      chat_name: "AI Founders IL 🚀",
      title: "Deleted a promotional message and warned the sender privately",
      stages: [
        stage(
          "moderation",
          "Rule: no self-promotion without value. Third violation this week — message deleted, sender warned in private.",
          20,
        ),
      ],
    },
    {
      id: "demo-act-welcome-1",
      ts: hoursAgo(8),
      kind: "welcome",
      chat_id: AI_FOUNDERS,
      chat_name: "AI Founders IL 🚀",
      title: "Welcomed Dana Levi to the group",
      stages: [
        stage(
          "welcome",
          "Welcomed Dana Levi with the pinned intro and this week's discussion thread",
          8,
        ),
      ],
    },
    {
      id: "demo-act-follow-1",
      ts: hoursAgo(28),
      kind: "follow_up",
      chat_id: "972555000303@s.whatsapp.net",
      chat_name: "Maya Golan",
      title: "Follow-up sent: monthly performance summary reminder",
      stages: [
        stage(
          "follow_up",
          "Lead went quiet after asking for a summary — natural nudge sent, reply received 40 minutes later",
          28,
        ),
      ],
    },
    {
      id: "demo-act-insight-1",
      ts: hoursAgo(30),
      kind: "insight",
      chat_id: AI_FOUNDERS,
      chat_name: "AI Founders IL 🚀",
      title: "Weekly insight: discussion questions outperform tips 2:1",
      stages: [
        stage(
          "insight",
          "Analyzed the week's engagement — recommends leading with discussion questions",
          30,
        ),
      ],
    },
    {
      id: "demo-act-config-1",
      ts: hoursAgo(45),
      kind: "config",
      chat_id: AI_FOUNDERS,
      chat_name: "AI Founders IL 🚀",
      title: "Owner updated the posting schedule via Command Center chat",
      stages: [
        stage("config", "Added Wednesday 12:30 discussion slot per the owner's instruction", 45),
      ],
    },
    {
      id: "demo-act-gate-1",
      ts: hoursAgo(12),
      kind: "gate",
      chat_id: AI_FOUNDERS,
      chat_name: "AI Founders IL 🚀",
      title: "Group message not addressed to the bot — stayed quiet",
      stages: [
        stage(
          "reply_gate",
          "No mention, no reply-to-bot, not an owned question — correct call is silence",
          12,
          { status: "skip" },
        ),
      ],
    },
    {
      id: "demo-act-alert-1",
      ts: hoursAgo(4),
      kind: "alert",
      chat_id: null,
      chat_name: null,
      title: "Alert: research promise needs a human",
      stages: [
        stage(
          "error",
          "No web results and no KB entry for a supplier-pricing question — escalated with an interim update to the contact",
          4,
          { status: "error" },
        ),
      ],
    },
    {
      id: "demo-act-new-1",
      ts: hoursAgo(20),
      kind: "new_contact",
      chat_id: "972555000404@s.whatsapp.net",
      chat_name: "Daniel Katz",
      title: "New contact: Daniel Katz (lead)",
      stages: [
        stage("context", "First conversation — profile created, funnel stage set to lead", 20),
      ],
    },
    {
      id: "demo-act-error-1",
      ts: hoursAgo(33),
      kind: "error",
      chat_id: "972555000101@s.whatsapp.net",
      chat_name: "Noa Peretz",
      title: "LLM request timed out — retried and delivered on attempt 2",
      stages: [
        stage(
          "error",
          "Transient model timeout on attempt 1; the retry answered 50 seconds later. Never-silent held.",
          33,
          { status: "error" },
        ),
      ],
    },
  ];
}

export function demoActivityFeed(range: "day" | "week" | "month", kind: string) {
  const horizonH = range === "day" ? 24 : range === "week" ? 24 * 7 : 24 * 30;
  const all = demoActivityEntries()
    .filter((e) => now - new Date(e.ts).getTime() <= horizonH * 3_600_000)
    .sort((a, b) => b.ts.localeCompare(a.ts));
  const counts: Record<string, number> = {};
  for (const e of all) counts[e.kind] = (counts[e.kind] ?? 0) + 1;
  const entries = kind === "all" ? all : all.filter((e) => e.kind === kind);
  return { entries, counts };
}
