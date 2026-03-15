import { useEffect, useMemo, useState } from "react";
import { Loader2, Printer, Scan } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import type { WireSummary, WorkOrderSummary } from "@/lib/types";
import { useMarkingPrinter } from "@/hooks/useMarkingPrinter";
import { MarkingResultDialog } from "@/components/production/MarkingResultDialog";

interface WireValidationDialogProps {
  open: boolean;
  wire: WireSummary | null;
  order: WorkOrderSummary | null;
  isSubmitting: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (coilId: string) => Promise<void> | void;
}

function describeColor(wire: WireSummary | null): string {
  if (!wire) return "—";
  const parts = [wire.colorPrimary, wire.colorSecondary].filter(
    (part): part is string => Boolean(part && part.trim()),
  );
  if (parts.length === 0) return "Not specified";
  return parts.join(" / ");
}

export function WireValidationDialog({
  open,
  wire,
  order,
  isSubmitting,
  onOpenChange,
  onConfirm,
}: WireValidationDialogProps) {
  const [coilInput, setCoilInput] = useState("");
  const [override, setOverride] = useState(false);
  const [markingSent, setMarkingSent] = useState(false);

  const {
    sendWireMarking,
    isLoading: markingLoading,
    result: markingResult,
    open: markingDialogOpen,
    setOpen: setMarkingDialogOpen,
  } = useMarkingPrinter();

  useEffect(() => {
    if (open) {
      setCoilInput("");
      setOverride(false);
      setMarkingSent(false);
    }
  }, [open, wire?.id]);

  useEffect(() => {
    if (markingResult?.success) {
      setMarkingSent(true);
    }
  }, [markingResult]);

  const targetSection = useMemo(() => {
    if (!wire?.section) return "—";
    return `${wire.section.toFixed(2)} mm²`;
  }, [wire?.section]);

  const targetLength = useMemo(() => {
    if (!wire) return "—";
    return `${wire.lengthMm} mm ±5`;
  }, [wire]);

  const coilMatch = useMemo(() => {
    if (!wire?.refCoil) return false;
    // Compare only the first 8 characters
    const inputFirst8 = coilInput.trim().toLowerCase().substring(0, 8);
    const refCoilFirst8 = wire.refCoil.trim().toLowerCase().substring(0, 8);
    return inputFirst8 === refCoilFirst8 && inputFirst8.length === 8;
  }, [coilInput, wire?.refCoil]);

  const extType = wire?.ext1?.kind ?? wire?.ext2?.kind ?? null;

  const disableConfirm = !override && !coilMatch;

  return (
    <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader className="space-y-2">
          <DialogTitle className="flex items-center gap-2 text-lg">
            <Scan className="h-5 w-5 text-primary" />
            Validate Wire For Production
          </DialogTitle>
          <DialogDescription>
            Confirm that the physical coil matches the order specifications before starting production.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <section className="grid gap-3 rounded-lg border border-border/50 bg-muted/20 p-4 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Order</span>
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="border-border/60">
                  {order?.ofId ?? "—"}
                </Badge>
                <Badge variant="outline" className="border-border/60">
                  {order?.reference ?? "—"}
                </Badge>
              </div>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Wire Reference</span>
              <span className="font-medium text-foreground">{wire?.refWire ?? "—"}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Coil ID</span>
              <span className="font-medium text-foreground">{wire?.refCoil ?? "—"}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Section</span>
              <span className="font-medium text-foreground">{targetSection}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Color</span>
              <span className="font-medium text-foreground">{describeColor(wire)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Length</span>
              <span className="font-medium text-foreground">{targetLength}</span>
            </div>
            {extType ? (
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Process</span>
                <span className="font-medium capitalize text-foreground">{extType}</span>
              </div>
            ) : null}
          </section>

          <section className="space-y-2">
            <Label htmlFor="coilInput">Scan or enter coil identifier</Label>
            <Input
              id="coilInput"
              autoFocus
              value={coilInput}
              onChange={(event) => setCoilInput(event.target.value)}
              placeholder="Scan coil barcode…"
              className={cn(
                "uppercase tracking-wide",
                coilInput && !coilMatch && !override && "border-destructive/60 text-destructive",
              )}
            />
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>
                Expected coil: <span className="font-medium uppercase text-foreground">{wire?.refCoil ?? "—"}</span>
              </span>
              {coilInput ? (
                <span
                  className={cn(
                    "font-semibold uppercase",
                    coilMatch ? "text-success" : override ? "text-warning" : "text-destructive",
                  )}
                >
                  {coilMatch ? "Match confirmed" : override ? "Manual override" : "Mismatch"}
                </span>
              ) : null}
            </div>
          </section>

          {!coilMatch ? (
            <button
              type="button"
              className="inline-flex w-full items-center justify-center rounded-md border border-border/60 bg-muted/10 px-3 py-2 text-xs font-medium text-muted-foreground transition hover:bg-muted/20"
              onClick={() => setOverride((prev) => !prev)}
            >
              {override ? "Disable override (require coil scan)" : "Override coil check (authorized only)"}
            </button>
          ) : null}

          <Separator />

          <div className="grid gap-2 rounded-md bg-muted/30 p-3 text-xs leading-relaxed text-muted-foreground">
            <span className="font-medium text-foreground">Marking</span>
            <span className="text-sm text-foreground">{wire?.marquage ?? "—"}</span>
            <span>
              Ensure the printed marking matches the order before proceeding with validation. Operator tests become available only after this step.
            </span>
          </div>
        </div>

        <DialogFooter className="mt-4 flex flex-col gap-3">
          <div className="flex items-center justify-between gap-2 rounded-md bg-muted/30 p-3">
            <div>
              <p className="text-sm font-semibold text-foreground">Send to Marker</p>
              <p className="text-xs text-muted-foreground">Send the marking text to the wire marker printer.</p>
            </div>
          </div>
          <Button 
            onClick={() => wire && sendWireMarking(wire.refWire)} 
            disabled={!wire || markingLoading || isSubmitting}
            variant="secondary"
            className="gap-2 w-full"
          >
            {markingLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Printer className="h-4 w-4" />}
            {markingLoading ? "Sending..." : "Send Marking"}
          </Button>
          <div className="flex gap-2 sm:justify-end">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting || markingLoading}>
              Cancel
            </Button>
            <Button
              onClick={() => onConfirm(coilInput)}
              disabled={disableConfirm || isSubmitting || markingLoading || !markingSent}
            >
              {isSubmitting ? "Validating…" : "Validate Wire"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    
    <MarkingResultDialog
      open={markingDialogOpen}
      onOpenChange={setMarkingDialogOpen}
      result={markingResult}
    />
  </>
  );
}
