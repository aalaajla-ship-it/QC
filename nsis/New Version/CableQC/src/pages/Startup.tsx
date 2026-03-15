import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AlertCircle, CheckCircle2, RefreshCcw, ShieldCheck, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/components/ui/use-toast";
import { performPreflight, type PreflightReport } from "@/lib/api";
import { useAppFlow } from "@/context/AppFlowContext";

type ValidationKey = keyof PreflightReport;

const validationOrder: ValidationKey[] = ["appDb", "crimpDb", "api", "sharedFolder", "microscopeFolder"];

const validationLabels: Record<ValidationKey, string> = {
  appDb: "App DB",
  crimpDb: "Crimp DB",
  api: "API",
  sharedFolder: "Shared Folder",
  microscopeFolder: "Microscope Photo",
};

const statusIcons = {
  ok: <CheckCircle2 className="h-5 w-5 flex-shrink-0 text-success" />,
  warn: <TriangleAlert className="h-5 w-5 flex-shrink-0 text-warning" />,
  error: <AlertCircle className="h-5 w-5 flex-shrink-0 text-destructive" />,
};

function assessStatus(ok: boolean, critical: boolean) {
  if (ok) return "ok";
  return critical ? "error" : "warn";
}

export default function Startup() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { state, setPreflight, acknowledgePreflight } = useAppFlow();

  const [report, setReport] = useState<PreflightReport | undefined>(state.preflight);
  const [loading, setLoading] = useState(!state.preflight);
  const [error, setError] = useState<string | null>(null);

  const criticalKeys: ValidationKey[] = ["appDb", "crimpDb", "api"];

  const allOk = useMemo(() => {
    if (!report) return false;
    return validationOrder.every((key) => report[key].ok);
  }, [report]);

  const runValidation = async () => {
    try {
      setLoading(true);
      setError(null);
      const result = await performPreflight();
      setReport(result);
      setPreflight(result);
      if (!result.appDb.ok || !result.crimpDb.ok || !result.api.ok) {
        toast({
          title: "Validation issues detected",
          description: "Review the highlighted checks before continuing.",
          variant: "destructive",
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unexpected error during validation.";
      setError(message);
      toast({
        title: "Validation failed",
        description: message,
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!report) {
      runValidation();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleContinue = () => {
    if (
      true
      // allOk

    ) {
      acknowledgePreflight();
      navigate("/orders");
    } else {
      toast({
        title: "Pending checks",
        description: "Resolve the failing checks before continuing.",
        variant: "destructive",
      });
    }
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-gradient-to-br from-background to-muted/20 p-4 sm:p-8">
      <Card className="w-full max-w-3xl border border-border/40 bg-card/80 shadow-xl backdrop-blur">
        <CardHeader className="flex flex-row items-center justify-between border-b border-border/30">
          <div>
            <CardTitle className="text-lg font-semibold text-foreground">System Validation</CardTitle>
            <CardDescription className="text-sm text-muted-foreground">
              Verifying connectivity to databases, APIs, and shared resources
            </CardDescription>
          </div>

          <div className="flex gap-2">
            <Button variant="outline" size="sm" className="gap-1.5 text-xs" onClick={runValidation} disabled={loading}>
              <RefreshCcw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
              Re-run
            </Button>
            <Button size="sm" className="text-xs" onClick={handleContinue}
            // disabled={loading || !allOk}
            >
              Continue
            </Button>
          </div>
        </CardHeader>

        <CardContent className="space-y-4 pt-6">
          {error && (
            <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
              {error}
            </div>
          )}

          <div className="grid gap-2.5 md:grid-cols-2">
            {validationOrder.map((key) => {
              const status = report?.[key];
              const statusType = assessStatus(status?.ok ?? false, criticalKeys.includes(key));
              const icon = statusIcons[statusType];

              return (
                <div
                  key={key}
                  className={`flex items-start gap-2.5 rounded-lg border border-border/40 bg-background/80 p-3 transition ${statusType === "ok"
                    ? "border-success/30"
                    : statusType === "warn"
                      ? "border-warning/30"
                      : "border-destructive/30"
                    }`}
                >
                  {icon}
                  <div>
                    <p className="text-xs font-semibold capitalize text-foreground">{validationLabels[key]}</p>
                    <p className="text-xs text-muted-foreground">
                      {status?.message ?? "Waiting..."}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
