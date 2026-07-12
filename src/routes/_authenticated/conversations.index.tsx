import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/conversations/")({
  component: () => (
    <div className="h-full flex items-center justify-center text-muted-foreground">
      Select a chat from the list
    </div>
  ),
});
