import { describe, expect, it } from "vitest";
import { approvalMatchesPost } from "../approval-match";

const post = {
  id: "post-1",
  group_chat_id: "123-456@g.us",
  body: "בואו נדבר על טיפים לתמחור 🎯",
  created_at: "2026-07-22T08:00:00Z",
};

const approval = {
  planned_post_id: null,
  target_chat_id: "123-456@g.us",
  body: "בואו נדבר על טיפים לתמחור 🎯",
  created_at: "2026-07-22T08:00:05Z",
};

describe("approvalMatchesPost", () => {
  it("matches by planned_post_id when linked", () => {
    expect(approvalMatchesPost({ ...approval, planned_post_id: "post-1" }, post)).toBe(true);
  });

  it("a link to a different post never matches, even with identical bodies", () => {
    expect(approvalMatchesPost({ ...approval, planned_post_id: "post-2" }, post)).toBe(false);
  });

  it("legacy rows match by group + exact body", () => {
    expect(approvalMatchesPost(approval, post)).toBe(true);
  });

  it("legacy rows match when the planned body appends the poll text", () => {
    const withPoll = { ...post, body: `${post.body}\n\n📊 מה דעתכם?\n▫️ כן\n▫️ לא` };
    expect(approvalMatchesPost(approval, withPoll)).toBe(true);
  });

  it("rejects a different group", () => {
    expect(approvalMatchesPost({ ...approval, target_chat_id: "999@g.us" }, post)).toBe(false);
  });

  it("rejects an approval created before the post — it belongs to an older post", () => {
    const older = { ...approval, created_at: "2026-07-21T08:00:00Z" };
    expect(approvalMatchesPost(older, post)).toBe(false);
  });

  it("rejects when the body doesn't appear in the planned body", () => {
    expect(approvalMatchesPost({ ...approval, body: "פוסט אחר לגמרי" }, post)).toBe(false);
  });

  it("handles a null planned body", () => {
    expect(approvalMatchesPost(approval, { ...post, body: null })).toBe(false);
  });
});
