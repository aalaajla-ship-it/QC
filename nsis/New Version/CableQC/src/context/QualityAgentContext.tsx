import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

import { QualityAgentLoginDialog } from "@/components/quality/QualityAgentLoginDialog";

interface QualityAgentContextValue {
  qualityAgentId: string | null;
  ensureAgent: () => Promise<string>;
  promptAgent: (options?: { initialValue?: string }) => Promise<string>;
  setQualityAgentId: (value: string | null) => void;
  clearQualityAgent: () => void;
}

const QualityAgentContext = createContext<QualityAgentContextValue | undefined>(undefined);

type Resolver = {
  resolve: (value: string) => void;
  reject: (reason?: unknown) => void;
};

interface QualityAgentProviderProps {
  children: ReactNode;
  defaultAgentId?: string | null;
}

export function QualityAgentProvider({ children, defaultAgentId = null }: QualityAgentProviderProps) {
  const [qualityAgentId, setQualityAgentId] = useState<string | null>(defaultAgentId);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogInitialValue, setDialogInitialValue] = useState<string | undefined>(undefined);
  const resolverRef = useRef<Resolver | null>(null);

  const closeDialog = useCallback(() => {
    setDialogOpen(false);
    setDialogInitialValue(undefined);
  }, []);

  const resolvePending = useCallback(
    (value: string) => {
      resolverRef.current?.resolve(value);
      resolverRef.current = null;
    },
    [],
  );

  const rejectPending = useCallback(() => {
    resolverRef.current?.reject(new Error("Quality agent authentication required."));
    resolverRef.current = null;
  }, []);

  const promptAgent = useCallback(
    (options?: { initialValue?: string }) => {
      const nextInitial = options?.initialValue ?? qualityAgentId ?? undefined;
      setDialogInitialValue(nextInitial);
      setDialogOpen(true);
      return new Promise<string>((resolve, reject) => {
        resolverRef.current = { resolve, reject };
      });
    },
    [qualityAgentId],
  );

  const ensureAgent = useCallback(() => {
    if (qualityAgentId && qualityAgentId.trim().length > 0) {
      return Promise.resolve(qualityAgentId);
    }
    return promptAgent();
  }, [promptAgent, qualityAgentId]);

  const handleSubmit = useCallback(
    (value: string) => {
      const normalized = value.trim();
      setQualityAgentId(normalized);
      closeDialog();
      resolvePending(normalized);
    },
    [closeDialog, resolvePending],
  );

  const handleCancel = useCallback(() => {
    closeDialog();
    rejectPending();
  }, [closeDialog, rejectPending]);

  const clearQualityAgent = useCallback(() => {
    setQualityAgentId(null);
  }, []);

  const value = useMemo<QualityAgentContextValue>(
    () => ({
      qualityAgentId,
      ensureAgent,
      promptAgent,
      setQualityAgentId,
      clearQualityAgent,
    }),
    [clearQualityAgent, ensureAgent, promptAgent, qualityAgentId],
  );

  return (
    <QualityAgentContext.Provider value={value}>
      {children}
      <QualityAgentLoginDialog
        open={dialogOpen}
        initialValue={dialogInitialValue}
        onSubmit={handleSubmit}
        onCancel={handleCancel}
      />
    </QualityAgentContext.Provider>
  );
}

export function useQualityAgent() {
  const context = useContext(QualityAgentContext);
  if (!context) {
    throw new Error("useQualityAgent must be used within a QualityAgentProvider");
  }
  return context;
}
