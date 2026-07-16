import { createFileRoute } from "@tanstack/react-router";
import { Bot } from "lucide-react";
import { EmptyState } from "@/components/page-header";

export const Route = createFileRoute("/_authenticated/chat/")({
  ssr: false,
  component: () => (
    <div className="flex h-full items-center justify-center">
      <EmptyState
        icon={Bot}
        title="Select or start a conversation"
        description="Pick a conversation from the sidebar, or create a new one to chat with the AI."
      />
    </div>
  ),
});
