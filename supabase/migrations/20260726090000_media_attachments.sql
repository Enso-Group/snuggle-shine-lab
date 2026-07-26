-- Media attachments for outbound messages.
--
--  * scheduled_approvals.media — attachment pinned while composing/approving;
--    sent as a native WhatsApp image/video/document with the body as caption.
--  * planned_posts.media       — attachment for group posts (engine + approve
--    paths both honor it).
--  * storage bucket `media`    — public bucket for dashboard uploads (Whapi
--    fetches media by URL). The app also creates it lazily at runtime with
--    the service role, so this INSERT is belt-and-suspenders.
--
-- Shape: {"kind": "image"|"video"|"document", "url": "...", "filename": "...", "mime": "..."}

ALTER TABLE public.scheduled_approvals ADD COLUMN IF NOT EXISTS media JSONB;
ALTER TABLE public.planned_posts ADD COLUMN IF NOT EXISTS media JSONB;

INSERT INTO storage.buckets (id, name, public)
VALUES ('media', 'media', true)
ON CONFLICT (id) DO UPDATE SET public = true;
