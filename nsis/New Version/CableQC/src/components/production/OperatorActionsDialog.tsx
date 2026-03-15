import { useEffect, useMemo, useState } from "react";
import { BadgeCheck, Loader2, PackageCheck, RefreshCcw, ScrollText } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { TestResult } from "@/lib/api";
import { fetchOperatorTestResults } from "@/lib/api";
import type { WorkOrderSummary, WireSummary } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useAppFlow } from "@/context/AppFlowContext";
import { OperatorTestResultsDialog } from "@/components/production/OperatorTestResultsDialog";
import { Separator } from "@/components/ui/separator";

interface OperatorActionsDialogProps {
  open: boolean;
  wire: WireSummary | null;
  order: WorkOrderSummary | null;
  notes: Record<string, string> | null;
  isRecording: boolean;
  onOpenChange: (open: boolean) => void;
  onRecordBundle: (quantity: number) => void;
  printingEnabled?: boolean;
  printerReady?: boolean;
  printingFormat?: string | null;
  printingLoading?: boolean;
  onConfigurePrinter?: () => void;
  onChangeCoil?: () => void;
  changeCoilDisabled?: boolean;
}

interface BundleConfig {
  quantityTotal: number;
  bundleCount: number;
}

function computeBundleSize(quantityTotal?: number, bundleCount?: number): number {
  if (!quantityTotal || quantityTotal <= 0) return 1;
  if (!bundleCount || bundleCount <= 0) {
    return Math.max(1, Math.round(quantityTotal));
  }
  const computed = quantityTotal / bundleCount;
  if (!Number.isFinite(computed) || computed <= 0) {
    return 1;
  }
  return Math.max(1, Math.round(computed));
}

function sanitizeBundleSize(value?: number | null): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value <= 0) return null;
  return Math.max(1, Math.round(value));
}

function deriveBundleSuggestion(
  order: WorkOrderSummary | null,
  wire: WireSummary | null,
  configured?: BundleConfig | null,
): number {
  const directMatch =
    sanitizeBundleSize(configured?.bundleCount) ??
    sanitizeBundleSize(order?.bundleCount) ??
    sanitizeBundleSize(wire?.bundleCount);

  if (directMatch) {
    return directMatch;
  }

  const referenceBundle =
    configured ??
    (order
      ? {
        quantityTotal: order.quantityTotal,
        bundleCount: order.bundleCount,
      }
      : null);

  if (referenceBundle) {
    return computeBundleSize(referenceBundle.quantityTotal, referenceBundle.bundleCount);
  }

  if (wire) {
    return computeBundleSize(wire.targetQuantity, wire.bundleCount);
  }

  return 1;
}

