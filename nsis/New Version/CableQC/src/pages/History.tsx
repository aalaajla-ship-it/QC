import { type FormEvent, useMemo, useState } from "react";
import { type InfiniteData, useInfiniteQuery } from "@tanstack/react-query";
import { Clock, Loader2, RefreshCcw } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  fetchHistoryLogs,
  type HistoryFilterMode,
  type HistoryLogEntry,
  type HistoryLogPage,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  MEASUREMENT_LABELS,
  formatMeasurementValue,
} from "@/components/production/testResultUtils";

const FILTER_OPTIONS: Array<{ value: HistoryFilterMode; label: string }> = [
  { value: "all", label: "All activity" },
  { value: "tests", label: "Tests" },
  { value: "events", label: "Events" },
];

const DEFAULT_PAGE_SIZE = 25;

const MEASUREMENT_DESCRIPTORS: Array<{
  key: keyof typeof MEASUREMENT_LABELS;
  unit?: string;
  getter: (entry: HistoryLogEntry) => number | null;
}> = [
  {
    key: "crimp-left",
    unit: "mm",
    getter: (entry) => entry.controlCrimpingHeightLeft,
  },
  {
    key: "crimp-right",
    unit: "mm",
    getter: (entry) => entry.controlCrimpingHeightRight,
  },
  {
    key: "traction-left",
    unit: "N",
    getter: (entry) => entry.controlTractionForceLeft,
  },
  {
    key: "traction-right",
    unit: "N",
    getter: (entry) => entry.controlTractionForceRight,
  },
  {
    key: "strip-left",
    unit: "mm",
    getter: (entry) => entry.controlStrippingLeft,
  },
  {
    key: "strip-right",
    unit: "mm",
    getter: (entry) => entry.controlStrippingRight,
  },
  {
    key: "length",
    unit: "mm",
    getter: (entry) => entry.controlLength,
  },
];

function formatTimestamp(value: string | null): string {
  if (!value) return "Timestamp unavailable";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(parsed);
}

function statusTitle(status: string): string {
  const normalized = status.trim().toUpperCase();
  switch (normalized) {
    case "CONTROL_OP":
      return "Operator test";
    case "CONTROL_QUALITY":
      return "Quality test";
    case "START":
      return "Session started";
    case "PAUSE":
      return "Paused";
    case "STOP":
      return "Stopped";
    case "END":
      return "Session ended";
    case "LABEL":
      return "Label printed";
    case "CHANGE_COIL":
      return "Coil changed";
    case "CHANGE_USER":
      return "Operator changed";
    case "CALL_MAINTENANCE":
      return "Maintenance requested";
    case "CALL_QUALITY":
      return "Quality requested";
    case "CALL_PRODUCTION":
      return "Production notified";
    case "CALL_UNCONFORMITY":
      return "Non-conformity raised";
    case "MAINTENANCE":
      return "Maintenance";
    default:
      return normalized || "Event";
  }
}

function statusBadgeVariant(status: string): string {
  const normalized = status.trim().toUpperCase();
  if (normalized === "CONTROL_OP" || normalized === "CONTROL_QUALITY") {
    return "border-success/40 text-success";
  }
  if (normalized === "STOP" || normalized === "CALL_UNCONFORMITY") {
    return "border-destructive/40 text-destructive";
  }
  return "border-border/40 text-muted-foreground";
}

function buildMeasurements(entry: HistoryLogEntry) {
  return MEASUREMENT_DESCRIPTORS.map((descriptor) => {
    const raw = descriptor.getter(entry);
    if (raw == null || Number.isNaN(raw)) {
      return null;
    }
    const label = MEASUREMENT_LABELS[descriptor.key] ?? descriptor.key;
    return {
      key: descriptor.key,
      label,
      value: formatMeasurementValue(raw, descriptor.unit ?? undefined),
    };
  }).filter(Boolean) as Array<{ key: string; label: string; value: string }>;
}

function historyKey(entry: HistoryLogEntry): string {
  return `${entry.id}-${entry.timestamp ?? ""}`;
}

