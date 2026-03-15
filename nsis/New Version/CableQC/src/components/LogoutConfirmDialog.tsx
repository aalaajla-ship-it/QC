import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Loader2, LogOut } from "lucide-react";

interface LogoutConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  isProcessing?: boolean;
}

export function LogoutConfirmDialog({
  open,
  onOpenChange,
  onConfirm,
  isProcessing = false,
}: LogoutConfirmDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="border border-border/40 bg-gradient-to-b from-background/95 via-background/98 to-background/95 shadow-xl">
        <AlertDialogHeader>
          <span className="inline-flex items-center gap-2 self-start rounded-full border border-primary/20 bg-primary/10 px-3 py-1 text-xs font-semibold uppercase tracking-widest text-primary">
            <LogOut className="h-3.5 w-3.5" />
            Logout
          </span>
          <AlertDialogTitle>Sign out of CableQC System?</AlertDialogTitle>
          <AlertDialogDescription>
            Your current session will be closed and unsaved console progress may be lost. You can sign back in at any
            time using your credentials.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isProcessing}>Stay signed in</AlertDialogCancel>
          <AlertDialogAction
            onClick={(event) => {
              event.preventDefault();
              onConfirm();
            }}
            disabled={isProcessing}
            className="gap-2 bg-destructive/90 text-destructive-foreground hover:bg-destructive"
          >
            {isProcessing && <Loader2 className="h-4 w-4 animate-spin" />}
            Sign out
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
