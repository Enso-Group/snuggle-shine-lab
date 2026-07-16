import { createFileRoute } from "@tanstack/react-router";
import { MessageSquare } from "lucide-react";
import { EmptyState } from "@/components/page-header";

export const Route = createFileRoute("/_authenticated/conversations/")({
  component: () => (
    <div className="flex h-full items-center justify-center">
      <EmptyState
        icon={MessageSquare}
        title="Select a chat from the list"
        description="Pick a conversation from the sidebar to see its messages."
      />
    </div>
  ),
});
