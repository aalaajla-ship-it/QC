import { AlertCircle, CheckCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export interface MarkingResultDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  result: {
    success: boolean;
    message: string;
  } | null;
}

export function MarkingResultDialog({
  open,
  onOpenChange,
  result,
}: MarkingResultDialogProps) {
  if (!result) {
    return null;
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader className="space-y-2">
          <div className="flex items-center gap-2">
            {result.success ? (
              <CheckCircle className="h-5 w-5 text-success" />
            ) : (
              <AlertCircle className="h-5 w-5 text-destructive" />
            )}
            <DialogTitle>
              {result.success ? "Succès" : "Erreur"}
            </DialogTitle>
          </div>
        </DialogHeader>

        <DialogDescription className="text-base text-foreground">
          {result.message}
        </DialogDescription>

        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>Fermer</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
