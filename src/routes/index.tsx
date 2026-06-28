import { createFileRoute, redirect } from "@tanstack/react-router";

// Root "/" redirects into the authenticated dashboard (which itself redirects to /auth if signed out).
export const Route = createFileRoute("/")({
  beforeLoad: () => {
    throw redirect({ to: "/auth" });
  },
  component: () => null,
});
