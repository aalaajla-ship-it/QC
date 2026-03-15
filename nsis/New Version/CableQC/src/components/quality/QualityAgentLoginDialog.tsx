import { useEffect, useState } from "react";

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

interface QualityAgentLoginDialogProps {
  open: boolean;
  initialValue?: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

export function QualityAgentLoginDialog({
  open,
  initialValue,
  onSubmit,
  onCancel,
}: QualityAgentLoginDialogProps) {
  const [value, setValue] = useState(initialValue ?? "");
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (open) {
      setValue(initialValue ?? "");
      setTouched(false);
    }
  }, [initialValue, open]);

  const trimmed = value.trim();
  const disabled = trimmed.length === 0;

  const handleSubmit = () => {
    if (disabled) return;
    onSubmit(trimmed);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (!next ? onCancel() : undefined)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Quality Control</DialogTitle>
          <DialogDescription>Quality agent authentication required before recording tests.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="quality-agent-id">Quality agent identification</Label>
            <Input
              id="quality-agent-id"
              autoFocus
              placeholder="Scan or enter QA ID"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              onBlur={() => setTouched(true)}
            />
            {touched && disabled ? (
              <p className="text-xs text-destructive">Provide a valid quality agent ID to continue.</p>
            ) : null}
          </div>
        </div>

        <DialogFooter className="flex flex-col gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="button" onClick={handleSubmit} disabled={disabled}>
            Sign in
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
