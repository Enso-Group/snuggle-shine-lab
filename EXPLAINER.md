# Autonomous WhatsApp Agent — System Explainer

## What it is

An autonomous AI agent that lives inside a business's WhatsApp account and
manages its community end to end: it answers 1-on-1 messages like a trained
team member, runs and moderates WhatsApp groups, remembers every person it
talks to, researches the web when it doesn't know an answer, and reports every
decision it makes — with its reasoning — to a management dashboard. Humans
stay in the loop: sensitive replies wait for approval, and the bot can be
steered per-group in plain language.

## The problem it solves

Businesses lose customers on WhatsApp. Messages arrive at all hours, someone
promises to "check and get back to you" and never does, groups go quiet, and
the owner becomes a full-time message-answerer. This system replaces that
manual grind with an agent that never goes silent, keeps its promises on a
deadline, and still leaves final control with a human.

## How a message flows through the system

**1-on-1 reply pipeline** (message in → reply out, typically 20–35 seconds):

1. **Message in** — WhatsApp (via the Whapi gateway) posts each incoming
   message to the app's webhook.
2. **Store + gate** — the message is stored idempotently; one-way surfaces
   (channels/broadcasts), stale replays, stop requests and trivial acks are
   filtered; a reply job is queued with a humanized 3–10-second reply target.
3. **Context** — the agent loads the conversation history, the person's
   remembered facts and funnel stage, and any relevant knowledge-base entries.
4. **Intent** — a fast model classifies what the person wants, the language,
   urgency, and whether a human should take over (escalation).
5. **Draft** — a strong model writes the reply under baked-in quality rules
   (language mirroring, grounding in verified sources only, persona safety,
   never-silent), followed by deterministic safety filters.
6. **Quality gates** — anti-ban guards (rate limits, duplicate/blocked-contact
   checks), a consolidation pass if newer messages arrived mid-draft, and the
   approval gate when enabled.
7. **Send** — delivered with human pacing: read receipt, typing indicator,
   1–3 short messages with natural pauses.
8. **Memory** — after sending, the agent extracts new facts about the person
   and can schedule a follow-up.

**Research promises**: when a reply says "I'll check and get back to you",
that promise becomes a tracked job with a hard 10-minute deadline. The agent
runs a real web search (Tavily), drafts a grounded answer that includes the
actual source link when a resource was requested, and sends it within minutes.
If the answer can't land in time, the contact gets an honest interim update
and the admin is alerted — a promise is never silently dropped.

**Group posts pipeline**: each managed group has a taught profile (purpose,
tone, content pillars, posting schedule). The engine drafts posts on schedule,
self-reviews them, supports native polls, images, videos and documents, sends
or queues for approval, and feeds engagement analytics back into a weekly
strategy memo. Moderation (spam removal, private warnings, member welcomes)
runs on the same profile.

## Dashboard pages

- **Command Center** — one screen per managed group: plain-language steering
  chat that updates the bot's own configuration, current strategy memo, 7-day
  engagement chart and daily stats, the post pipeline (not sent / in progress
  / sent, with media previews and retry), recent moderation actions, and a
  full "Teach & Configure" profile editor.
- **Activity** — the bot's complete diary: every reply, post, moderation
  action, new contact and alert, filterable by day/week/month and by kind,
  with an expandable stage-by-stage reasoning trace per action.
- **Profiles** — the bot's memory of every contact: learned facts, intent and
  sentiment history, funnel stage, the full 1-on-1 timeline, and a grounded
  "ask the AI about this contact" box.
- **Approvals** — the human-in-the-loop queue: send, edit-then-send, save
  without sending, attach/replace/remove media, poll previews, reject.
- **Behind the Scenes** — operations: bot personality and model settings,
  knowledge base management, a safe conversation simulator that runs the real
  pipeline, WhatsApp connection (QR pairing, webhook reset, history import),
  dashboard access control (invite list), and AI usage & cost tracking per
  day and per model.

## Tech stack

- **Frontend**: React 19 + TanStack Start (file-based routes and server
  functions), Tailwind v4, shadcn/ui, Recharts.
- **Backend**: TanStack server routes on Lovable Cloud (Cloudflare Workers
  runtime); a durable Postgres job queue with per-chat serialization powers
  the agent pipeline; a per-minute + fast-tick cron sweeper handles retries,
  research deadlines, follow-ups, posting and analytics.
- **Data**: Supabase (Postgres + Auth + Storage). Every pipeline stage writes
  a decision row — that log is both the Activity feed and the ops debugging
  trail. Invite-only Google sign-in.
- **AI**: role-based model routing (strong model for drafting, fast model for
  classification) through an LLM gateway with automatic fallback across model
  candidates, wall-clock budgets on every call, and per-call cost logging.
- **Integrations**: Whapi.Cloud for WhatsApp send/receive (text, media,
  polls, presence), Tavily for web research.

## Reliability & safety (selected)

- **Never-silent guarantee**: every DM gets an answer — if the whole pipeline
  fails, a canned in-persona fallback is sent, the promise is re-tracked as a
  research job, and the admin is alerted.
- **Anti-ban discipline**: minimum gaps between sends, hourly caps,
  consecutive-message limits, duplicate suppression, stop-request blocking,
  and human-like typing/pacing on every send.
- **Full auditability**: every stage of every decision is logged with timing
  and reasoning; a public health endpoint exposes queue depth, delivery
  latency and integration status for external monitoring.
- **Human control**: global approval mode, per-reply escalation to a human,
  plain-language group steering, and a hard kill switch.
