import { useState } from "react";
import type { LucideIcon } from "lucide-react";
import { AlertTriangle, Factory, Loader2, ShieldAlert, Wrench } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/use-toast";
import { triggerDepartmentCall, type DepartmentCallKind } from "@/lib/api";
import { cn } from "@/lib/utils";

interface DepartmentCallDefinition {
  kind: DepartmentCallKind;
  label: string;
  description: string;
  icon: LucideIcon;
  success: string;
}

const ACTIONS: DepartmentCallDefinition[] = [
  {
    kind: "maintenance",
    label: "Appel Maintenance",
    description: "Prévenir l'équipe maintenance en cas d'arrêt machine.",
    icon: Wrench,
    success: "Maintenance notified successfully.",
  },
  {
    kind: "quality",
    label: "Appel Qualité",
    description: "Alerter la qualité pour une vérification immédiate.",
    icon: ShieldAlert,
    success: "Quality support notified successfully.",
  },
  {
    kind: "production",
    label: "Appel Production",
    description: "Escalader un incident de production en cours.",
    icon: Factory,
    success: "Production leadership notified successfully.",
  },
  {
    kind: "non_conformity",
    label: "Appel Non-Conformité",
    description: "Signaler un écart ou une non-conformité détectée.",
    icon: AlertTriangle,
    success: "Non-conformity alert sent successfully.",
  },
];

interface DepartmentCallButtonsProps {
  className?: string;
}

export function DepartmentCallButtons({ className }: DepartmentCallButtonsProps) {
  const { toast } = useToast();
  const [pending, setPending] = useState<DepartmentCallKind | null>(null);

  const handleCall = async (action: DepartmentCallDefinition) => {
    if (pending) return;
    setPending(action.kind);
    try {
      await triggerDepartmentCall(action.kind);
      toast({
        title: action.label,
        description: action.success,
        variant: "default",
      });
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Unable to dispatch department alert.";
      toast({
        title: `Échec: ${action.label}`,
        description: message,
        variant: "destructive",
      });
    } finally {
      setPending(null);
    }
  };

  return (
    <div
      className={cn(
        "rounded-xl border border-border/40 bg-card/80 p-4 shadow-sm backdrop-blur supports-[backdrop-filter]:backdrop-blur",
        className,
      )}
    >
      <div className="mb-3">
        <h3 className="text-sm font-semibold text-foreground">Appels départements</h3>
        <p className="text-xs text-muted-foreground">
          Notifier rapidement les équipes concernées lorsqu'un incident survient.
        </p>
      </div>
      <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
        {ACTIONS.map((action) => {
          const Icon = action.icon;
          const loading = pending === action.kind;
          return (
            <Button
              key={action.kind}
              type="button"
              variant="outline"
              size="sm"
              className="h-auto justify-start gap-2 rounded-lg border-border/50 bg-background/60 py-3 text-left"
              disabled={pending !== null}
              onClick={() => handleCall(action)}
            >
              {loading ? (
                <Loader2 className="h-4 w-4 animate-spin text-primary" />
              ) : (
                <Icon className="h-4 w-4 text-primary" />
              )}
              <div className="flex flex-col items-start">
                <span className="text-sm font-semibold text-foreground">{action.label}</span>
                <span className="text-[11px] text-muted-foreground">{action.description}</span>
              </div>
            </Button>
          );
        })}
      </div>
    </div>
  );
}
