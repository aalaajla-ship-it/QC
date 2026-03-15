import { useState, useMemo } from "react";
import { Loader2, ArrowRightCircle, X } from "lucide-react";

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
import { type TestResult, getMicroscopePhoto } from "@/lib/api";
import { type WorkOrderSummary, type WireSummary } from "@/lib/types";
import {
  MEASUREMENT_LABELS,
  formatMeasurementValue,
  formatSpec,
} from "@/components/production/testResultUtils";

interface OperatorTestResultsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  result: TestResult | null;
  order: WorkOrderSummary | null;
  wire: WireSummary | null;
  loading?: boolean;
  error?: string | null;
  notes?: Record<string, string> | null;
}

function normalizeNotes(notes?: Record<string, string> | null) {
  if (!notes) return [] as Array<[string, string]>;
  return Object.entries(notes)
    .map(([key, value]) => [key?.trim(), value?.toString().trim()] as const)
    .filter(([key, value]) => Boolean(key) && Boolean(value));
}

function isImagePath(value: string) {
  const lower = value.toLowerCase();
  return lower.endsWith(".jpg") || lower.endsWith(".jpeg") || lower.endsWith(".png") || lower.endsWith(".bmp");
}

export function OperatorTestResultsDialog({
  open,
  onOpenChange,
  result,
  order,
  wire,
  loading = false,
  error,
  notes,
}: OperatorTestResultsDialogProps) {
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [fetchingImage, setFetchingImage] = useState(false);

  const overallStatus = useMemo(() => {
    if (!result) return null;
    if (result.status && result.status.trim().length > 0) {
      return result.status.trim().toUpperCase();
    }
    if (result.overallPassed === true) return "OK";
    if (result.overallPassed === false) return "NOK";
    return null;
  }, [result]);

  const measurementRows = useMemo(() => {
    if (!result) return [] as Array<{ key: string; label: string; valueText: string; specText: string | null; verdict: TestResult["verdicts"][number] }>;
    return result.verdicts.map((verdict) => {
      const label = MEASUREMENT_LABELS[verdict.key] ?? verdict.key;
      const valueText = formatMeasurementValue(verdict.value, verdict.unit);
      const specText = formatSpec(verdict);
      return { key: verdict.key, label, valueText, specText, verdict };
    });
  }, [result]);

  const formattedNotes = useMemo(() => normalizeNotes(notes), [notes]);

  const handleShowPhoto = async (path: string) => {
    try {
      setFetchingImage(true);
      const dataUrl = await getMicroscopePhoto(path);
      setPreviewImage(dataUrl);
    } catch (err) {
      console.error("Failed to load photo:", err);
    } finally {
      setFetchingImage(false);
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Operator test results</DialogTitle>
            <DialogDescription>
              {wire ? `${wire.refWire} · ${wire.marquage}` : "Measurements recorded during the operator test"}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="rounded-lg border border-border/50 bg-muted/20 p-4 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="space-y-1">
                  <p className="font-semibold text-foreground">
                    {order ? `${order.ofId} · ${order.reference}` : "Current work order"}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Operator measurements compared with Crimp DB tolerances.
                  </p>
                </div>
                {overallStatus ? (
                  <Badge
                    variant="outline"
                    className={`border-border/60 text-[0.65rem] uppercase tracking-widest ${overallStatus === "OK"
                        ? "border-success/40 text-success"
                        : overallStatus === "NOK"
                          ? "border-destructive/40 text-destructive"
                          : "text-muted-foreground"
                      }`}
                  >
                    {overallStatus === "OK"
                      ? "All valid"
                      : overallStatus === "NOK"
                        ? "Check measurements"
                        : overallStatus}
                  </Badge>
                ) : null}
              </div>
            </div>

            {loading ? (
              <div className="flex items-center gap-2 rounded-lg border border-border/40 bg-muted/30 p-4 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading operator measurements…
              </div>
            ) : error ? (
              <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
                {error}
              </div>
            ) : (
              <div className="max-h-[60vh] overflow-y-auto rounded-lg border border-border/40 bg-card/60">
                <div className="space-y-3 p-4">
                  {measurementRows.length > 0 ? (
                    measurementRows.map(({ key, label, valueText, specText, verdict }) => {
                      const status = verdict.passed === true ? "Valid" : verdict.passed === false ? "Invalid" : "N/A";
                      const badgeClass =
                        verdict.passed === true
                          ? "border-success/40 text-success"
                          : verdict.passed === false
                            ? "border-destructive/40 text-destructive"
                            : "border-border/40 text-muted-foreground";

                      return (
                        <div key={key} className="rounded-lg border border-border/40 bg-background/80 p-3">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="min-w-0">
                              <p className="text-sm font-medium text-foreground">{label}</p>
                              <p className="text-xs text-muted-foreground">
                                {specText ?? "No tolerance configured for this measurement."}
                              </p>
                            </div>
                            <Badge variant="outline" className={`${badgeClass} text-[0.65rem] uppercase tracking-widest`}>
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
                      No saved operator measurements for this wire.
                    </div>
                  )}

                  {formattedNotes.length > 0 ? (
                    <div className="space-y-2">
                      <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Raw notes</h3>
                      <div className="space-y-1 text-sm">
                        {formattedNotes.map(([key, value]) => {
                          const isPath = isImagePath(value);
                          return (
                            <div key={key} className="flex items-center justify-between gap-4">
                              <span className="text-muted-foreground">{key}</span>
                              <div className="flex items-center gap-2">
                                <span className="max-w-[150px] truncate font-medium text-foreground" title={value}>
                                  {isPath ? "Microscope Photo" : value}
                                </span>
                                {isPath && (
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-6 w-6 text-primary"
                                    onClick={() => handleShowPhoto(value)}
                                    disabled={fetchingImage}
                                  >
                                    {fetchingImage ? (
                                      <Loader2 className="h-4 w-4 animate-spin" />
                                    ) : (
                                      <ArrowRightCircle className="h-4 w-4" />
                                    )}
                                  </Button>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>
            )}
          </div>

          <DialogFooter className="mt-2 flex flex-col gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Photo Preview Modal */}
      <Dialog open={Boolean(previewImage)} onOpenChange={(open) => !open && setPreviewImage(null)}>
        <DialogContent className="max-w-4xl border-none bg-black/90 p-0 overflow-hidden">
          <div className="relative flex h-[80vh] w-full items-center justify-center p-4">
            <Button
              variant="secondary"
              size="icon"
              className="absolute right-4 top-4 z-50 rounded-full"
              onClick={() => setPreviewImage(null)}
            >
              <X className="h-4 w-4" />
            </Button>
            {previewImage && (
              <img
                src={previewImage}
                alt="Microscope Zoom"
                className="h-full w-full object-contain"
              />
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

