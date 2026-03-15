import type { WireStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

interface StatusBadgeProps {
  status: WireStatus | string;
  className?: string;
}

const statusConfig: Record<WireStatus, { label: string; className: string }> = {
  not_validated: {
    label: "Not Validated",
    className: "bg-muted/50 text-muted-foreground border border-border/50",
  },
  validated: {
    label: "Validated",
    className: "bg-primary/15 text-primary border border-primary/30 shadow-sm backdrop-blur-sm",
  },
  qc_boot: {
    label: "QC (Boot)",
    className: "bg-warning/15 text-warning border border-warning/30 shadow-sm backdrop-blur-sm",
  },
  in_production: {
    label: "In Production",
    className: "bg-secondary/15 text-secondary border border-secondary/30 shadow-sm backdrop-blur-sm",
  },
  qc_wheel: {
    label: "QC (Wheel)",
    className: "bg-destructive/15 text-destructive border border-destructive/30 shadow-sm backdrop-blur-sm",
  },
  qc_final: {
    label: "QC (Final)",
    className: "bg-destructive/20 text-destructive border border-destructive/40 shadow-sm backdrop-blur-sm",
  },
  paused: {
    label: "Paused",
    className: "bg-muted/60 text-muted-foreground border border-border/70 shadow-sm backdrop-blur-sm",
  },
  stopped: {
    label: "Stopped",
    className: "bg-muted/70 text-muted-foreground border border-destructive/40 shadow-sm backdrop-blur-sm",
  },
  completed: {
    label: "Completed",
    className: "bg-success/15 text-success border border-success/30 shadow-sm backdrop-blur-sm",
  },
};

export function StatusBadge({ status, className }: StatusBadgeProps) {
  const fallback = statusConfig.not_validated;
  const config =
    statusConfig[status as WireStatus] ??
    ({
      label:
        typeof status === "string" && status.trim()
          ? status
              .replace(/_/g, " ")
              .replace(/\b\w/g, (char) => char.toUpperCase())
          : fallback.label,
      className: fallback.className,
    } satisfies { label: string; className: string });

  return (
    <span className={cn("status-badge", config.className, className)}>
      {config.label}
    </span>
  );
}
