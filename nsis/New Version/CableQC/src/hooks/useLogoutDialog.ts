import { useCallback, useEffect, useRef, useState } from "react";

import { useLogoutAction } from "@/hooks/useLogoutAction";

export function useLogoutDialog() {
  const executeLogout = useLogoutAction();
  const [open, setOpen] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const isMountedRef = useRef(true);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const requestLogout = useCallback(() => {
    if (!isProcessing) {
      setOpen(true);
    }
  }, [isProcessing]);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (isProcessing && !nextOpen) {
        return;
      }
      setOpen(nextOpen);
    },
    [isProcessing],
  );

  const confirmLogout = useCallback(async () => {
    if (isProcessing) {
      return;
    }
    setIsProcessing(true);
    try {
      await executeLogout();
    } finally {
      if (isMountedRef.current) {
        setIsProcessing(false);
        setOpen(false);
      }
    }
  }, [executeLogout, isProcessing]);

  return {
    open,
    isProcessing,
    requestLogout,
    confirmLogout,
    setOpen: handleOpenChange,
  };
}
