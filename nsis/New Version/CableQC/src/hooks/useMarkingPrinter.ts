import { useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/tauri";

export interface MarkingResult {
  success: boolean;
  message: string;
}

interface UseMarkingPrinterReturn {
  sendWireMarking: (wireRef: string) => Promise<void>;
  isLoading: boolean;
  result: MarkingResult | null;
  open: boolean;
  setOpen: (open: boolean) => void;
}

export function useMarkingPrinter(): UseMarkingPrinterReturn {
  const [isLoading, setIsLoading] = useState(false);
  const [result, setResult] = useState<MarkingResult | null>(null);
  const [open, setOpen] = useState(false);

  const sendWireMarking = useCallback(
    async (wireRef: string) => {
      if (!wireRef || wireRef.trim().length === 0) {
        setResult({
          success: false,
          message: "Référence du fil vide",
        });
        setOpen(true);
        return;
      }

      setIsLoading(true);
      try {
        const response = await invoke<MarkingResult>("send_wire_marking", {
          reference: wireRef.trim(),
        });

        setResult(response);
        setOpen(true);
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        setResult({
          success: false,
          message: `Erreur lors de l'envoi: ${errorMessage}`,
        });
        setOpen(true);
      } finally {
        setIsLoading(false);
      }
    },
    []
  );

  return {
    sendWireMarking,
    isLoading,
    result,
    open,
    setOpen,
  };
}
