import { useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";

import { useAppFlow } from "@/context/AppFlowContext";
import { useToast } from "@/components/ui/use-toast";
import { logout } from "@/lib/api";

export function useLogoutAction() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { reset } = useAppFlow();
  const { toast } = useToast();

  return useCallback(async () => {
    try {
      await logout();
    } catch (error) {
      console.warn("Logout failed", error);
    } finally {
      reset();
      queryClient.clear();
      navigate("/login", { replace: true });
      toast({
        title: "Session closed",
        description: "You have been logged out of CableQC System.",
      });
    }
  }, [navigate, queryClient, reset, toast]);
}
