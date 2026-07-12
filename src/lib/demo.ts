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
  { phone: "972501234567", name: "דנה כהן" },
  { phone: "972502345678", name: "יוסי לוי" },
  { phone: "972503456789", name: "מיכל אברהם" },
  { phone: "972504567890", name: "אבי פרידמן" },
  { phone: "972505678901", name: "נועה שפירא" },
  { phone: "972506789012", name: "רון ביטון" },
  { phone: "972507890123", name: "שירה מזרחי" },
  { phone: "972508901234", name: "עומר גולן" },
  { phone: "972509012345", name: "טל רוזן" },
  { phone: "972521112233", name: "ליאור אלון" },
];

const GROUPS = [
  { id: "120363011111111111@g.us", name: "לקוחות VIP" },
  { id: "120363022222222222@g.us", name: "צוות מכירות" },
  { id: "120363033333333333@g.us", name: "עדכוני מוצר" },
  { id: "120363044444444444@g.us", name: "תמיכה טכנית" },
  { id: "120363055555555555@g.us", name: "מנהלי קהילה" },
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
  { id: "demo-conv-1", name: "דנה כהן", whapi_chat_id: contactChatId("972501234567"), is_group: false, last_message_at: minsAgo(4) },
  { id: "demo-conv-2", name: "לקוחות VIP", whapi_chat_id: GROUPS[0].id, is_group: true, last_message_at: minsAgo(18) },
  { id: "demo-conv-3", name: "יוסי לוי", whapi_chat_id: contactChatId("972502345678"), is_group: false, last_message_at: hoursAgo(1) },
  { id: "demo-conv-4", name: "מיכל אברהם", whapi_chat_id: contactChatId("972503456789"), is_group: false, last_message_at: hoursAgo(3) },
  { id: "demo-conv-5", name: "צוות מכירות", whapi_chat_id: GROUPS[1].id, is_group: true, last_message_at: hoursAgo(5) },
  { id: "demo-conv-6", name: "אבי פרידמן", whapi_chat_id: contactChatId("972504567890"), is_group: false, last_message_at: hoursAgo(9) },
  { id: "demo-conv-7", name: "נועה שפירא", whapi_chat_id: contactChatId("972505678901"), is_group: false, last_message_at: daysAgo(1) },
  { id: "demo-conv-8", name: "עדכוני מוצר", whapi_chat_id: GROUPS[2].id, is_group: true, last_message_at: daysAgo(2) },
];

type DemoMsg = { id: string; direction: string; sender_name: string | null; body: string | null; created_at: string };

const CONVERSATION_SCRIPTS: Record<string, Array<[dir: "in" | "out", name: string, body: string, mins: number]>> = {
  "demo-conv-1": [
    ["in", "דנה כהן", "היי, אפשר לקבל פרטים על החבילה העסקית?", 60],
    ["out", "הבוט", "בטח! החבילה העסקית כוללת ניהול שיחות אוטומטי, תזמון הודעות ודוחות. רוצה שאשלח מחירון?", 59],
    ["in", "דנה כהן", "כן בבקשה", 58],
    ["out", "הבוט", "מעולה, שלחתי לך מייל עם כל הפרטים 😊 יש עוד משהו שאפשר לעזור?", 57],
    ["in", "דנה כהן", "מושלם, תודה רבה!", 4],
  ],
  "demo-conv-2": [
    ["in", "רון ביטון", "מתי המבצע החדש מתחיל?", 40],
    ["out", "הבוט", "המבצע יוצא ביום ראשון הקרוב, עם 20% הנחה לכל חברי ה-VIP 🎉", 39],
    ["in", "שירה מזרחי", "אפשר לשמור לי פריט מראש?", 20],
    ["out", "הבוט", "כמובן שירה, שמרתי לך. נעדכן אותך ברגע שהמבצע נפתח.", 18],
  ],
  "demo-conv-3": [
    ["in", "יוסי לוי", "ההזמנה שלי עדיין לא הגיעה", 70],
    ["out", "הבוט", "מצטער לשמוע! בדקתי — המשלוח יצא אתמול ואמור להגיע היום עד הערב 📦", 69],
    ["in", "יוסי לוי", "אחלה, תודה על העדכון המהיר", 61],
  ],
};

