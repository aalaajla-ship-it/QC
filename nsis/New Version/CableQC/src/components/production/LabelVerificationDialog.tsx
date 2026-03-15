import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Printer } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { WorkOrderSummary, WireSummary } from "@/lib/types";
import { cn } from "@/lib/utils";

interface LabelVerificationDialogProps {
  open: boolean;
  order: WorkOrderSummary | null;
  wire: WireSummary | null;
  labelId: string | null;
  expectedBarcode: string | null;
  quantity: number;
  verifying: boolean;
  error: string | null;
  onVerify: (input: { barcode: string; bac: string }) => void;
  onReprint: () => void;
  onCancel: () => void;
}

export function LabelVerificationDialog({
  open,
  order,
  wire,
  labelId,
  expectedBarcode,
  quantity,
  verifying,
  error,
  onVerify,
  onReprint,
  onCancel,
}: LabelVerificationDialogProps) {
  const [barcode, setBarcode] = useState("");
  const [bac, setBac] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const barcodeInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) {
      setBarcode("");
      setBac("");
      setLocalError(null);
      window.setTimeout(() => {
        barcodeInputRef.current?.focus();
      }, 50);
    }
  }, [open, labelId, expectedBarcode]);

  const displayLabelId = useMemo(() => labelId?.trim() ?? "", [labelId]);
  const expectedValue = useMemo(() => expectedBarcode?.trim() ?? "", [expectedBarcode]);

  const handleVerify = () => {
    const trimmedBarcode = barcode.trim();
    const trimmedBac = bac.trim();
    if (!trimmedBarcode) {
      setLocalError("Scan the printed barcode before continuing.");
      return;
    }
    if (!trimmedBac) {
      setLocalError("Scan the storage bin (bac) before continuing.");
      return;
    }
    if (expectedValue && trimmedBarcode.toUpperCase() !== expectedValue.toUpperCase()) {
      setLocalError("Scanned barcode does not match the wire marking. Reprint the label if needed.");
      return;
    }
    // Retain the legacy safeguard when label IDs are available.
    if (!expectedValue && displayLabelId && trimmedBarcode.toUpperCase() !== displayLabelId.toUpperCase()) {
      setLocalError("Scanned barcode does not match the generated label. Reprint the label if needed.");
      return;
    }
    setLocalError(null);
    onVerify({ barcode: trimmedBarcode, bac: trimmedBac });
  };

  const disableActions = verifying;
  const activeError = localError ?? error ?? null;

  return (
    <Dialog open={open} onOpenChange={(next) => !disableActions && !next && onCancel()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Verify label and storage bin</DialogTitle>
          <DialogDescription>
            Confirm the bundle label is readable and capture the final storage location before moving the bundle.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="rounded-lg border border-border/40 bg-muted/30 p-3 text-xs">
            <p className="font-semibold text-foreground">{wire ? wire.refWire : "Wire"}</p>
            <div className="mt-1 grid gap-1 text-muted-foreground">
              <span>
                Order: <span className="font-medium text-foreground">{order ? `OF ${order.ofId}` : "—"}</span>
              </span>
              <span>
                Quantity recorded: <span className="font-medium text-foreground">{quantity}</span>
              </span>
              {expectedValue ? (
                <span>
                  Barcode (marquage): <span className="font-medium text-foreground">{expectedValue}</span>
                </span>
              ) : null}
              {displayLabelId ? (
                <span>
                  Label ID: <span className="font-medium text-foreground">{displayLabelId}</span>
                </span>
              ) : null}
            </div>
          </div>

          <div className="grid gap-3">
            <div className="space-y-1.5">
              <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Printed barcode</label>
              <Input
                ref={barcodeInputRef}
                value={barcode}
                onChange={(event) => setBarcode(event.target.value)}
                placeholder="Scan the barcode on the freshly printed label"
                disabled={disableActions}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    handleVerify();
                  }
                }}
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Storage bin (bac)</label>
              <Input
                value={bac}
                onChange={(event) => setBac(event.target.value)}
                placeholder="Scan the destination bin or panel identifier"
                disabled={disableActions}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    handleVerify();
                  }
                }}
              />
            </div>

            {activeError ? (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
                {activeError}
              </div>
            ) : null}
          </div>
        </div>

        <DialogFooter className="flex flex-col gap-2 pt-4 sm:flex-row sm:justify-between">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-2"
            disabled={disableActions}
            onClick={() => {
              setLocalError(null);
              onReprint();
            }}
          >
            {disableActions ? <Loader2 className="h-4 w-4 animate-spin" /> : <Printer className="h-4 w-4" />}
            Reprint label
          </Button>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button type="button" variant="outline" onClick={onCancel} disabled={disableActions}>
              Cancel
            </Button>
            <Button type="button" className={cn("gap-2", disableActions && "cursor-wait") } onClick={handleVerify} disabled={disableActions}>
              {disableActions ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {disableActions ? "Saving…" : "Verify and continue"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
