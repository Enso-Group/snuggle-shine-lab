import { createFileRoute, redirect } from "@tanstack/react-router";

// Interim home: Activity is the landing page until the Group Command Center
// (restructure step 3) takes over as "/".
export const Route = createFileRoute("/_authenticated/")({
  beforeLoad: () => {
    throw redirect({ to: "/activity" });
  },
});
