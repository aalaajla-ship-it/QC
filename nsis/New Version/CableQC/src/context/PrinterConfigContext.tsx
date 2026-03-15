import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { PrinterConfigDialog } from "@/components/printer/PrinterConfigDialog";
import { useToast } from "@/components/ui/use-toast";
import {
  fetchLabelPrinterSettings,
  saveLabelPrinterSettings,
  type LabelPrinterSettingsResponse,
  type LabelPrinterTsplSettings,
  type SaveLabelPrinterSettingsPayload,
} from "@/lib/api";

export interface LabelPrintingState {
  enabled: boolean;
  resolvedFormat: string;
  labelFormat: string | null;
  printerName: string | null;
  defaultFormat: string | null;
  ready: boolean;
  loading: boolean;
  error?: string;
  tspl: LabelPrinterTsplSettings;
}

interface PrinterDialogOptions {
  onSaved?: () => void;
}

interface PrinterConfigContextValue {
  state: LabelPrintingState;
  refresh: () => Promise<void>;
  openDialog: (options?: PrinterDialogOptions) => void;
  closeDialog: () => void;
  dialogOpen: boolean;
  saving: boolean;
}

const PrinterConfigContext = createContext<PrinterConfigContextValue | undefined>(undefined);

const DEFAULT_TSPL_SETTINGS: LabelPrinterTsplSettings = {
  widthMm: 100,
  heightMm: 18,
  gapMm: 2,
  speed: 4,
  density: 8,
  direction: 1,
};

function normalizeLabelSettings(response: LabelPrinterSettingsResponse): LabelPrintingState {
  const resolvedFormat = (response.resolvedFormat ?? response.labelFormat ?? response.defaultFormat ?? "pdf")
    .trim()
    .toLowerCase();
  const enabled = response.enabled;
  const printerName = response.labelPrinterName ?? null;
  const requiresPrinter = resolvedFormat === "direct";
  const ready = !enabled || !requiresPrinter || Boolean(printerName && printerName.trim().length > 0);
  const tspl = response.tsplSettings ?? DEFAULT_TSPL_SETTINGS;
  return {
    enabled,
    resolvedFormat,
    labelFormat: response.labelFormat ?? null,
    printerName,
    defaultFormat: response.defaultFormat ?? null,
    ready,
    loading: false,
    error: undefined,
    tspl: { ...tspl },
  };
}

export function PrinterConfigProvider({ children }: { children: ReactNode }) {
  const { toast } = useToast();
  const [state, setState] = useState<LabelPrintingState>({
    enabled: false,
    resolvedFormat: "pdf",
    labelFormat: null,
    printerName: null,
    defaultFormat: null,
    ready: true,
    loading: true,
    tspl: { ...DEFAULT_TSPL_SETTINGS },
  });
  const [dialogOpen, setDialogOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const onSavedRef = useRef<(() => void) | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetchLabelPrinterSettings();
      setState(normalizeLabelSettings(response));
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to load label printer settings.";
      setState((prev) => ({ ...prev, loading: false, error: message }));
      toast({
        title: "Printer settings",
        description: message,
        variant: "destructive",
      });
    }
  }, [toast]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const openDialog = useCallback((options?: PrinterDialogOptions) => {
    onSavedRef.current = options?.onSaved ?? null;
    setDialogOpen(true);
  }, []);

  const closeDialog = useCallback(() => {
    setDialogOpen(false);
    onSavedRef.current = null;
  }, []);

  const handleSubmit = useCallback(
    async (values: SaveLabelPrinterSettingsPayload) => {
      setSaving(true);
      try {
        const payload: SaveLabelPrinterSettingsPayload = {
          ...values,
          tsplSettings: values.tsplSettings ?? state.tspl ?? DEFAULT_TSPL_SETTINGS,
        };
        const response = await saveLabelPrinterSettings(payload);
        const normalized = normalizeLabelSettings(response);
        setState(normalized);
        toast({
          title: "Printer settings updated",
          description: `Labels will use ${normalized.resolvedFormat.toUpperCase()} format.`,
        });
        setDialogOpen(false);
        const callback = onSavedRef.current;
        onSavedRef.current = null;
        if (callback) {
          callback();
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unable to save printer settings.";
        toast({ title: "Save failed", description: message, variant: "destructive" });
      } finally {
        setSaving(false);
      }
    },
    [state.tspl, toast],
  );

  const value = useMemo(
    () => ({ state, refresh, openDialog, closeDialog, dialogOpen, saving }),
    [state, refresh, openDialog, closeDialog, dialogOpen, saving],
  );

  return (
    <PrinterConfigContext.Provider value={value}>
      {children}
      <PrinterConfigDialog
        open={dialogOpen}
        currentFormat={state.labelFormat ?? state.resolvedFormat}
        currentPrinter={state.printerName}
        currentTspl={state.tspl}
        defaultFormat={state.defaultFormat ?? undefined}
        saving={saving}
        onClose={() => {
          if (!saving) {
            closeDialog();
          }
        }}
        onSubmit={handleSubmit}
      />
    </PrinterConfigContext.Provider>
  );
}

export function usePrinterConfig(): PrinterConfigContextValue {
  const context = useContext(PrinterConfigContext);
  if (!context) {
    throw new Error("usePrinterConfig must be used within a PrinterConfigProvider");
  }
  return context;
}