const DEFAULT_SCRIPT: Array<[dir: "in" | "out", name: string, body: string, mins: number]> = [
  ["in", "לקוח", "שלום, יש לי שאלה", 30],
  ["out", "הבוט", "היי! אני כאן, איך אפשר לעזור?", 29],
  ["in", "לקוח", "רק רציתי לבדוק סטטוס", 28],
  ["out", "הבוט", "הכל תקין ומעודכן ✅ משהו נוסף?", 27],
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
  return { name: c?.name ?? "שיחה", whapi_chat_id: c?.whapi_chat_id ?? "" };
}

// --- participants -------------------------------------------------------------
export const demoGroupConversations = GROUPS.map((g) => ({ whapi_chat_id: g.id, name: g.name }));

const PARTICIPANT_LINES = [
  "תודה על העזרה!",
  "מתי המבצע מתחיל?",
  "אפשר לקבל פרטים נוספים?",
  "מעולה, נשמע מצוין",
  "אני מעוניין בחבילה העסקית",
  "מצטרף לפגישה מחר",
  "שלחתי את המסמכים",
  "אחלה, תודה רבה 🙏",
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
    target_name: "לקוחות VIP",
    body: "בוקר טוב! מזכירים שהמבצע השבועי מתחיל היום ☀️",
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
    target_name: "עדכוני מוצר",
    body: "כתוב עדכון קצר וידידותי על פיצ'ר חדש שיצא השבוע",
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
    target_name: "צוות מכירות",
    body: "סיכום יעדי מכירות לשבוע — כל הכבוד על העבודה! 💪",
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
    target_name: "מיכל אברהם",
    body: "היי מיכל! ראיתי שהתעניינת בחבילה העסקית — רוצה שנקבע שיחה קצרה השבוע?",
    source: "ai_reply",
    created_at: minsAgo(6),
  },
  {
    id: "demo-appr-2",
    target_chat_id: GROUPS[2].id,
    target_name: "עדכוני מוצר",
    body: "עדכון: השבוע השקנו תזמון הודעות חכם — אפשר לתזמן הודעות AI שנכתבות מחדש בכל שליחה ✨",
    source: "schedule",
    created_at: minsAgo(35),
  },
  {
    id: "demo-appr-3",
    target_chat_id: contactChatId("972506789012"),
    target_name: "רון ביטון",
    body: "תודה על הפנייה רון! צוות התמיכה יחזור אליך תוך שעה 🙏",
    source: "manual",
    created_at: hoursAgo(2),
  },
];

// --- logs ---------------------------------------------------------------------
export const demoLogs = [
  { id: "demo-log-1", prompt: "שלח תזכורת מבצע לקבוצת VIP", target_chat_id: GROUPS[0].id, target_name: "לקוחות VIP", result: "בוקר טוב! מזכירים שהמבצע השבועי מתחיל היום ☀️", status: "sent", created_at: minsAgo(12) },
  { id: "demo-log-2", prompt: "תשובת AI ללקוח", target_chat_id: contactChatId("972501234567"), target_name: "דנה כהן", result: "שלחתי לך מייל עם כל הפרטים 😊", status: "sent", created_at: minsAgo(57) },
  { id: "demo-log-3", prompt: "הודעה מתוזמנת (AI)", target_chat_id: GROUPS[2].id, target_name: "עדכוני מוצר", result: "ממתין לאישור מנהל", status: "pending", created_at: hoursAgo(2) },
  { id: "demo-log-4", prompt: "שלח סיכום מכירות", target_chat_id: GROUPS[1].id, target_name: "צוות מכירות", result: "סיכום יעדי מכירות לשבוע — כל הכבוד! 💪", status: "sent", created_at: hoursAgo(6) },
  { id: "demo-log-5", prompt: "תשובת AI ללקוח", target_chat_id: contactChatId("972502345678"), target_name: "יוסי לוי", result: "המשלוח יצא אתמול ואמור להגיע היום עד הערב 📦", status: "sent", created_at: hoursAgo(9) },
  { id: "demo-log-6", prompt: "שליחה ידנית", target_chat_id: contactChatId("972509012345"), target_name: "טל רוזן", result: "Whapi 429: rate limit — נסה שוב", status: "error", created_at: daysAgo(1) },
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
  { id: "demo-thread-1", title: "בדיקת סגנון הבוט", mode: "test-bot", updated_at: minsAgo(10) },
  { id: "demo-thread-2", title: "כמה שיחות היו השבוע?", mode: "admin", updated_at: hoursAgo(2) },
  { id: "demo-thread-3", title: "רעיונות לקמפיין חג", mode: "general", updated_at: daysAgo(1) },
];