export function OperatorActionsDialog({
  open,
  wire,
  order,
  notes,
  isRecording,
  onOpenChange,
  onRecordBundle,
  printingEnabled = false,
  printerReady = false,
  printingFormat,
  printingLoading = false,
  onConfigurePrinter,
  onChangeCoil,
  changeCoilDisabled = false,
}: OperatorActionsDialogProps) {
  const { state: flowState } = useAppFlow();
  const produced = wire?.producedQuantity ?? 0;
  const target = wire?.targetQuantity ?? 0;
  const remaining = Math.max(target - produced, 0);

  const configuredBundle = useMemo(() => {
    if (!order) return null;
    const ofId = order.ofId.toLowerCase();
    const reference = order.reference.toLowerCase();
    const match = flowState.orders.find(
      (entry) => entry.ofId.toLowerCase() === ofId && entry.reference.toLowerCase() === reference,
    );
    if (!match) return null;
    return {
      quantityTotal: match.quantityTotal,
      bundleCount: match.bundleCount,
    } satisfies BundleConfig;
  }, [flowState.orders, order?.ofId, order?.reference]);

  const defaultBundleSize = useMemo(
    () => deriveBundleSuggestion(order ?? null, wire ?? null, configuredBundle),
    [configuredBundle, order, wire],
  );
  const [bundleQuantity, setBundleQuantity] = useState<number>(defaultBundleSize);
  const [resultsDialogOpen, setResultsDialogOpen] = useState(false);
  const [results, setResults] = useState<TestResult | null>(null);
  const [resultsLoading, setResultsLoading] = useState(false);
  const [resultsError, setResultsError] = useState<string | null>(null);

  const identifier = useMemo(() => {
    if (!order || !wire) return null;
    return {
      workOrderId: order.id,
      refWire: wire.refWire,
      marquage: wire.marquage,
    };
  }, [order?.id, wire?.marquage, wire?.refWire, wire?.id]);

  useEffect(() => {
    let cancelled = false;
    if (!open || !identifier) {
      setResults(null);
      setResultsError(null);
      setResultsLoading(false);
      return () => {
        cancelled = true;
      };
    }

    setResultsLoading(true);
    setResultsError(null);
    fetchOperatorTestResults(identifier)
      .then((response) => {
        if (!cancelled) {
          setResults(response);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setResultsError(error instanceof Error ? error.message : "Unable to load operator test results.");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setResultsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [identifier, open]);

  useEffect(() => {
    const next = remaining > 0 ? Math.min(defaultBundleSize, remaining) : defaultBundleSize;
    setBundleQuantity(next > 0 ? next : 1);
    setResultsDialogOpen(false);
  }, [defaultBundleSize, remaining, wire?.id, order?.id, open]);

  const handleRecordBundle = () => {
    if (remaining <= 0) return;
    const quantity = Math.floor(bundleQuantity);
    if (!Number.isFinite(quantity) || quantity <= 0) return;
    const bounded = Math.min(quantity, remaining);
    onRecordBundle(bounded);
  };

  const canRecord = remaining > 0 && !isRecording;

  const overallStatus = useMemo(() => {
    if (!results) return null;
    if (results.status && results.status.trim().length > 0) {
      return results.status.trim().toUpperCase();
    }
    if (results.overallPassed === true) return "OK";
    if (results.overallPassed === false) return "NOK";
    return null;
  }, [results]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Operator Actions</DialogTitle>
          <DialogDescription>
            Complete the follow-up steps for {wire ? wire.refWire : "this wire"} after the operator test.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="rounded-lg border border-border/50 bg-muted/30 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
              <span>
                {order ? `OF ${order.ofId}` : "Order"} • {wire ? wire.marquage : "—"}
              </span>
              <Badge variant="outline" className="border-success/40 text-success">
                <BadgeCheck className="mr-1 h-3.5 w-3.5" />
                Operator test complete
              </Badge>
            </div>
            <Separator className="my-3" />
            <div className="flex flex-col gap-1.5 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Wires produced</span>
                <span className="font-semibold text-foreground">{produced}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Target quantity</span>
                <span className="font-semibold text-foreground">{target}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Remaining</span>
                <span className={cn("font-semibold", remaining > 0 ? "text-primary" : "text-muted-foreground")}>
                  {remaining}
                </span>
              </div>
            </div>
            <Separator className="my-3" />
            <div className="space-y-2">
              <Button
                type="button"
                variant="outline"
                className="w-full gap-2"
                onClick={() => onChangeCoil?.()}
                disabled={!onChangeCoil || changeCoilDisabled}
              >
                <RefreshCcw className="h-4 w-4" />
                Changer BOBINE
              </Button>
              <p className="text-xs text-muted-foreground">
                Re-scan the BOBINE identifier to validate the active wire before recording bundles.
              </p>
            </div>
          </div>

          <div className="space-y-3 rounded-lg border border-border/40 bg-card/60 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-sm font-semibold text-foreground">Operator measurements</p>
                <p className="text-xs text-muted-foreground">
                  Review the captured values and comparator notes from the last operator test.
                </p>
              </div>
              {overallStatus ? (
                <Badge
                  variant="outline"
                  className={cn(
                    "border-border/60 text-[0.65rem] uppercase tracking-widest",
                    overallStatus === "OK"
                      ? "border-success/40 text-success"
                      : overallStatus === "NOK"
                        ? "border-destructive/40 text-destructive"
                        : "text-muted-foreground",
                  )}
                >
                  {overallStatus === "OK"
                    ? "All valid"
                    : overallStatus === "NOK"
                      ? "Check measurements"
                      : overallStatus}
                </Badge>
              ) : null}
            </div>
            {resultsError ? (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
                {resultsError}
              </div>
            ) : (
              <Button
                type="button"
                variant="outline"
                className="w-full gap-2"
                onClick={() => setResultsDialogOpen(true)}
                disabled={resultsLoading}
              >
                {resultsLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ScrollText className="h-4 w-4" />}
                {resultsLoading ? "Loading measurements…" : "Show test results"}
              </Button>
            )}
            <p className="text-xs text-muted-foreground">
              Opens a detailed, scrollable summary including measurement verdicts and raw operator notes.
            </p>
          </div>

          <div className="space-y-3 rounded-lg border border-border/40 bg-card/60 p-4">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="bundle-quantity" className="text-sm font-medium">
                Bundle size
              </Label>
              <Badge variant="outline" className="border-border/50 text-[0.65rem] uppercase tracking-wider text-muted-foreground">
                Suggested: {defaultBundleSize}
              </Badge>
            </div>
            <Input
              id="bundle-quantity"
              type="number"
              min={1}
              value={bundleQuantity}
              onChange={(event) => setBundleQuantity(Number(event.target.value) || 1)}
              className="h-11"
              disabled={!canRecord}
            />
            <p className="text-xs text-muted-foreground">
              Recording a bundle will add the quantity to production and update the dashboard snapshot.
            </p>
            <Button onClick={handleRecordBundle} disabled={!canRecord} className="gap-2">
              {isRecording ? <Loader2 className="h-4 w-4 animate-spin" /> : <PackageCheck className="h-4 w-4" />}
              {isRecording ? "Saving..." : "BOT FINIS (Bundle Finished)"}
            </Button>
            {printingLoading ? (
              <div className="rounded-md border border-border/40 bg-muted/30 p-3 text-xs text-muted-foreground">
                <div className="flex items-center gap-2">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  <span>Checking label printer configuration…</span>
                </div>
              </div>
            ) : printingEnabled ? (
              <div className="rounded-md border border-border/40 bg-muted/30 p-3 text-xs text-muted-foreground">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    {printerReady
                      ? `Labels will be processed (${(printingFormat ?? "pdf").toUpperCase()}) after recording this bundle.`
                      : "Configure label printing before finishing bundles."}
                  </span>
                  {onConfigurePrinter ? (
                    <Button
                      type="button"
                      variant="link"
                      size="sm"
                      className="h-auto px-0 text-xs font-semibold"
                      onClick={onConfigurePrinter}
                    >
                      Configure
                    </Button>
                  ) : null}
                </div>
              </div>
            ) : (
              <p className="rounded-md border border-dashed border-border/40 bg-muted/20 p-3 text-xs text-muted-foreground">
                Label printing is disabled in configuration.
              </p>
            )}
          </div>

        </div>

        <DialogFooter className="flex flex-col gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
      <OperatorTestResultsDialog
        open={resultsDialogOpen && !resultsError}
        onOpenChange={(openState) => setResultsDialogOpen(openState)}
        result={results}
        order={order}
        wire={wire}
        loading={resultsLoading}
        error={resultsError}
        notes={notes ?? null}
      />
    </Dialog>
  );
}
