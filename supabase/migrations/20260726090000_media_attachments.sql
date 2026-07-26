-- Media attachments for outbound messages.
--
--  * scheduled_approvals.media — attachment pinned while composing/approving;
--    sent as a native WhatsApp image/video/document with the body as caption.
--  * planned_posts.media       — attachment for group posts (engine + approve
--    paths both honor it).
--  * storage bucket `media`    — PRIVATE bucket for dashboard uploads (this
--    environment blocks public buckets); Whapi fetches media via signed URLs
--    minted at send time. The app also creates the bucket lazily at runtime
--    with the service role, so this INSERT is belt-and-suspenders.
--
-- Shape: {"kind": "image"|"video"|"document", "url": "<signed/preview>",
--         "storage_path": "uploads/...", "filename": "...", "mime": "..."}

ALTER TABLE public.scheduled_approvals ADD COLUMN IF NOT EXISTS media JSONB;
ALTER TABLE public.planned_posts ADD COLUMN IF NOT EXISTS media JSONB;

INSERT INTO storage.buckets (id, name, public)
VALUES ('media', 'media', false)
ON CONFLICT (id) DO NOTHING;
