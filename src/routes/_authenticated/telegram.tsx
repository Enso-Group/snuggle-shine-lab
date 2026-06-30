import { createFileRoute } from "@tanstack/react-router";
import { Send } from "lucide-react";

export const Route = createFileRoute("/_authenticated/telegram")({
  head: () => ({ meta: [{ title: "Telegram — Coming Soon" }] }),
  component: TelegramPage,
});

function TelegramPage() {
  return (
    <div className="flex flex-col items-center justify-center min-h-full p-8 text-center">
      {/* Telegram brand color circle */}
      <div className="mb-6 rounded-full bg-[#229ED9] p-6 shadow-lg">
        <Send className="size-14 text-white" strokeWidth={1.5} />
      </div>

      <h1 className="text-4xl font-bold mb-3">Telegram Bot</h1>
      <p className="text-xl text-muted-foreground mb-2">בקרוב / Coming Soon</p>

      <p className="max-w-md text-muted-foreground mt-4 leading-relaxed">
        שילוב Telegram נמצא בפיתוח. בקרוב תוכלו לנהל שיחות, לשלוח הודעות ולהפעיל את הבוט גם דרך Telegram — בדיוק כמו WhatsApp.
      </p>

      <div className="mt-8 flex gap-3 flex-wrap justify-center">
        <span className="px-4 py-2 rounded-full bg-muted text-sm">🤖 Telegram Bot API</span>
        <span className="px-4 py-2 rounded-full bg-muted text-sm">💬 שיחות קבוצתיות</span>
        <span className="px-4 py-2 rounded-full bg-muted text-sm">📢 ערוצים</span>
        <span className="px-4 py-2 rounded-full bg-muted text-sm">⏱ הודעות מתוזמנות</span>
      </div>
    </div>
  );
}
