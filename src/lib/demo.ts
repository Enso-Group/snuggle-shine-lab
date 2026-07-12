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

export const DEMO_MODE = true;

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
  { id: "demo-conv-1", name: "Dana Cohen", whapi_chat_id: contactChatId("972501234567"), is_group: false, last_message_at: minsAgo(4) },
  { id: "demo-conv-2", name: "VIP Customers", whapi_chat_id: GROUPS[0].id, is_group: true, last_message_at: minsAgo(18) },
  { id: "demo-conv-3", name: "Yossi Levi", whapi_chat_id: contactChatId("972502345678"), is_group: false, last_message_at: hoursAgo(1) },
  { id: "demo-conv-4", name: "Michal Abraham", whapi_chat_id: contactChatId("972503456789"), is_group: false, last_message_at: hoursAgo(3) },
  { id: "demo-conv-5", name: "Sales Team", whapi_chat_id: GROUPS[1].id, is_group: true, last_message_at: hoursAgo(5) },
  { id: "demo-conv-6", name: "Avi Friedman", whapi_chat_id: contactChatId("972504567890"), is_group: false, last_message_at: hoursAgo(9) },
  { id: "demo-conv-7", name: "Noa Shapira", whapi_chat_id: contactChatId("972505678901"), is_group: false, last_message_at: daysAgo(1) },
  { id: "demo-conv-8", name: "Product Updates", whapi_chat_id: GROUPS[2].id, is_group: true, last_message_at: daysAgo(2) },
];

type DemoMsg = { id: string; direction: string; sender_name: string | null; body: string | null; created_at: string };

const CONVERSATION_SCRIPTS: Record<string, Array<[dir: "in" | "out", name: string, body: string, mins: number]>> = {
  "demo-conv-1": [
    ["in", "Dana Cohen", "Hi, can I get details about the business package?", 60],
    ["out", "Bot", "Sure! The business package includes automatic conversation management, message scheduling, and reports. Want me to send a price list?", 59],
    ["in", "Dana Cohen", "Yes please", 58],
    ["out", "Bot", "Great, I sent you an email with all the details 😊 Is there anything else I can help with?", 57],
    ["in", "Dana Cohen", "Perfect, thank you so much!", 4],
  ],
  "demo-conv-2": [
    ["in", "Ron Biton", "When does the new sale start?", 40],
    ["out", "Bot", "The sale goes live this coming Sunday, with 20% off for all VIP members 🎉", 39],
    ["in", "Shira Mizrahi", "Can you set an item aside for me in advance?", 20],
    ["out", "Bot", "Of course Shira, I've set one aside. We'll let you know the moment the sale opens.", 18],
  ],
  "demo-conv-3": [
    ["in", "Yossi Levi", "My order still hasn't arrived", 70],
    ["out", "Bot", "Sorry to hear that! I checked — the shipment went out yesterday and should arrive today by the evening 📦", 69],
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
  { id: "demo-log-1", prompt: "Send sale reminder to the VIP group", target_chat_id: GROUPS[0].id, target_name: "VIP Customers", result: "Good morning! A reminder that this week's sale starts today ☀️", status: "sent", created_at: minsAgo(12) },
  { id: "demo-log-2", prompt: "AI reply to a customer", target_chat_id: contactChatId("972501234567"), target_name: "Dana Cohen", result: "I sent you an email with all the details 😊", status: "sent", created_at: minsAgo(57) },
  { id: "demo-log-3", prompt: "Scheduled message (AI)", target_chat_id: GROUPS[2].id, target_name: "Product Updates", result: "Waiting for admin approval", status: "pending", created_at: hoursAgo(2) },
  { id: "demo-log-4", prompt: "Send sales summary", target_chat_id: GROUPS[1].id, target_name: "Sales Team", result: "Weekly sales targets summary — great work! 💪", status: "sent", created_at: hoursAgo(6) },
  { id: "demo-log-5", prompt: "AI reply to a customer", target_chat_id: contactChatId("972502345678"), target_name: "Yossi Levi", result: "The shipment went out yesterday and should arrive today by the evening 📦", status: "sent", created_at: hoursAgo(9) },
  { id: "demo-log-6", prompt: "Manual send", target_chat_id: contactChatId("972509012345"), target_name: "Tal Rosen", result: "Whapi 429: rate limit — try again", status: "error", created_at: daysAgo(1) },
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
    "google/gemini-2.5-flash": { calls: 468, promptTokens: 286_400, completionTokens: 128_900, totalTokens: 415_300, cost: 0.5217 },
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
  { id: "demo-thread-1", title: "Testing the bot's style", mode: "test-bot", updated_at: minsAgo(10) },
  { id: "demo-thread-2", title: "How many chats this week?", mode: "admin", updated_at: hoursAgo(2) },
  { id: "demo-thread-3", title: "Holiday campaign ideas", mode: "general", updated_at: daysAgo(1) },
];

const THREAD_MESSAGES: Record<string, Array<[role: "user" | "assistant", content: string, mins: number]>> = {
  "demo-thread-1": [
    ["user", "Write in the bot's style: a customer asks if you're open on Friday", 12],
    ["assistant", "Hi! On Friday we're here until 2 PM, then we're back Sunday morning 🙂 Anything I can help with before then?", 12],
  ],
  "demo-thread-2": [
    ["user", "How many active chats did we have this week?", 120],
    ["assistant", "This week there were 128 active chats, 41 of them in groups. The most active: \"VIP Customers\". Want a breakdown by day?", 119],
  ],
  "demo-thread-3": [
    ["user", "Give me 3 ideas for a holiday message to customers", 1440],
    ["assistant", "1) \"Happy holidays! We've prepared 15% off just for the holiday 🎁\"\n2) \"Wishing you a holiday of calm and light — and see you with lots of news soon ✨\"\n3) \"A little holiday gift inside — take a peek?\"", 1439],
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
    matchReason: "Mentioned 5 years of experience with React and TypeScript, and is looking for a new challenge.",
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
