# Demo Narration Script

Screen-recording narration, ~2.5 minutes spoken at a natural pace.

Before recording: set `DEMO_MODE = true` in `src/lib/demo.ts` (one line) and
deploy — all five pages then show the built-in demo data, no other setup.
After recording: set it back to `false` to show real data again.

---

## English version

**[Opening — on the Command Center, before clicking anything]**

What you're looking at is an autonomous WhatsApp agent — a bot that manages a
real business community on WhatsApp, mostly by itself. It reads every incoming
message, decides whether and how to answer, remembers who each person is, and
even runs the group's content calendar. The team stays in control: anything
sensitive waits for a human click, and every single decision the bot makes is
logged with its reasoning, so you can always see *why* it did what it did.

It saves hours of community-management work every day. When it doesn't know
something, it doesn't make things up — it actually searches the web and comes
back with a real answer, with a real link. And when it promises someone
"I'll check and get back to you", that promise becomes a tracked task with a
ten-minute deadline — it either delivers the answer in minutes or sends an
honest update. And it talks like a person: it types, it pauses, it answers in
your language.

**[Command Center]**

This is the Command Center — one screen per community. On the left, the groups
the bot manages. For each one you get the bot's current strategy in plain
words, a live engagement chart, and the content pipeline — what's waiting,
what's pending approval, and what already went out, including images and
polls. The best part is this chat box: you steer the bot in plain language —
"post more about pricing", "how did this week go?" — and it updates its own
configuration and confirms exactly what changed.

**[Activity]**

This is the Activity feed — the bot's diary. Every reply, every post, every
moderation action, every alert, with a timestamp. Open any entry and you see
the full chain of reasoning: what it understood, what it drafted, and why.
Nothing the bot does is a black box.

**[Profiles]**

Profiles is the bot's memory of people. For each contact: the facts it
learned — their business, what they asked about — their mood over time, where
they are in the funnel, and the full conversation. And down here you can ask
the AI about any contact — "is she close to buying?" — and get an answer
grounded in what actually happened in the chat.

**[Approvals]**

Approvals is the human-in-the-loop. Messages the bot prefers not to send on
its own wait here — you can send as-is, edit first, attach an image or a file,
or reject. One click, and the bot handles the delivery.

**[Behind the Scenes]**

And Behind the Scenes is the engine room: the bot's personality and writing
style, the knowledge base it answers from, a simulator where you can test
conversations safely before going live, the WhatsApp connection itself, who
has access to this dashboard, and exactly what the AI usage costs — per day
and per model.

**[Closing]**

So: a community manager that works 24/7, researches before it answers, asks
permission when it matters, and shows its work. That's the system.

---

## גרסה עברית

**[פתיחה — על מסך ה-Command Center, לפני שלוחצים]**

מה שאתם רואים כאן זה סוכן וואטסאפ אוטונומי — בוט שמנהל קהילה עסקית אמיתית
בוואטסאפ, רוב הזמן לגמרי לבד. הוא קורא כל הודעה שנכנסת, מחליט אם ואיך לענות,
זוכר מי כל אדם, ואפילו מנהל את לוח התוכן של הקבוצה. והצוות נשאר בשליטה: כל
דבר רגיש מחכה לאישור של בן אדם, וכל החלטה של הבוט נרשמת יחד עם הנימוק שלה —
אז תמיד אפשר לראות *למה* הוא עשה מה שעשה.

זה חוסך שעות של ניהול קהילה כל יום. כשהבוט לא יודע משהו — הוא לא ממציא: הוא
באמת מחפש באינטרנט וחוזר עם תשובה אמיתית, כולל קישור אמיתי. וכשהוא מבטיח
למישהו "אבדוק ואחזור אליך" — ההבטחה הזאת הופכת למשימה עם דדליין של עשר דקות:
או שהתשובה מגיעה תוך דקות, או שנשלח עדכון כן. והוא מתכתב כמו בן אדם: מקליד,
עוצר, עונה בשפה שלך.

**[Command Center — מרכז השליטה]**

זה מרכז השליטה — מסך אחד לכל קהילה. משמאל הקבוצות שהבוט מנהל. לכל קבוצה
רואים את האסטרטגיה הנוכחית של הבוט במילים פשוטות, גרף מעורבות חי, ואת צינור
התוכן — מה ממתין, מה מחכה לאישור ומה כבר יצא, כולל תמונות וסקרים. והחלק הכי
טוב — תיבת הצ'אט הזאת: מכוונים את הבוט בשפה חופשית — "תפרסם יותר על תמחור",
"איך היה השבוע?" — והוא מעדכן את ההגדרות של עצמו ומאשר בדיוק מה השתנה.

**[Activity — פעילות]**

זה יומן הפעילות — היומן האישי של הבוט. כל תשובה, כל פוסט, כל פעולת ניהול, כל
התראה — עם שעה מדויקת. פותחים כל שורה ורואים את שרשרת החשיבה המלאה: מה הוא
הבין, מה הוא ניסח ולמה. שום דבר כאן הוא לא קופסה שחורה.

**[Profiles — פרופילים]**

פרופילים זה הזיכרון האנושי של הבוט. לכל איש קשר: העובדות שהוא למד — העסק
שלהם, מה הם שאלו — מצב הרוח לאורך זמן, איפה הם בתהליך המכירה, והשיחה המלאה.
ולמטה אפשר לשאול את ה-AI על כל איש קשר — "היא קרובה לקנייה?" — ולקבל תשובה
שמבוססת רק על מה שבאמת קרה בשיחה.

**[Approvals — אישורים]**

אישורים זה המקום של בן האדם בתהליך. הודעות שהבוט מעדיף לא לשלוח לבד מחכות
כאן — אפשר לשלוח כמו שזה, לערוך קודם, לצרף תמונה או קובץ, או לדחות. קליק
אחד — והבוט כבר דואג למשלוח.

**[Behind the Scenes — מאחורי הקלעים]**

ומאחורי הקלעים זה חדר המכונות: האישיות וסגנון הכתיבה של הבוט, מאגר הידע שממנו
הוא עונה, סימולטור שבו בודקים שיחות בבטחה לפני שעולים לאוויר, חיבור הוואטסאפ
עצמו, מי מורשה להיכנס לדשבורד, וכמה בדיוק עולה השימוש ב-AI — לפי יום ולפי
מודל.

**[סיום]**

אז: מנהל קהילה שעובד 24/7, בודק לפני שהוא עונה, מבקש רשות כשזה חשוב — ומראה
את כל העבודה שלו. זו המערכת.