const THREAD_MESSAGES: Record<string, Array<[role: "user" | "assistant", content: string, mins: number]>> = {
  "demo-thread-1": [
    ["user", "תכתוב בסגנון של הבוט: לקוח שואל אם אתם פתוחים בשישי", 12],
    ["assistant", "היי! בשישי אנחנו פה עד 14:00, אחרי זה חוזרים ראשון בבוקר 🙂 אפשר לעזור במשהו לפני?", 12],
  ],
  "demo-thread-2": [
    ["user", "כמה שיחות פעילות היו לנו השבוע?", 120],
    ["assistant", "השבוע היו 128 שיחות פעילות, מתוכן 41 בקבוצות. הכי פעילה: \"לקוחות VIP\". רוצה פירוט לפי יום?", 119],
  ],
  "demo-thread-3": [
    ["user", "תן לי 3 רעיונות להודעת חג ללקוחות", 1440],
    ["assistant", "1) \"חג שמח! הכנו לכם 15% הנחה לכבוד החג 🎁\"\n2) \"מאחלים חג של שקט ואור — ונתראה עם המון חדשות בקרוב ✨\"\n3) \"מתנה קטנה לכבוד החג בפנים — הצצה?\"", 1439],
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
    name: "עדי שרון",
    role: "Frontend Developer",
    title: "Senior Frontend Engineer",
    company: "Wix",
    companyFull: "Wix.com",
    matchReason: "הזכירה ניסיון של 5 שנים ב-React ו-TypeScript, ומחפשת אתגר חדש.",
    groupName: "מנהלי קהילה",
    groupId: GROUPS[4].id,
    sourceMessage: "עובדת על React כבר 5 שנים, אשמח לשמוע על הזדמנויות",
    email: "adi.sharon@example.com",
    phone: "+972 50-123-4567",
    linkedinUrl: "https://linkedin.com/in/adi-sharon",
    enrichedVia: ["apollo", "apify"],
  },
  {
    id: "demo-cand-2",
    name: "מור לוין",
    role: "Product Manager",
    title: "Product Manager",
    company: "Monday",
    companyFull: "monday.com",
    matchReason: "כתב על ניהול מוצר ב-B2B SaaS והובלת צוות של 6 אנשים.",
    groupName: "מנהלי קהילה",
    groupId: GROUPS[4].id,
    sourceMessage: "מנהל מוצר ב-SaaS, מוביל צוות של 6",
    email: "mor.levin@example.com",
    phone: "+972 52-987-6543",
    linkedinUrl: "https://linkedin.com/in/mor-levin",
    enrichedVia: ["apollo"],
  },
  {
    id: "demo-cand-3",
    name: "יעל דרור",
    role: "Data Scientist",
    title: "Data Scientist",
    company: undefined,
    companyFull: undefined,
    matchReason: "הזכירה עבודה עם Python ו-ML models בתחום הפינטק.",
    groupName: "עדכוני מוצר",
    groupId: GROUPS[2].id,
    sourceMessage: "עוסקת ב-ML models בפינטק, בעיקר Python",
    linkedinUrl: "https://linkedin.com/in/yael-dror",
    enrichedVia: ["apify"],
  },
];

export const demoSourcingGroups = GROUPS.map((g) => ({ id: g.id, name: g.name }));