export default function History() {
  const [filter, setFilter] = useState<HistoryFilterMode>("all");
  const [search, setSearch] = useState({ refOf: "", refProduct: "", refWire: "" });
  const [appliedFilters, setAppliedFilters] = useState({ refOf: "", refProduct: "", refWire: "" });

  const {
    data,
    error,
    fetchNextPage,
    hasNextPage,
    isFetching,
    isFetchingNextPage,
    isLoading,
    refetch,
  } = useInfiniteQuery<
    HistoryLogPage,
    unknown,
    InfiniteData<HistoryLogPage>,
    [string, HistoryFilterMode, string, string, string],
    number | null
  >({
    queryKey: [
      "history-logs",
      filter,
      appliedFilters.refOf,
      appliedFilters.refProduct,
      appliedFilters.refWire,
    ],
    initialPageParam: null,
    queryFn: ({ pageParam }) =>
      fetchHistoryLogs({
        filter,
        refOf: appliedFilters.refOf || undefined,
        refProduct: appliedFilters.refProduct || undefined,
        refWire: appliedFilters.refWire || undefined,
        cursor: pageParam ?? undefined,
        limit: DEFAULT_PAGE_SIZE,
      }),
    getNextPageParam: (lastPage) =>
      lastPage.hasMore && lastPage.nextCursor != null ? lastPage.nextCursor : undefined,
  });

  const entries = useMemo<HistoryLogEntry[]>(
    () => (data?.pages ?? []).flatMap((page) => page.entries),
    [data],
  );

  const errorMessage = error
    ? error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "Unable to load application history."
    : null;

  const isRefreshing = isFetching && !isLoading && !isFetchingNextPage;
  const isEmpty = !isLoading && entries.length === 0 && !errorMessage;

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setAppliedFilters({
      refOf: search.refOf.trim(),
      refProduct: search.refProduct.trim(),
      refWire: search.refWire.trim(),
    });
  };

  const handleReset = () => {
    setSearch({ refOf: "", refProduct: "", refWire: "" });
    setAppliedFilters({ refOf: "", refProduct: "", refWire: "" });
  };

  return (
    <div className="space-y-6 px-4 py-6 sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-primary/30 bg-primary/10 text-primary">
            <Clock className="h-5 w-5" />
          </span>
          <div>
            <h2 className="text-xl font-semibold text-foreground sm:text-2xl">History</h2>
            <p className="text-sm text-muted-foreground">
              Review operator and quality activity recorded in the shared logs.
            </p>
          </div>
        </div>
        <Button
          type="button"
          variant="outline"
          className="gap-2"
          onClick={() => {
            void refetch();
          }}
          disabled={isLoading || isRefreshing}
        >
          <RefreshCcw className={cn("h-4 w-4", isRefreshing && "animate-spin")} />
          Refresh
        </Button>
      </div>

      <Card className="border-border/60 bg-card/70 shadow-lg shadow-primary/5">
        <CardHeader className="pb-4">
          <CardTitle className="text-base font-semibold text-foreground">
            Filters
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={handleSubmit}>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <div className="space-y-1">
                <Label htmlFor="history-of">OF</Label>
                <Input
                  id="history-of"
                  value={search.refOf}
                  onChange={(event) =>
                    setSearch((prev) => ({ ...prev, refOf: event.target.value }))
                  }
                  placeholder="OF-12345"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="history-ref">Product reference</Label>
                <Input
                  id="history-ref"
                  value={search.refProduct}
                  onChange={(event) =>
                    setSearch((prev) => ({ ...prev, refProduct: event.target.value }))
                  }
                  placeholder="REF-001"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="history-wire">Wire reference</Label>
                <Input
                  id="history-wire"
                  value={search.refWire}
                  onChange={(event) =>
                    setSearch((prev) => ({ ...prev, refWire: event.target.value }))
                  }
                  placeholder="A12-RED"
                />
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <div className="flex gap-2">
                {FILTER_OPTIONS.map((option) => {
                  const active = option.value === filter;
                  return (
                    <Button
                      key={option.value}
                      type="button"
                      variant={active ? "default" : "outline"}
                      className={cn(
                        "px-3 text-xs font-semibold uppercase tracking-[0.2em]",
                        active
                          ? "bg-primary text-primary-foreground"
                          : "border-border/60 text-muted-foreground",
                      )}
                      onClick={() => setFilter(option.value)}
                    >
                      {option.label}
                    </Button>
                  );
                })}
              </div>
              <div className="ml-auto flex gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={handleReset}
                  disabled={isLoading || isRefreshing}
                >
                  Clear
                </Button>
                <Button type="submit" disabled={isLoading || isRefreshing}>
                  Apply
                </Button>
              </div>
            </div>
          </form>
        </CardContent>
      </Card>

      {errorMessage ? (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
          {errorMessage}
        </div>
      ) : null}

      {isLoading ? (
        <div className="flex items-center justify-center py-20 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : null}

      {isEmpty ? (
        <div className="rounded-lg border border-dashed border-border/60 bg-card/40 p-10 text-center text-sm text-muted-foreground">
          No history entries match the current filters.
        </div>
      ) : null}

      <div className="space-y-4">
        {entries.map((entry) => {
          const measurements = buildMeasurements(entry);
          const metadata = [
            { label: "OF", value: entry.refOf },
            { label: "Product", value: entry.refProduct },
            { label: "Wire", value: entry.refWire },
            { label: "Coil", value: entry.refCoil },
            { label: "Label", value: entry.labelId },
            { label: "Bac", value: entry.bacId },
          ].filter((item) => item.value && item.value.trim().length > 0);
          const participants = [
            { label: "Operator", value: entry.userNumber },
            { label: "App user", value: entry.appUserName ?? entry.appUserId },
            { label: "Quality", value: entry.opQualityNumber },
            { label: "Maintenance", value: entry.opMaintenanceNumber },
            { label: "Machine", value: entry.engineName },
            {
              label: "Quantity",
              value:
                entry.quantity != null && Number.isFinite(entry.quantity)
                  ? new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 }).format(entry.quantity)
                  : null,
            },
          ].filter((item) => item.value && String(item.value).trim().length > 0);

          return (
            <Card
              key={historyKey(entry)}
              className="border-border/60 bg-background/80 shadow-md shadow-primary/5"
            >
              <CardHeader className="flex flex-col gap-2 pb-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <CardTitle className="text-base font-semibold text-foreground">
                    {statusTitle(entry.status)}
                  </CardTitle>
                  <p className="text-xs text-muted-foreground">
                    {formatTimestamp(entry.timestamp)}
                  </p>
                </div>
                <Badge variant="outline" className={cn("uppercase", statusBadgeVariant(entry.status))}>
                  {entry.status || "UNKNOWN"}
                </Badge>
              </CardHeader>
              <CardContent className="space-y-4">
                {metadata.length > 0 ? (
                  <div className="flex flex-wrap gap-2 text-xs">
                    {metadata.map((item) => (
                      <Badge key={item.label} variant="secondary" className="border-border/50 bg-muted/40">
                        <span className="font-semibold text-foreground/80">{item.label}:</span>{" "}
                        <span className="text-foreground">{item.value}</span>
                      </Badge>
                    ))}
                  </div>
                ) : null}

                {participants.length > 0 ? (
                  <div className="grid gap-2 sm:grid-cols-2">
                    {participants.map((item) => (
                      <div
                        key={item.label}
                        className="flex items-center justify-between rounded-lg border border-border/50 bg-muted/30 px-3 py-2 text-xs"
                      >
                        <span className="font-semibold text-foreground/80">{item.label}</span>
                        <span className="text-foreground">{item.value}</span>
                      </div>
                    ))}
                  </div>
                ) : null}

                {entry.note ? (
                  <div className="rounded-lg border border-border/60 bg-muted/30 p-3 text-sm text-foreground">
                    {entry.note}
                  </div>
                ) : null}

                {measurements.length > 0 ? (
                  <div className="space-y-3">
                    <Separator />
                    <div className="grid gap-3 sm:grid-cols-2">
                      {measurements.map((measurement) => (
                        <div
                          key={measurement.key}
                          className="rounded-lg border border-border/60 bg-card/80 p-3"
                        >
                          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                            {measurement.label}
                          </p>
                          <p className="text-sm font-semibold text-foreground">
                            {measurement.value}
                          </p>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
              </CardContent>
            </Card>
          );
        })}
      </div>

      {hasNextPage ? (
        <div className="flex justify-center">
          <Button
            type="button"
            onClick={() => {
              void fetchNextPage();
            }}
            disabled={isFetchingNextPage}
            className="gap-2"
          >
            {isFetchingNextPage ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Load more
          </Button>
        </div>
      ) : null}
    </div>
  );
}
