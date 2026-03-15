import { useEffect, useMemo, useState, type ChangeEvent } from "react";
import { Loader2, RefreshCw } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { listLabelPrinters, type LabelPrinterTsplSettings } from "@/lib/api";

interface PrinterConfigDialogProps {
  open: boolean;
  currentFormat: string;
  currentPrinter?: string | null;
  currentTspl?: LabelPrinterTsplSettings;
  defaultFormat?: string | null;
  saving?: boolean;
  onClose: () => void;
  onSubmit: (
    values: {
      labelFormat: string;
      labelPrinterName: string | null;
      tsplSettings: LabelPrinterTsplSettings;
    },
  ) => Promise<void> | void;
}

const FORMAT_OPTIONS = [
  { value: "pdf", label: "PDF (save file)" },
  { value: "direct", label: "Direct to printer" },
  { value: "png", label: "PNG image" },
];

const DEFAULT_TSPL: LabelPrinterTsplSettings = {
  widthMm: 100,
  heightMm: 18,
  gapMm: 2,
  speed: 4,
  density: 8,
  direction: 1,
};

export function PrinterConfigDialog({
  open,
  currentFormat,
  currentPrinter,
  currentTspl,
  defaultFormat,
  saving = false,
  onClose,
  onSubmit,
}: PrinterConfigDialogProps) {
  const normalizedCurrentFormat = currentFormat.trim().toLowerCase() || defaultFormat?.toLowerCase() || "pdf";
  const [format, setFormat] = useState<string>(normalizedCurrentFormat);
  const [printerName, setPrinterName] = useState<string>(currentPrinter ?? "");
  const [printers, setPrinters] = useState<string[]>([]);
  const [loadingPrinters, setLoadingPrinters] = useState(false);
  const [printersError, setPrintersError] = useState<string | null>(null);
  const [tspl, setTspl] = useState<LabelPrinterTsplSettings>(currentTspl ?? DEFAULT_TSPL);

  useEffect(() => {
    if (!open) return;
    setFormat(normalizedCurrentFormat);
    setPrinterName(currentPrinter ?? "");
    setTspl(currentTspl ?? DEFAULT_TSPL);
    let cancelled = false;
    const fetchPrinters = async () => {
      setLoadingPrinters(true);
      setPrintersError(null);
      try {
        const detected = await listLabelPrinters();
        if (!cancelled) {
          const unique = Array.from(new Set(detected)).sort((a, b) => a.localeCompare(b));
          setPrinters(unique);
        }
      } catch (error) {
        if (!cancelled) {
          const message =
            error instanceof Error ? error.message : "Unable to load printers. Enter a printer name manually.";
          setPrintersError(message);
          setPrinters([]);
        }
      } finally {
        if (!cancelled) {
          setLoadingPrinters(false);
        }
      }
    };
    void fetchPrinters();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, currentPrinter, currentTspl, normalizedCurrentFormat]);

  const requiresPrinter = useMemo(() => format === "direct", [format]);
  const normalizedPrinter = printerName.trim();
  const tsplValid = useMemo(() => {
    const widthValid = Number.isFinite(tspl.widthMm) && tspl.widthMm > 0;
    const heightValid = Number.isFinite(tspl.heightMm) && tspl.heightMm > 0;
    const gapValid = Number.isFinite(tspl.gapMm) && tspl.gapMm >= 0;
    const speedValid = Number.isFinite(tspl.speed) && tspl.speed >= 1;
    const densityValid = Number.isFinite(tspl.density) && tspl.density >= 0;
    const directionValid = tspl.direction === 0 || tspl.direction === 1;
    return widthValid && heightValid && gapValid && speedValid && densityValid && directionValid;
  }, [tspl]);
  const readyToSave =
    !saving && (!requiresPrinter || normalizedPrinter.length > 0) && (!requiresPrinter || tsplValid);

  const parseFloatOrZero = (value: string) => {
    if (value.trim().length === 0) return 0;
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
  };

  const parseIntOrZero = (value: string) => {
    if (value.trim().length === 0) return 0;
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  };

  const handleNumberChange = (
    key: keyof LabelPrinterTsplSettings,
    parser: (value: string) => number,
  ) =>
    (event: ChangeEvent<HTMLInputElement>) => {
      const next = parser(event.target.value);
      setTspl((prev) => ({ ...prev, [key]: next }));
    };

  const handleSubmit = async () => {
    if (!readyToSave) return;
    const payload = {
      labelFormat: format,
      labelPrinterName: normalizedPrinter.length > 0 ? normalizedPrinter : null,
      tsplSettings: tspl,
    };
    await onSubmit(payload);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => {
      if (!next && !saving) {
        onClose();
      }
    }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Label Printing Settings</DialogTitle>
          <DialogDescription>
            Select the output format and printer to use when finishing bundles.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="label-format">Label format</Label>
            <Select value={format} onValueChange={setFormat}>
              <SelectTrigger id="label-format">
                <SelectValue placeholder="Select format" />
              </SelectTrigger>
              <SelectContent>
                {FORMAT_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {defaultFormat && (
              <p className="text-xs text-muted-foreground">
                Default from configuration: <strong>{defaultFormat.toUpperCase()}</strong>
              </p>
            )}
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="printer-name">Printer (optional)</Label>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="gap-1 text-xs"
                onClick={() => {
                  setLoadingPrinters(true);
                  setPrintersError(null);
                  listLabelPrinters()
                    .then((detected) => {
                      const unique = Array.from(new Set(detected)).sort((a, b) => a.localeCompare(b));
                      setPrinters(unique);
                    })
                    .catch((error) => {
                      const message =
                        error instanceof Error
                          ? error.message
                          : "Unable to load printers. Enter a printer name manually.";
                      setPrintersError(message);
                      setPrinters([]);
                    })
                    .finally(() => setLoadingPrinters(false));
                }}
                disabled={loadingPrinters}
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Refresh
              </Button>
            </div>
            <Input
              id="printer-name"
              value={printerName}
              onChange={(event) => setPrinterName(event.target.value)}
              placeholder={requiresPrinter ? "Required for direct printing" : "Leave blank to use default"}
              disabled={saving}
            />
            {requiresPrinter ? (
              <p className="text-xs text-muted-foreground">
                Direct printing requires a configured printer. Choose from the detected list or enter a printer queue name.
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                Leave blank to skip printer selection when saving to files.
              </p>
            )}
            {loadingPrinters ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Detecting printers…
              </div>
            ) : null}
            {printersError ? (
              <p className="text-xs text-destructive">{printersError}</p>
            ) : null}
            {printers.length > 0 ? (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">Detected printers</p>
                <div className="flex flex-wrap gap-2">
                  {printers.map((name) => {
                    const selected = name === printerName;
                    return (
                      <Badge
                        key={name}
                        variant={selected ? "default" : "outline"}
                        className="cursor-pointer select-none"
                        onClick={() => setPrinterName(name)}
                      >
                        {name}
                      </Badge>
                    );
                  })}
                </div>
              </div>
            ) : null}
          </div>

          {format === "direct" ? (
            <div className="space-y-3 rounded-md border border-border/40 p-3">
              <div className="space-y-1">
                <Label>TSPL options</Label>
                <p className="text-xs text-muted-foreground">
                  Configure the label dimensions and printer commands used for direct TSPL output.
                </p>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="tspl-width">Width (mm)</Label>
                  <Input
                    id="tspl-width"
                    type="number"
                    min={1}
                    step={0.1}
                    value={tspl.widthMm}
                    onChange={handleNumberChange("widthMm", parseFloatOrZero)}
                    disabled={saving}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="tspl-height">Height (mm)</Label>
                  <Input
                    id="tspl-height"
                    type="number"
                    min={1}
                    step={0.1}
                    value={tspl.heightMm}
                    onChange={handleNumberChange("heightMm", parseFloatOrZero)}
                    disabled={saving}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="tspl-gap">Gap (mm)</Label>
                  <Input
                    id="tspl-gap"
                    type="number"
                    min={0}
                    step={0.1}
                    value={tspl.gapMm}
                    onChange={handleNumberChange("gapMm", parseFloatOrZero)}
                    disabled={saving}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="tspl-speed">Speed</Label>
                  <Input
                    id="tspl-speed"
                    type="number"
                    min={1}
                    max={12}
                    value={tspl.speed}
                    onChange={handleNumberChange("speed", parseIntOrZero)}
                    disabled={saving}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="tspl-density">Density</Label>
                  <Input
                    id="tspl-density"
                    type="number"
                    min={0}
                    max={15}
                    value={tspl.density}
                    onChange={handleNumberChange("density", parseIntOrZero)}
                    disabled={saving}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="tspl-direction">Direction</Label>
                  <Select
                    value={tspl.direction.toString()}
                    onValueChange={(value) =>
                      setTspl((prev) => ({ ...prev, direction: Number.parseInt(value, 10) }))
                    }
                    disabled={saving}
                  >
                    <SelectTrigger id="tspl-direction">
                      <SelectValue placeholder="Select direction" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="0">Normal (0)</SelectItem>
                      <SelectItem value="1">Reverse (1)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                These values control the TSPL <code>SIZE</code>, <code>GAP</code>, <code>SPEED</code>, and <code>DENSITY</code>
                commands before your template runs.
              </p>
              {!tsplValid ? (
                <p className="text-xs text-destructive">Enter valid TSPL parameters to continue.</p>
              ) : null}
            </div>
          ) : null}
        </div>

        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" disabled={saving} onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" disabled={!readyToSave} onClick={handleSubmit}>
            {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
