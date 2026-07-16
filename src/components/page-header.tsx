import type { ComponentType, ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Shared page header used across dashboard pages (matches the Send Message
 * design): icon badge + title/subtitle on the left, contextual actions
 * (badges, buttons, tabs) on the right.
 */
export function PageHeader({
  icon: Icon,
  title,
  description,
  actions,
  maxWidthClass = "max-w-5xl",
}: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  description?: string;
  actions?: ReactNode;
  maxWidthClass?: string;
}) {
  return (
    <div className="border-b bg-card">
      <div className={cn("mx-auto flex flex-wrap items-center gap-4 px-8 py-6", maxWidthClass)}>
        <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm">
          <Icon className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          {description && <p className="text-sm text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}

/** Content container that matches the PageHeader rhythm. */
export function PageContent({
  children,
  maxWidthClass = "max-w-5xl",
  className,
}: {
  children: ReactNode;
  maxWidthClass?: string;
  className?: string;
}) {
  return <div className={cn("mx-auto px-8 py-8 space-y-6", maxWidthClass, className)}>{children}</div>;
}

/** Centered empty-state block with an icon, used inside cards or lists. */
export function EmptyState({
  icon: Icon,
  title,
  description,
}: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  description?: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
      <div className="flex size-12 items-center justify-center rounded-full bg-muted">
        <Icon className="size-5 text-muted-foreground" />
      </div>
      <p className="text-sm font-medium">{title}</p>
      {description && <p className="max-w-sm text-xs text-muted-foreground">{description}</p>}
    </div>
  );
}
