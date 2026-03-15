import { useMemo } from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { type QualityTestResultPayload } from "@/lib/api";
import type { WorkOrderSummary, WireSummary } from "@/lib/types";
import {
  MEASUREMENT_LABELS,
  formatMeasurementValue,
  formatSpec,
} from "@/components/production/testResultUtils";

interface QualityTestResultsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  result: QualityTestResultPayload | null;
  order: WorkOrderSummary | null;
  wire: WireSummary | null;
  qualityAgentId?: string | null;
  notes?: Record<string, string> | null;
}

function stageLabel(stage: QualityTestResultPayload["stage"]): string {
  switch (stage) {
    case "boot":
      return "Boot";
    case "wheel":
      return "Wheel";
    case "final":
      return "Final";
    default:
      return stage;
  }
}

export function QualityTestResultsDialog({
  open,
  onOpenChange,
  result,
  order,
  wire,
  qualityAgentId,
  notes,
}: QualityTestResultsDialogProps) {
  const measurements = result?.result?.verdicts ?? [];

  const overallStatus = useMemo(() => {
    if (!result) return null;
    const statusText = result.result.status?.trim();
    if (statusText) {
      return statusText.toUpperCase();
    }
    if (result.result.overallPassed === true) return "OK";
    if (result.result.overallPassed === false) return "NOK";
    return null;
  }, [result]);

  const formattedNotes = useMemo(() => {
    if (!notes) return [] as Array<[string, string]>;
    return Object.entries(notes)
      .map(([key, value]) => [key?.trim(), value?.toString().trim()] as const)
      .filter(([key, value]) => Boolean(key) && Boolean(value));
  }, [notes]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Quality test results</DialogTitle>
          <DialogDescription>
            {wire ? `${wire.refWire} · ${wire.marquage}` : "Captured measurements"}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="rounded-lg border border-border/50 bg-muted/20 p-4 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="space-y-1">
                <p className="font-semibold text-foreground">
                  {order ? `${order.ofId} · ${order.reference}` : "Selected work order"}
                </p>
                {result ? (
                  <p className="text-xs text-muted-foreground">Stage: {stageLabel(result.stage)}</p>
                ) : null}
                {qualityAgentId ? (
                  <p className="text-xs text-muted-foreground">QA ID: {qualityAgentId}</p>
                ) : null}
              </div>
              {overallStatus ? (
                <Badge
                  variant="secondary"
                  className={`text-xs uppercase ${
                    overallStatus === "OK"
                      ? "border-success/40 text-success"
                      : overallStatus === "NOK"
                        ? "border-destructive/40 text-destructive"
                        : "border-border/40 text-muted-foreground"
                  }`}
                >
                  {overallStatus}
                </Badge>
              ) : null}
            </div>
          </div>

          <div className="max-h-[60vh] overflow-y-auto rounded-lg border border-border/40 bg-card/60">
            <div className="space-y-3 p-4">
              {measurements.length > 0 ? (
                measurements.map((verdict) => {
                  const label = MEASUREMENT_LABELS[verdict.key] ?? verdict.key;
                  const valueText = formatMeasurementValue(verdict.value, verdict.unit ?? undefined);
                  const specText = formatSpec(verdict);
                  const status = verdict.passed === true ? "Valid" : verdict.passed === false ? "Invalid" : "N/A";
                  const badgeClass =
                    verdict.passed === true
                      ? "border-success/40 text-success"
                      : verdict.passed === false
                        ? "border-destructive/40 text-destructive"
                        : "border-border/40 text-muted-foreground";

                  return (
                    <div key={verdict.key} className="rounded-lg border border-border/40 bg-background/80 p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-sm font-semibold text-foreground">{label}</p>
                          <p className="text-xs text-muted-foreground">
                            {specText ?? "No tolerance defined"}
                          </p>
                        </div>
                        <Badge variant="outline" className={`${badgeClass} text-[0.65rem] uppercase tracking-wider`}>
                          {status}
                        </Badge>
                      </div>
                      <Separator className="my-2" />
                      <p className="text-sm font-semibold text-foreground">{valueText}</p>
                    </div>
                  );
                })
              ) : (
                <div className="rounded-lg border border-dashed border-border/40 bg-muted/20 p-4 text-sm text-muted-foreground">
                  No measurements were captured for this quality test.
                </div>
              )}

              {formattedNotes.length > 0 ? (
                <div className="space-y-2">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Notes
                  </h3>
                  <div className="space-y-1 text-sm">
                    {formattedNotes.map(([key, value]) => (
                      <div key={key} className="flex items-center justify-between gap-4">
                        <span className="text-muted-foreground">{key}</span>
                        <span className="font-medium text-foreground">{value}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </div>

        <DialogFooter className="mt-2 flex flex-col gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
