import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  AlertTriangle,
  BadgeCheck,
  ChevronLeft,
  ChevronRight,
  ImagePlus,
  PauseCircle,
  PlayCircle,
} from "lucide-react";
import { open as openDialog } from "@tauri-apps/api/dialog";
import { readBinaryFile } from "@tauri-apps/api/fs";
import { convertFileSrc } from "@tauri-apps/api/tauri";

import { CameraCapture } from "@/components/production/CameraCapture";


import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import { fetchCrimpToolSpec, saveCameraPhoto, type CrimpToolSpec } from "@/lib/api";
import {
  buildTimeFeatureFlags,
  fetchFeatureFlags,
  type FeatureFlags,
} from "@/lib/featureFlags";
import type { WireIdentifier, WireSummary, WireTerminalSpec, WorkOrderSummary } from "@/lib/types";
import { useToast } from "@/components/ui/use-toast";
import { useAppFlow } from "@/context/AppFlowContext";

interface OperatorTestDialogProps {
  open: boolean;
  wire: WireSummary | null;
  order: WorkOrderSummary | null;
  isSubmitting: boolean;
  onOpenChange: (open: boolean) => void;
  onComplete: (payload: { notes: Record<string, string> }) => Promise<void> | void;
  onPause?: (identifier: WireIdentifier) => Promise<void> | void;
  onResume?: (identifier: WireIdentifier) => Promise<void> | void;
  pausePending?: boolean;
  variant?: "operator" | "quality";
  workflowTitle?: string;
  workflowDescription?: string;
  confirmLabel?: string;
  showPauseControls?: boolean;
  initialNotes?: Record<string, string> | null;
  initialActiveStep?: number | null;
  onSaveDraft?: (payload: { notes: Record<string, string>; activeStep: number }) => void;
  qualityAgentId?: string | null;
}

type StepSide = "left" | "right";

type BaseTestToken = "marking" | "crimp" | "traction" | "stripping" | "length" | "photo";

type StepKind =
  | "marking"
  | "crimp"
  | "traction"
  | "stripping"
  | "length"
  | "photo-front"
  | "photo-back"
  | "notice";

interface StepDefinition {
  key: string;
  kind: StepKind;
  side: StepSide;
  extremity: WireTerminalSpec | null | undefined;
}

interface CaptureState {
  side: StepSide | null;
  buffer: string;
  lastKey?: string;
}

interface PhotoSelection {
  path: string;
  url: string;
  fileName: string;
  objectUrl: boolean;
}

const STEP_COMPOSITION: Record<string, BaseTestToken[]> = {
  "sertissage simple": ["marking", "crimp", "traction", "stripping", "length", "photo"],
  compacter: ["marking", "stripping", "length"],
  denuder: ["marking", "stripping", "length"],
  "pre denuder": ["marking", "stripping", "length"],
  "coupe nette": ["marking", "length"],
};

const SHARED_TESTS: BaseTestToken[] = ["marking", "length"];

const CAPTURE_INITIAL: CaptureState = { side: null, buffer: "", lastKey: undefined };

const STRIPPING_TOLERANCE_MM = 0.5;
const LENGTH_TOLERANCE_MM = 5;
const PHOTO_SKIP_SENTINEL = "__photo_skipped__";

function formatStrippingMeasurement(value?: number | null): string | null {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return null;
  }
  return `${value.toFixed(1)} mm`;
}

function extractFileName(input?: string | null): string {
  if (!input) return "";
  const normalized = input.replace(/\\+/g, "/");
  const parts = normalized.split("/");
  return parts[parts.length - 1] ?? input;
}

function inferMimeType(fileName: string): string {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".bmp")) return "image/bmp";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".tif") || lower.endsWith(".tiff")) return "image/tiff";
  return "image/jpeg";
}

async function resolvePhotoSelection(path: string): Promise<PhotoSelection> {
  const fileName = extractFileName(path);
  try {
    const binary = await readBinaryFile(path);
    const buffer = binary.buffer.slice(
      binary.byteOffset,
      binary.byteOffset + binary.byteLength,
    ) as ArrayBuffer;
    const blob = new Blob([buffer], { type: inferMimeType(fileName) });
    const url = URL.createObjectURL(blob);
    return { path, url, fileName, objectUrl: true };
  } catch (primaryError) {
    try {
      const url = convertFileSrc(path);
      return { path, url, fileName, objectUrl: false };
    } catch {
      throw primaryError instanceof Error
        ? primaryError
        : new Error("Unable to load microscope preview.");
    }
  }
}

function cleanupPhotoSelections(map: Record<string, PhotoSelection>) {
  Object.values(map).forEach((selection) => {
    if (selection.objectUrl) {
      URL.revokeObjectURL(selection.url);
    }
  });
}

function normalizeProcess(kind?: string | null): string | null {
  if (!kind) return null;
  return kind
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/_/g, " ")
    .trim()
    .toLowerCase();
}

function toTitleCase(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatSide(side: StepSide): string {
  return side === "left" ? "Left" : "Right";
}

function formatRange(min?: number | null, max?: number | null, unit = "mm"): string | null {
  if (min == null || max == null) return null;
  return `${min.toFixed(3)} – ${max.toFixed(3)} ${unit}`;
}

const COLOR_MAP: Record<string, string> = {
  BLANC: "#ffffff",
  WHITE: "#ffffff",
  NOIR: "#000000",
  BLACK: "#000000",
  ROUGE: "#e53935",
  RED: "#e53935",
  VERT: "#43a047",
  GREEN: "#43a047",
  BLEU: "#1e88e5",
  BLUE: "#1e88e5",
  JAUNE: "#fdd835",
  YELLOW: "#fdd835",
  ORANGE: "#fb8c00",
  MARRON: "#8d6e63",
  BROWN: "#8d6e63",
  GRIS: "#90a4ae",
  GRAY: "#90a4ae",
  VIOLET: "#8e24aa",
  PURPLE: "#8e24aa",
  ROSE: "#ec407a",
  PINK: "#ec407a",
};

function hexToRgba(hex: string, alpha: number): string | null {
  const normalized = hex.replace("#", "");
  if (normalized.length !== 3 && normalized.length !== 6) {
    return null;
  }
  const full = normalized.length === 3 ? normalized.split("").map((char) => char + char).join("") : normalized;
  const r = Number.parseInt(full.slice(0, 2), 16);
  const g = Number.parseInt(full.slice(2, 4), 16);
  const b = Number.parseInt(full.slice(4, 6), 16);
  if ([r, g, b].some((component) => Number.isNaN(component))) {
    return null;
  }
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function buildWireColorInfo(value?: string | null): { label: string; swatch?: string } {
  if (!value) {
    return { label: "—" };
  }
  const trimmed = value.trim();
  const hexMatch = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
  const uppercase = trimmed.toUpperCase();
  if (hexMatch.test(trimmed)) {
    return { label: uppercase, swatch: uppercase };
  }
  const mapped = COLOR_MAP[uppercase];
  if (mapped) {
    return { label: uppercase, swatch: mapped };
  }
  return { label: uppercase };
}

function formatStrippingValue(value?: number | null): string | null {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return null;
  }
  return `${value.toFixed(1)} mm`;
}

interface WireIllustrationProps {
  wire: WireSummary | null;
  order: WorkOrderSummary | null;
  processLabel: string;
}

function WireIllustration({ wire, order, processLabel }: WireIllustrationProps) {
  if (!wire) {
    return null;
  }

  const left = wire.ext1;
  const right = wire.ext2;
  const lengthLabel = typeof wire.lengthMm === "number" ? `${wire.lengthMm.toFixed(0)} mm` : "—";
  const sectionLabel =
    typeof wire.section === "number" && !Number.isNaN(wire.section)
      ? `${wire.section.toFixed(2)} mm²`
      : "—";
  const colors = {
    primary: buildWireColorInfo(wire.colorPrimary),
    secondary: buildWireColorInfo(wire.colorSecondary),
  };

  const leftProcess = toTitleCase(normalizeProcess(left?.kind));
  const rightProcess = toTitleCase(normalizeProcess(right?.kind));
  const leftStripping = formatStrippingMeasurement(left?.stripping ?? null);
  const rightStripping = formatStrippingMeasurement(right?.stripping ?? null);
  const coilLabel = wire.refCoil ? `Coil ${wire.refCoil}` : null;
  const workOrderBadges = useMemo(() => {
    const items: Array<{ key: string; value: string }> = [];
    if (order?.ofId) {
      items.push({ key: "of", value: order.ofId });
    }
    if (order?.reference) {
      items.push({ key: "ref", value: order.reference });
    }
    return items;
  }, [order?.ofId, order?.reference]);
  const markingLabel = wire.marquage?.trim() ? wire.marquage : null;

  const ids = useMemo(() => {
    const base = Math.random().toString(36).slice(2);
    return {
      gradient: `wire-core-${base}`,
      title: `wire-diagram-${base}`,
    };
  }, []);

  const leftStripValue = leftStripping ?? "—";
  const rightStripValue = rightStripping ?? "—";
  const sectionBadgeValue =
    typeof wire.section === "number" && !Number.isNaN(wire.section)
      ? wire.section.toFixed(2)
      : null;
  const primaryStroke = colors.primary.swatch ?? "hsl(var(--primary))";
  const secondaryStroke = colors.secondary.swatch ?? primaryStroke;
  const dimensionColor = "hsl(var(--primary))";
  const conductorStroke = "hsl(var(--muted-foreground))";
  const leftFill = primaryStroke;
  const rightFill = secondaryStroke;
  const leftStripOpacity = colors.primary.swatch ? 0.82 : 0.35;
  const rightStripOpacity = colors.secondary.swatch ? 0.82 : 0.35;
  const viewBoxWidth = 2000;
  const viewBoxHeight = 180;
  const centerY = viewBoxHeight / 2;
  const marginX = 16;
  const stripWidthPx = 150;
  const bodyHeightPx = 48;
  const stripHeightPx = 38;
  const bodyWidthPx = viewBoxWidth - marginX * 2 - stripWidthPx * 2;
  const bodyStartX = marginX + stripWidthPx;
  const bodyEndX = bodyStartX + bodyWidthPx;
  const leftStripStartX = bodyStartX - stripWidthPx;
  const rightStripStartX = bodyEndX;
  const upperDimensionY = centerY - stripHeightPx - 18;
  const lowerDimensionY = centerY + bodyHeightPx + 32;
  const leftChipColor = colors.primary.swatch ?? leftFill;
  const rightChipColor = colors.secondary.swatch ?? rightFill;
  const leftChipStyle: CSSProperties = { borderColor: leftChipColor, color: leftChipColor };
  const rightChipStyle: CSSProperties = { borderColor: rightChipColor, color: rightChipColor };
  if (colors.primary.swatch) {
    const tint = hexToRgba(colors.primary.swatch, 0.18);
    if (tint) {
      leftChipStyle.backgroundColor = tint;
    }
  }
  if (colors.secondary.swatch) {
    const tint = hexToRgba(colors.secondary.swatch, 0.18);
    if (tint) {
      rightChipStyle.backgroundColor = tint;
    }
  }
  const leftLabelAnchorX = Math.max(marginX + stripWidthPx * 0.35, bodyStartX - stripWidthPx * 0.35);
  const rightLabelAnchorX = Math.min(
    viewBoxWidth - marginX - stripWidthPx * 0.35,
    bodyEndX + stripWidthPx * 0.35,
  );
  const leftStripLabelOffset = (leftLabelAnchorX / viewBoxWidth) * 100;
  const rightStripLabelOffset = (rightLabelAnchorX / viewBoxWidth) * 100;
  const stripLabelTopPercent = ((centerY - bodyHeightPx / 2 - 20) / viewBoxHeight) * 100;
  const lengthLabelTopPercent = ((centerY + bodyHeightPx / 2 + 2) / viewBoxHeight) * 100;
  const sectionBadgeTopPercent = ((centerY - bodyHeightPx / 2 - 44) / viewBoxHeight) * 100;
  const bodyStartPercent = (bodyStartX / viewBoxWidth) * 100;
  const bodyWidthPercent = (bodyWidthPx / viewBoxWidth) * 100;
  const bodyCenterPercent = ((bodyStartX + bodyWidthPx / 2) / viewBoxWidth) * 100;
  const sectionBadgeLeftPercent = bodyCenterPercent;
  const wireLabelWidthPercent = Math.max(32, Math.min(62, (bodyWidthPx / viewBoxWidth) * 52));

  const renderExtremityDetails = (
    label: string,
    extremity: WireTerminalSpec | null | undefined,
    colorInfo: { label: string; swatch?: string },
    process: string | null,
  ) => {
    const terminal = extremity?.terminal?.trim();
    const stripping = formatStrippingValue(extremity?.stripping ?? null);

    return (
      <div className="rounded-lg border border-border/60 bg-background/85 p-3 text-xs shadow-sm backdrop-blur-sm">
        <p className="text-[0.6rem] font-semibold uppercase tracking-[0.32em] text-muted-foreground">{label}</p>
        <dl className="mt-2 space-y-1.5 text-[0.7rem] font-medium text-muted-foreground">
          <div className="flex items-center justify-between gap-2">
            <dt className="text-muted-foreground/65">Color:</dt>
            <dd className="flex items-center gap-2 font-semibold uppercase tracking-[0.2em] text-foreground/90">
              <span
                className="h-2.5 w-2.5 rounded-full border border-border/60"
                style={colorInfo.swatch ? { backgroundColor: colorInfo.swatch } : { backgroundColor: "transparent" }}
                aria-hidden="true"
              />
              <span>{colorInfo.label}</span>
            </dd>
          </div>
          <div className="flex items-center justify-between gap-2">
            <dt className="text-muted-foreground/65">Stripping:</dt>
            <dd className="text-foreground/90">{stripping ?? "—"}</dd>
          </div>
          <div className="flex items-center justify-between gap-2">
            <dt className="text-muted-foreground/65">Type:</dt>
            <dd className="text-foreground/90">{process ?? "—"}</dd>
          </div>
          <div className="flex items-center justify-between gap-2">
            <dt className="text-muted-foreground/65">Terminal:</dt>
            <dd className="truncate text-foreground/90">{terminal || "—"}</dd>
          </div>
        </dl>
      </div>
    );
  };

  return (
    <div className="relative overflow-hidden rounded-2xl border border-border bg-card text-card-foreground shadow-lg">
      <div
        className="pointer-events-none absolute inset-0 bg-[linear-gradient(rgba(148,163,184,0.12)_1px,transparent_1px),linear-gradient(90deg,rgba(148,163,184,0.1)_1px,transparent_1px)] bg-[size:32px_32px]"
        aria-hidden="true"
      />
      <div className="relative grid gap-6 p-6">
        <div className="flex flex-wrap items-center justify-between gap-3 text-xs font-semibold uppercase tracking-[0.3em] text-muted-foreground">
          {workOrderBadges.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-muted-foreground/70">Work Order</span>
              {workOrderBadges.map((badge) => (
                <span
                  key={badge.key}
                  className="rounded-full border border-border/60 bg-background/85 px-3 py-1 text-foreground shadow-sm"
                >
                  {badge.value}
                </span>
              ))}
            </div>
          ) : (
            <span className="text-muted-foreground/60">Work Order —</span>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {markingLabel ? (
              <span className="rounded-full border border-border/60 bg-background/80 px-3 py-1 text-foreground shadow-sm">
                Marking {markingLabel}
              </span>
            ) : null}
            {coilLabel ? (
              <span className="rounded-full border border-border/60 bg-background/80 px-3 py-1 text-foreground shadow-sm">
                {coilLabel}
              </span>
            ) : null}
          </div>
        </div>
        <div className="relative w-full">
          <div className="flex w-full flex-col items-center justify-between gap-2.5 md:flex-row md:items-start md:gap-4">
            <div className="w-full max-w-[260px] md:w-[220px]">{renderExtremityDetails("Ext 1", left, colors.primary, leftProcess)}</div>
            <div className="w-full max-w-[260px] md:w-[220px]">{renderExtremityDetails("Ext 2", right, colors.secondary, rightProcess)}</div>
          </div>
          <div className="w-full px-2 py-4 sm:px-4 sm:py-6 md:px-[72px] md:py-4">
            <div className="relative w-full">
              <svg
                viewBox={`0 0 ${viewBoxWidth} ${viewBoxHeight}`}
                className="h-48 w-full"
                role="img"
                aria-labelledby={ids.title}
              >
                <title id={ids.title}>{`Wire diagram for ${wire.refWire}`}</title>
                <defs>
                  <linearGradient
                    id={ids.gradient}
                    x1={bodyStartX}
                    x2={bodyEndX}
                    y1={centerY}
                    y2={centerY}
                    gradientUnits="userSpaceOnUse"
                  >
                    <stop offset="0%" stopColor={leftFill} stopOpacity="0.9" />
                    <stop offset="50%" stopColor="hsl(var(--card-foreground))" stopOpacity="0.75" />
                    <stop offset="100%" stopColor={rightFill} stopOpacity="0.9" />
                  </linearGradient>
                </defs>
                <g>
                  <rect
                    x={leftStripStartX}
                    y={centerY - stripHeightPx / 2}
                    width={stripWidthPx}
                    height={stripHeightPx}
                    rx={stripHeightPx / 2}
                    ry={stripHeightPx / 2}
                    fill={leftFill}
                    fillOpacity={leftStripOpacity}
                  />
                  <rect
                    x={rightStripStartX}
                    y={centerY - stripHeightPx / 2}
                    width={stripWidthPx}
                    height={stripHeightPx}
                    rx={stripHeightPx / 2}
                    ry={stripHeightPx / 2}
                    fill={rightFill}
                    fillOpacity={rightStripOpacity}
                  />
                  <rect
                    x={bodyStartX}
                    y={centerY - bodyHeightPx / 2}
                    width={bodyWidthPx}
                    height={bodyHeightPx}
                    rx={bodyHeightPx / 2}
                    ry={bodyHeightPx / 2}
                    fill={`url(#${ids.gradient})`}
                    stroke={dimensionColor}
                    strokeOpacity="0.15"
                    strokeWidth="2"
                  />
                  <circle cx={leftStripStartX} cy={centerY} r="12" fill={leftFill} fillOpacity="0.9" />
                  <circle cx={rightStripStartX + stripWidthPx} cy={centerY} r="12" fill={rightFill} fillOpacity="0.9" />
                </g>
                <g stroke={conductorStroke} strokeWidth="1.5" strokeDasharray="6 6" strokeOpacity="0.35">
                  <line
                    x1={bodyStartX}
                    x2={bodyStartX}
                    y1={centerY - stripHeightPx - 20}
                    y2={centerY + stripHeightPx + 20}
                  />
                  <line
                    x1={bodyEndX}
                    x2={bodyEndX}
                    y1={centerY - stripHeightPx - 20}
                    y2={centerY + stripHeightPx + 20}
                  />
                </g>
                <g stroke={dimensionColor} strokeWidth="1.5" strokeLinecap="round">
                  <line x1={leftStripStartX} x2={bodyStartX} y1={upperDimensionY} y2={upperDimensionY} />
                  <line x1={leftStripStartX} x2={leftStripStartX} y1={upperDimensionY - 10} y2={upperDimensionY + 10} />
                  <line x1={bodyStartX} x2={bodyStartX} y1={upperDimensionY - 10} y2={upperDimensionY + 10} />
                  <line x1={bodyEndX} x2={rightStripStartX + stripWidthPx} y1={upperDimensionY} y2={upperDimensionY} />
                  <line x1={bodyEndX} x2={bodyEndX} y1={upperDimensionY - 10} y2={upperDimensionY + 10} />
                  <line
                    x1={rightStripStartX + stripWidthPx}
                    x2={rightStripStartX + stripWidthPx}
                    y1={upperDimensionY - 10}
                    y2={upperDimensionY + 10}
                  />
                  <line x1={bodyStartX} x2={bodyEndX} y1={lowerDimensionY} y2={lowerDimensionY} />
                  <line x1={bodyStartX} x2={bodyStartX} y1={lowerDimensionY - 10} y2={lowerDimensionY + 10} />
                  <line x1={bodyEndX} x2={bodyEndX} y1={lowerDimensionY - 10} y2={lowerDimensionY + 10} />
                </g>
              </svg>
              <div
                className="pointer-events-none absolute flex flex-col items-center gap-1 rounded-xl border border-border/60 bg-background/95 px-5 py-1.5 text-center shadow-sm"
                style={{
                  left: `${bodyCenterPercent}%`,
                  top: "50%",
                  width: `${wireLabelWidthPercent}%`,
                  minWidth: "220px",
                  maxWidth: "520px",
                  transform: "translate(-50%, -50%)",
                }}
              >
                <span className="text-sm font-semibold uppercase tracking-[0.32em] text-foreground">
                  {wire.refWire}
                </span>
                <span className="text-[0.6rem] font-medium uppercase tracking-[0.25em] text-muted-foreground">
                  {wire.marquage || "—"}
                </span>
              </div>
              <div
                className="pointer-events-none absolute flex flex-col items-center gap-1 text-center text-[0.52rem] font-semibold uppercase tracking-[0.26em] text-muted-foreground/80"
                style={{
                  left: `${leftStripLabelOffset}%`,
                  top: `${stripLabelTopPercent}%`,
                  transform: "translate(-50%, -50%)",
                }}
              >
                <span className="whitespace-nowrap">Left Stripping</span>
                <span
                  className="inline-flex items-center rounded-full border px-2.5 py-0.5 text-[0.6rem] font-semibold shadow-sm"
                  style={leftChipStyle}
                >
                  {leftStripValue}
                </span>
              </div>
              <div
                className="pointer-events-none absolute flex flex-col items-center gap-1 text-center text-[0.52rem] font-semibold uppercase tracking-[0.26em] text-muted-foreground/80"
                style={{
                  left: `${rightStripLabelOffset}%`,
                  top: `${stripLabelTopPercent}%`,
                  transform: "translate(-50%, -50%)",
                }}
              >
                <span className="whitespace-nowrap">Right Stripping</span>
                <span
                  className="inline-flex items-center rounded-full border px-2.5 py-0.5 text-[0.6rem] font-semibold shadow-sm"
                  style={rightChipStyle}
                >
                  {rightStripValue}
                </span>
              </div>
              <div
                className="pointer-events-none absolute flex items-center justify-between text-[0.55rem] font-semibold uppercase tracking-[0.28em] text-primary"
                style={{
                  left: `${bodyStartPercent}%`,
                  width: `${bodyWidthPercent}%`,
                  top: `${lengthLabelTopPercent}%`,
                  transform: "translateY(-50%)",
                }}
              >
                <ChevronLeft className="h-4 w-4 shrink-0" />
                <span className="flex-1 text-center">
                  {lengthLabel !== "—" ? `Wire length ${lengthLabel}` : "Length unavailable"}
                </span>
                <ChevronRight className="h-4 w-4 shrink-0" />
              </div>
              <div
                className="pointer-events-none absolute flex flex-col items-center gap-1 text-primary"
                style={{
                  left: `${sectionBadgeLeftPercent}%`,
                  top: `${sectionBadgeTopPercent}%`,
                  transform: "translate(-50%, -50%)",
                }}
              >
                <div className="flex h-11 w-11 items-center justify-center rounded-full border-2 border-primary bg-background text-sm font-bold shadow-md">
                  {sectionBadgeValue ?? "—"}
                </div>
                <span className="text-[0.55rem] font-semibold uppercase tracking-[0.3em] text-primary/80">
                  Section mm²
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function deriveSteps(
  wire: WireSummary | null,
  featureFlags: FeatureFlags = buildTimeFeatureFlags,
): StepDefinition[] {
  if (!wire) return [];
  const includeCrimp = featureFlags.crimpTest;
  const includeMicroscope = featureFlags.microscopeTest;
  const includeMarking = featureFlags.labelPrinting;
  const seenShared = new Set<BaseTestToken>();
  const steps: StepDefinition[] = [];
  const sides: Array<{ side: StepSide; extremity: WireTerminalSpec | null | undefined }> = [
    { side: "left", extremity: wire.ext1 },
    { side: "right", extremity: wire.ext2 },
  ];
  let counter = 0;

  for (const { side, extremity } of sides) {
    const rawKind = extremity?.kind?.trim() || null;
    const normalized = normalizeProcess(rawKind);
    const tokens = normalized ? STEP_COMPOSITION[normalized] ?? [] : [];

    if (tokens.length === 0) {
      const sideLabel = formatSide(side);
      if (rawKind && rawKind !== "--") {
        console.warn(
          `[OperatorTest] Unknown process type '${rawKind}' on ${sideLabel} extremity; presenting notice step.`,
        );
      } else {
        console.warn(
          `[OperatorTest] Missing process definition on ${sideLabel} extremity; presenting notice step.`,
        );
      }
      steps.push({
        key: `notice-${side}-${counter}`,
        kind: "notice",
        side,
        extremity,
      });
      counter += 1;
      continue;
    }

    for (const token of tokens) {
      if (SHARED_TESTS.includes(token) && seenShared.has(token)) {
        continue;
      }
      if (token === "crimp" && !includeCrimp) {
        continue;
      }
      if (token === "photo" && !includeMicroscope) {
        continue;
      }
      if (token === "marking" && !includeMarking) {
        continue;
      }
      switch (token) {
        case "marking":
          seenShared.add("marking");
          steps.push({
            key: `marking-${counter}`,
            kind: "marking",
            side,
            extremity,
          });
          break;
        case "length":
          seenShared.add("length");
          steps.push({
            key: `length-${counter}`,
            kind: "length",
            side,
            extremity,
          });
          break;
        case "photo":
          steps.push({
            key: `photo-front-${side}-${counter}`,
            kind: "photo-front",
            side,
            extremity,
          });
          counter += 1;
          steps.push({
            key: `photo-back-${side}-${counter}`,
            kind: "photo-back",
            side,
            extremity,
          });
          break;
        default:
          steps.push({
            key: `${token}-${side}-${counter}`,
            kind: token as StepKind,
            side,
            extremity,
          });
      }
      counter += 1;
    }
  }

  return steps;
}

function buildIdentifier(order: WorkOrderSummary | null, wire: WireSummary | null): WireIdentifier | null {
  if (!order || !wire) return null;
  return {
    workOrderId: order.id,
    refWire: wire.refWire,
    marquage: wire.marquage,
  };
}

function getStepTitle(step: StepDefinition): string {
  switch (step.kind) {
    case "marking":
      return "Marking Validation";
    case "crimp":
      return `Crimping Height — ${formatSide(step.side)}`;
    case "traction":
      return `Traction Test — ${formatSide(step.side)}`;
    case "stripping":
      return `Stripping Length — ${formatSide(step.side)}`;
    case "length":
      return "Wire Length";
    case "photo-front":
      return `Microscope Photo (Front) — ${formatSide(step.side)}`;
    case "photo-back":
      return `Microscope Photo (Back) — ${formatSide(step.side)}`;
    case "notice":
    default:
      return `No Tests Defined — ${formatSide(step.side)}`;
  }
}

function getStepNavLabel(step: StepDefinition): string {
  switch (step.kind) {
    case "marking":
      return "Marking";
    case "crimp":
      return `Crimp · ${formatSide(step.side)}`;
    case "traction":
      return `Traction · ${formatSide(step.side)}`;
    case "stripping":
      return `Stripping · ${formatSide(step.side)}`;
    case "length":
      return "Length";
    case "photo-front":
      return `Photo F · ${formatSide(step.side)}`;
    case "photo-back":
      return `Photo B · ${formatSide(step.side)}`;
    case "notice":
    default:
      return `Notice · ${formatSide(step.side)}`;
  }
}

function getStepSubtitle(
  step: StepDefinition,
  wire: WireSummary | null,
  specs: Partial<Record<StepSide, CrimpToolSpec | null>>,
): string | undefined {
  const extremity = step.extremity;
  const spec = specs[step.side] ?? null;
  switch (step.kind) {
    case "marking":
      return wire?.marquage ? `Expected marking: ${wire.marquage}` : "Confirm the marking matches the order.";
    case "crimp": {
      const details: string[] = [];
      const terminals = [extremity?.terminal, extremity?.joint].filter(Boolean).join(" / ");
      if (terminals) details.push(terminals);
      const range = formatRange(spec?.hcMin ?? null, spec?.hcMax ?? null);
      if (range) details.push(`Tolerance ${range}`);
      else if (spec?.hcNominal != null) details.push(`Nominal ${spec.hcNominal.toFixed(3)} mm`);
      if (details.length === 0) details.push("Measure and record the comparator reading.");
      return details.join(" • ");
    }
    case "traction":
      if (spec?.tractionNominal != null) {
        return `Nominal ${spec.tractionNominal.toFixed(1)} N`;
      }
      return "Record the traction force in newtons.";
    case "stripping":
      if (typeof extremity?.stripping === "number") {
        return `Reference ${extremity.stripping.toFixed(1)} mm (±${STRIPPING_TOLERANCE_MM} mm)`;
      }
      return "Enter stripped length in millimetres.";
    case "length":
      if (typeof wire?.lengthMm === "number") {
        return `Reference ${wire.lengthMm.toFixed(0)} mm (±${LENGTH_TOLERANCE_MM} mm)`;
      }
      return "Enter measured wire length.";
    case "photo-front":
      return `Upload the ${formatSide(step.side).toLowerCase()} front microscope image.`;
    case "photo-back":
      return `Upload the ${formatSide(step.side).toLowerCase()} back microscope image.`;
    case "notice":
    default:
      return "No operator tests configured for this extremity.";
  }
}

export function OperatorTestDialog({
  open,
  wire,
  order,
  isSubmitting,
  onOpenChange,
  onComplete,
  onPause,
  onResume,
  pausePending = false,
  variant = "operator",
  workflowTitle,
  workflowDescription,
  confirmLabel,
  showPauseControls,
  initialNotes = null,
  initialActiveStep = null,
  onSaveDraft,
  qualityAgentId = null,
}: OperatorTestDialogProps) {
  const [featureFlags, setFeatureFlags] = useState<FeatureFlags>(buildTimeFeatureFlags);
  useEffect(() => {
    let cancelled = false;
    void fetchFeatureFlags().then((flags) => {
      if (!cancelled) {
        setFeatureFlags(flags);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const steps = useMemo(
    () => deriveSteps(wire, featureFlags),
    [wire?.id, wire?.ext1?.kind, wire?.ext2?.kind, featureFlags],
  );
  const [activeStep, setActiveStep] = useState(0);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [captureState, setCaptureState] = useState<CaptureState>(CAPTURE_INITIAL);
  const [photoSelections, setPhotoSelections] = useState<Record<string, PhotoSelection>>({});
  const photoSelectionsRef = useRef(photoSelections);
  const previewRequests = useRef<Record<string, number>>({});
  const comparatorEnabled = featureFlags.comparatorTest;
  const [toolSpecs, setToolSpecs] = useState<Partial<Record<StepSide, CrimpToolSpec | null>>>({});
  const { toast } = useToast();
  const { state: flowState } = useAppFlow();
  const operatorId = flowState.session?.operatorId?.trim() || null;
  const qualityAgent = qualityAgentId?.trim() || null;
  const [savingPhotos, setSavingPhotos] = useState(false);
  const rehydratePhotoSelections = useCallback(async (noteMap: Record<string, string>) => {
    const entries = await Promise.all(
      Object.entries(noteMap).map(async ([key, value]) => {
        if (!key.startsWith("photo-")) {
          return null;
        }
        if (!value || value === PHOTO_SKIP_SENTINEL || value.toLowerCase() === "skipped") {
          return null;
        }
        try {
          const selection = await resolvePhotoSelection(value);
          return [key, selection] as const;
        } catch {
          return null;
        }
      }),
    );
    return Object.fromEntries(entries.filter((entry): entry is [string, PhotoSelection] => entry != null));
  }, []);
  const evaluateCrimp = useCallback(
    (step: StepDefinition) => {
      const key = `crimp-${step.side}`;
      const raw = notes[key]?.trim();
      if (!raw) {
        return { complete: false, numeric: null as number | null, outOfTolerance: false };
      }
      const numeric = Number.parseFloat(raw.replace(/,/g, "."));
      if (!Number.isFinite(numeric)) {
        return { complete: false, numeric: null, outOfTolerance: false };
      }
      const spec = toolSpecs[step.side] ?? null;
      if (!spec || spec.hcMin == null || spec.hcMax == null) {
        return { complete: true, numeric, outOfTolerance: false };
      }
      const outOfTolerance = numeric < spec.hcMin || numeric > spec.hcMax;
      return { complete: !outOfTolerance, numeric, outOfTolerance };
    },
    [notes, toolSpecs],
  );
  const evaluateTraction = useCallback(
    (step: StepDefinition) => {
      const key = `traction-${step.side}`;
      const raw = notes[key]?.trim();
      if (!raw) {
        return { complete: false, numeric: null as number | null, belowNominal: false };
      }
      const numeric = Number.parseFloat(raw.replace(/,/g, "."));
      if (!Number.isFinite(numeric)) {
        return { complete: false, numeric: null, belowNominal: false };
      }
      const nominal = toolSpecs[step.side]?.tractionNominal ?? null;
      if (nominal == null) {
        return { complete: true, numeric, belowNominal: false };
      }
      const belowNominal = numeric < nominal;
      return { complete: !belowNominal, numeric, belowNominal };
    },
    [notes, toolSpecs],
  );
  const evaluateStripping = useCallback(
    (step: StepDefinition) => {
      const key = `strip-${step.side}`;
      const raw = notes[key]?.trim();
      const reference =
        typeof step.extremity?.stripping === "number" ? step.extremity.stripping : null;
      if (!raw) {
        return {
          complete: false,
          numeric: null as number | null,
          outOfTolerance: false,
          reference,
        };
      }
      const numeric = Number.parseFloat(raw.replace(/,/g, "."));
      if (!Number.isFinite(numeric)) {
        return { complete: false, numeric: null, outOfTolerance: false, reference };
      }
      if (reference == null) {
        return { complete: true, numeric, outOfTolerance: false, reference };
      }
      const outOfTolerance =
        numeric < reference - STRIPPING_TOLERANCE_MM || numeric > reference + STRIPPING_TOLERANCE_MM;
      return { complete: !outOfTolerance, numeric, outOfTolerance, reference };
    },
    [notes],
  );
  const evaluateLength = useCallback(() => {
    const key = "wire-length";
    const raw = notes[key]?.trim();
    const reference = typeof wire?.lengthMm === "number" ? wire.lengthMm : null;
    if (!raw) {
      return { complete: false, numeric: null as number | null, outOfTolerance: false, reference };
    }
    const numeric = Number.parseFloat(raw.replace(/,/g, "."));
    if (!Number.isFinite(numeric)) {
      return { complete: false, numeric: null, outOfTolerance: false, reference };
    }
    if (reference == null) {
      return { complete: true, numeric, outOfTolerance: false, reference };
    }
    const outOfTolerance =
      numeric < reference - LENGTH_TOLERANCE_MM || numeric > reference + LENGTH_TOLERANCE_MM;
    return { complete: !outOfTolerance, numeric, outOfTolerance, reference };
  }, [notes, wire?.lengthMm]);
  const persistDraft = useCallback(() => {
    if (!onSaveDraft) {
      return;
    }
    const snapshotEntries = Object.entries(notes)
      .filter(([key]) => key.trim().length > 0)
      .map(([key, value]) => [key, value ?? ""] as const);
    onSaveDraft({ notes: Object.fromEntries(snapshotEntries), activeStep });
  }, [activeStep, notes, onSaveDraft]);

  const resolvedWorkflowTitle =
    workflowTitle ?? (variant === "quality" ? "Quality Test Workflow" : "Operator Test Workflow");
  const resolvedWorkflowDescription =
    workflowDescription ??
    (variant === "quality"
      ? "Capture the inspection measurements and confirm tolerance compliance before releasing the wire."
      : "Complete the required checkpoints before releasing the bundle. Only validated wires can run these tests.");
  const resolvedConfirmLabel = confirmLabel ?? (variant === "quality" ? "Complete Quality Test" : "Complete Operator Tests");
  const resolvedShowPauseControls = showPauseControls ?? variant === "operator";
  const pauseHandler = onPause ?? (() => { });
  const resumeHandler = onResume ?? (() => { });

  useEffect(() => {
    photoSelectionsRef.current = photoSelections;
  }, [photoSelections]);

  useEffect(() => {
    let cancelled = false;

    if (!wire || !featureFlags.crimpTest) {
      setToolSpecs({});
      return () => {
        cancelled = true;
      };
    }

    const loadSpecs = async () => {
      const next: Partial<Record<StepSide, CrimpToolSpec | null>> = {};
      const sides: Array<[StepSide, WireTerminalSpec | null | undefined]> = [
        ["left", wire.ext1],
        ["right", wire.ext2],
      ];
      for (const [side, extremity] of sides) {
        const terminal = extremity?.terminal?.trim();
        if (!terminal) {
          next[side] = null;
          continue;
        }
        try {
          const spec = await fetchCrimpToolSpec({
            terminal,
            joint: extremity?.joint ?? null,
          });
          if (cancelled) {
            return;
          }
          next[side] = spec;
        } catch {
          if (cancelled) {
            return;
          }
          next[side] = null;
        }
      }
      if (!cancelled) {
        setToolSpecs(next);
      }
    };

    void loadSpecs();

    return () => {
      cancelled = true;
    };
  }, [
    wire?.id,
    wire?.ext1?.terminal,
    wire?.ext1?.joint,
    wire?.ext2?.terminal,
    wire?.ext2?.joint,
    featureFlags.crimpTest,
  ]);

  useEffect(() => {
    if (open) {
      const draftNotes = initialNotes ?? {};
      setNotes(draftNotes);
      setActiveStep(() => {
        const target = initialActiveStep ?? 0;
        return Math.min(Math.max(target, 0), Math.max(steps.length - 1, 0));
      });
      setCaptureState(CAPTURE_INITIAL);
      setToolSpecs({});
      cleanupPhotoSelections(photoSelectionsRef.current);
      setPhotoSelections({});
      previewRequests.current = {};
      let cancelled = false;
      void rehydratePhotoSelections(draftNotes).then((rehydrated) => {
        if (cancelled) {
          cleanupPhotoSelections(rehydrated);
          return;
        }
        setPhotoSelections(rehydrated);
      });
      return () => {
        cancelled = true;
      };
    } else {
      setCaptureState(CAPTURE_INITIAL);
      cleanupPhotoSelections(photoSelectionsRef.current);
      previewRequests.current = {};
      setPhotoSelections({});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, wire?.id, initialNotes, initialActiveStep, rehydratePhotoSelections, steps.length]);

  useEffect(() => {
    return () => {
      cleanupPhotoSelections(photoSelectionsRef.current);
      photoSelectionsRef.current = {};
    };
  }, []);

  const handleNoteChange = useCallback((key: string, value: string) => {
    setNotes((prev) => (prev[key] === value ? prev : { ...prev, [key]: value }));
  }, []);

  const commitCaptureBuffer = useCallback(
    (side: StepSide) => {
      setCaptureState((prev) => {
        if (!prev.side || prev.side !== side) {
          return prev;
        }
        const normalized = prev.buffer.replace(/,/g, ".").replace(/[^0-9.]/g, "");
        if (!normalized) {
          return CAPTURE_INITIAL;
        }
      const rawnumeric = Number.parseFloat(normalized);
      const numeric = rawnumeric / 1000; // Convert from micrometers to millimetres
      if (!Number.isFinite(numeric)) {
        return CAPTURE_INITIAL;
      }
      handleNoteChange(`crimp-${side}`, numeric.toFixed(3));
        return { side: null, buffer: "", lastKey: prev.lastKey };
      });
    },
    [handleNoteChange],
  );

  const handlePhotoSelected = useCallback(
    async (key: string, selectedPath?: string) => {
      const existing = photoSelectionsRef.current[key];
      if (!selectedPath) {
        if (existing?.objectUrl) {
          URL.revokeObjectURL(existing.url);
        }
        previewRequests.current[key] = Date.now();
        setPhotoSelections((prev) => {
          if (!(key in prev)) return prev;
          const next = { ...prev };
          delete next[key];
          return next;
        });
        handleNoteChange(key, "");
        return;
      }

      setPhotoSelections((prev) => {
        const next = { ...prev };
        const current = next[key];
        if (current?.objectUrl) {
          URL.revokeObjectURL(current.url);
        }
        delete next[key];
        return next;
      });
      handleNoteChange(key, selectedPath);

      const requestId = Date.now();
      previewRequests.current[key] = requestId;

      try {
        const selection = await resolvePhotoSelection(selectedPath);
        if (previewRequests.current[key] !== requestId) {
          if (selection.objectUrl) {
            URL.revokeObjectURL(selection.url);
          }
          return;
        }
        setPhotoSelections((prev) => {
          const next = { ...prev };
          const current = next[key];
          if (current?.objectUrl) {
            URL.revokeObjectURL(current.url);
          }
          next[key] = selection;
          return next;
        });
      } catch (error) {
        if (previewRequests.current[key] === requestId) {
          setPhotoSelections((prev) => {
            if (!(key in prev)) {
              return prev;
            }
            const next = { ...prev };
            delete next[key];
            return next;
          });
          handleNoteChange(key, "");
        }
        const message = error instanceof Error ? error.message : "Unable to load microscope preview.";
        toast({ title: "Microscope photo", description: message, variant: "destructive" });
      }
    },
    [handleNoteChange, toast],
  );

  useEffect(() => {
    if (!open || !captureState.side || !comparatorEnabled) {
      return;
    }

    // Map for numeric keys that works with any keyboard layout (QWERTY, AZERTY, etc.)
    const codeToDigit: Record<string, string> = {
      "Digit0": "0", "Digit1": "1", "Digit2": "2", "Digit3": "3", "Digit4": "4",
      "Digit5": "5", "Digit6": "6", "Digit7": "7", "Digit8": "8", "Digit9": "9",
    };

    const handleKeydown = (event: KeyboardEvent) => {
      const { key, code } = event;
      
      if (key === "Tab") {
        return;
      }
      if (key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        commitCaptureBuffer(captureState.side as StepSide);
        return;
      }
      if (key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setCaptureState(CAPTURE_INITIAL);
        return;
      }
      if (key === "Backspace") {
        event.preventDefault();
        event.stopPropagation();
        setCaptureState((prev) =>
          prev.side
            ? {
              ...prev,
              buffer: prev.buffer.slice(0, -1),
              lastKey: "Backspace",
            }
            : prev,
        );
        return;
      }
      if (key === " " || key === "Spacebar") {
        event.preventDefault();
        return;
      }
      
      // Check for numeric keys using code (keyboard layout independent)
      if (code in codeToDigit) {
        event.preventDefault();
        event.stopPropagation();
        const digit = codeToDigit[code];
        setCaptureState((prev) =>
          prev.side
            ? {
              ...prev,
              buffer: `${prev.buffer}${digit}`,
              lastKey: digit,
            }
            : prev,
        );
        return;
      }
      
      // Check for decimal separator (. or ,) using key
      if (key === "." || key === ",") {
        event.preventDefault();
        event.stopPropagation();
        setCaptureState((prev) =>
          prev.side
            ? {
              ...prev,
              buffer: `${prev.buffer}.`,
              lastKey: key,
            }
            : prev,
        );
        return;
      }
    };

    window.addEventListener("keydown", handleKeydown, true);
    return () => window.removeEventListener("keydown", handleKeydown, true);
  }, [open, captureState.side, comparatorEnabled, commitCaptureBuffer]);

  const isStepComplete = useCallback(
    (step: StepDefinition): boolean => {
      switch (step.kind) {
        case "marking":
          return notes.marking === "yes" || notes.marking === "no";
        case "crimp": {
          const { complete } = evaluateCrimp(step);
          return complete;
        }
        case "traction": {
          const { complete } = evaluateTraction(step);
          return complete;
        }
        case "stripping": {
          const { complete } = evaluateStripping(step);
          return complete;
        }
        case "length": {
          const { complete } = evaluateLength();
          return complete;
        }
        case "photo-front":
        case "photo-back": {
          const key = `photo-${step.side}-${step.kind === "photo-front" ? "front" : "back"}`;
          return Boolean(photoSelections[key] || notes[key] === PHOTO_SKIP_SENTINEL);
        }
        case "notice":
        default:
          return true;
      }
    },
    [
      notes,
      photoSelections,
      evaluateCrimp,
      evaluateTraction,
      evaluateStripping,
      evaluateLength,
    ],
  );

  const isStepUnlocked = useCallback(
    (index: number): boolean => {
      if (index <= activeStep) {
        return true;
      }
      for (let i = 0; i < index; i += 1) {
        const step = steps[i];
        if (!isStepComplete(step)) {
          return false;
        }
      }
      return true;
    },
    [activeStep, isStepComplete, steps],
  );

  const identifier = useMemo(
    () => buildIdentifier(order, wire),
    [order?.id, wire?.id, wire?.refWire, wire?.marquage],
  );
  const isPaused = wire?.status === "paused";
  const canPause =
    resolvedShowPauseControls &&
    Boolean(wire) &&
    !["not_validated", "completed", "stopped"].includes(wire?.status ?? "not_validated");

  const currentStep = steps[activeStep];
  const stepTitle = currentStep ? getStepTitle(currentStep) : resolvedWorkflowTitle;
  const stepSubtitle = currentStep ? getStepSubtitle(currentStep, wire, toolSpecs) : undefined;
  const progress = steps.length === 0 ? 0 : Math.round(((activeStep + 1) / steps.length) * 100);

  const leftProcess = toTitleCase(normalizeProcess(wire?.ext1?.kind));
  const rightProcess = toTitleCase(normalizeProcess(wire?.ext2?.kind));
  const processLabel =
    leftProcess && rightProcess
      ? leftProcess === rightProcess
        ? leftProcess
        : `Left: ${leftProcess} · Right: ${rightProcess}`
      : leftProcess ?? rightProcess ?? "Standard";

  const allStepsComplete = useMemo(() => steps.every((step) => isStepComplete(step)), [steps, isStepComplete]);
  const confirmDisabled = isSubmitting || savingPhotos || !allStepsComplete;
  const currentStepComplete = currentStep ? isStepComplete(currentStep) : true;
  const nextDisabled =
    isSubmitting ||
    !currentStepComplete ||
    activeStep >= steps.length - 1;
  const handlePauseOrResume = useCallback(async () => {
    if (!identifier) {
      return;
    }
    if (isPaused) {
      try {
        const result = resumeHandler(identifier);
        if (result instanceof Promise) {
          await result;
        }
      } catch {
        /* noop */
      }
      return;
    }
    persistDraft();
    try {
      const result = pauseHandler(identifier);
      if (result instanceof Promise) {
        await result;
      }
      onOpenChange(false);
    } catch {
      /* keep dialog open on failure */
    }
  }, [identifier, isPaused, pauseHandler, persistDraft, resumeHandler, onOpenChange]);



  const renderMarkingStep = () => {
    const markingChoice = notes.marking ?? "";
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Is the marking visible and compliant with the order reference?
        </p>
        <div className="space-y-2">
          <Label className="text-xs uppercase tracking-wide text-muted-foreground">Response</Label>
          <ToggleGroup
            type="single"
            value={markingChoice}
            onValueChange={(value) => handleNoteChange("marking", value || "")}
            className="justify-start"
          >
            <ToggleGroupItem value="yes" variant="outline" className="px-4">
              Yes
            </ToggleGroupItem>
            <ToggleGroupItem value="no" variant="outline" className="px-4">
              No
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
        {markingChoice === "no" ? (
          <Alert variant="destructive" className="border-destructive/70 bg-destructive/10">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Marking flagged as NOK</AlertTitle>
            <AlertDescription>
              Pause production and alert the quality team before proceeding.
            </AlertDescription>
          </Alert>
        ) : null}
      </div>
    );
  };

  const renderCrimpStep = (step: StepDefinition) => {
    const key = `crimp-${step.side}`;
    const value = notes[key] ?? "";
    const spec = toolSpecs[step.side] ?? null;
    const tolerance = formatRange(spec?.hcMin ?? null, spec?.hcMax ?? null);
    const captureActive = captureState.side === step.side;
    const buffer = captureActive ? captureState.buffer : "";
    const evaluation = evaluateCrimp(step);
    const invalidValue = value.trim().length > 0 && evaluation.numeric == null;
    const outOfTolerance = evaluation.outOfTolerance;

    return (
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Capture the comparator reading or type it manually. Press Enter on the comparator to store the value.
        </p>
        {spec?.status && spec.statusOk === false ? (
          <Alert variant="destructive" className="border-destructive/70 bg-destructive/10">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Tool status warning</AlertTitle>
            <AlertDescription>{spec.status}</AlertDescription>
          </Alert>
        ) : null}
        <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_220px] sm:items-start">
          <div className="space-y-2">
            <Label htmlFor={`${key}-input`}>Measured height (mm)</Label>
            <Input
              id={`${key}-input`}
              inputMode="decimal"
              pattern="[0-9]*[.,]?[0-9]*"
              placeholder="e.g. 1.24"
              value={value}
              onChange={(event) => handleNoteChange(key, event.target.value)}
            />
            <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
              {tolerance ? <span>Tolerance: {tolerance}</span> : null}
              {!tolerance && spec?.hcNominal != null ? (
                <span>Nominal {spec.hcNominal.toFixed(3)} mm</span>
              ) : null}
              {step.extremity?.terminal ? <span>Terminal {step.extremity.terminal}</span> : null}
              {step.extremity?.joint ? <span>Joint {step.extremity.joint}</span> : null}
            </div>
            {invalidValue ? (
              <p className="text-xs font-medium text-destructive">Enter a numeric value.</p>
            ) : null}
            {!invalidValue && outOfTolerance ? (
              <p className="text-xs font-medium text-destructive">Value outside tolerance.</p>
            ) : null}
          </div>
          <div className="space-y-2">
            <Button
              type="button"
              variant={captureActive ? "secondary" : "outline"}
              onClick={() =>
                setCaptureState((prev) =>
                  prev.side === step.side ? CAPTURE_INITIAL : { side: step.side, buffer: "", lastKey: undefined },
                )
              }
              disabled={!comparatorEnabled}
              className="w-full"
            >
              {captureActive ? "Listening…" : "Ready for comparator"}
            </Button>
            <div className="rounded-md border border-dashed border-border/60 px-3 py-2 text-xs text-muted-foreground">
              <div>Buffer: {buffer || "—"}</div>
              <div>
                Status:
                {captureActive
                  ? " Press Enter to record"
                  : comparatorEnabled
                    ? " Comparator idle"
                    : " Comparator capture disabled"}
              </div>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => commitCaptureBuffer(step.side)}
              disabled={!captureActive || !buffer}
            >
              Apply buffer
            </Button>
          </div>
        </div>
      </div>
    );
  };

  const renderTractionStep = (step: StepDefinition) => {
    const key = `traction-${step.side}`;
    const value = notes[key] ?? "";
    const spec = toolSpecs[step.side] ?? null;
    const nominal = spec?.tractionNominal ?? null;
    const evaluation = evaluateTraction(step);
    const invalidValue = value.trim().length > 0 && evaluation.numeric == null;
    const belowNominal = evaluation.belowNominal;

    return (
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Record the measured pull force (N) for the {formatSide(step.side).toLowerCase()} extremity.
        </p>
        <div className="space-y-2">
          <Label htmlFor={`${key}-input`}>Force (N)</Label>
          <Input
            id={`${key}-input`}
            type="number"
            step="0.1"
            placeholder={nominal != null ? `${nominal.toFixed(1)} Nominal` : "e.g. 75"}
            value={value}
            onChange={(event) => handleNoteChange(key, event.target.value)}
          />
          {nominal != null ? (
            <p className="text-xs text-muted-foreground">Nominal {nominal.toFixed(1)} N</p>
          ) : null}
          {invalidValue ? (
            <p className="text-xs font-medium text-destructive">Enter a numeric value.</p>
          ) : null}
          {!invalidValue && belowNominal ? (
            <p className="text-xs font-medium text-destructive">Value below nominal traction.</p>
          ) : null}
        </div>
      </div>
    );
  };

  const renderStrippingStep = (step: StepDefinition) => {
    const key = `strip-${step.side}`;
    const value = notes[key] ?? "";
    const reference = typeof step.extremity?.stripping === "number" ? step.extremity.stripping : null;
    const evaluation = evaluateStripping(step);
    const invalidValue = value.trim().length > 0 && evaluation.numeric == null;
    const outOfTolerance = evaluation.outOfTolerance;

    return (
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Measure stripped length for the {formatSide(step.side).toLowerCase()} extremity.
        </p>
        <div className="space-y-2">
          <Label htmlFor={`${key}-input`}>Length (mm)</Label>
          <Input
            id={`${key}-input`}
            type="number"
            step="0.1"
            placeholder={reference != null ? reference.toFixed(1) : "Nominal"}
            value={value}
            onChange={(event) => handleNoteChange(key, event.target.value)}
          />
          {reference != null ? (
            <p className="text-xs text-muted-foreground">
              Reference {reference.toFixed(1)} mm (±{STRIPPING_TOLERANCE_MM} mm)
            </p>
          ) : null}
          {invalidValue ? (
            <p className="text-xs font-medium text-destructive">Enter a numeric value.</p>
          ) : null}
          {!invalidValue && outOfTolerance ? (
            <p className="text-xs font-medium text-destructive">Value outside tolerance.</p>
          ) : null}
        </div>
      </div>
    );
  };

  const renderLengthStep = () => {
    const key = "wire-length";
    const value = notes[key] ?? "";
    const reference = typeof wire?.lengthMm === "number" ? wire.lengthMm : null;
    const evaluation = evaluateLength();
    const invalidValue = value.trim().length > 0 && evaluation.numeric == null;
    const outOfTolerance = evaluation.outOfTolerance;

    return (
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">Validate total wire length against the production order.</p>
        <div className="space-y-2">
          <Label htmlFor={`${key}-input`}>Measured length (mm)</Label>
          <Input
            id={`${key}-input`}
            type="number"
            step="0.1"
            placeholder={reference != null ? reference.toString() : "Length"}
            value={value}
            onChange={(event) => handleNoteChange(key, event.target.value)}
          />
          {reference != null ? (
            <p className="text-xs text-muted-foreground">
              Reference {reference.toFixed(0)} mm (±{LENGTH_TOLERANCE_MM} mm)
            </p>
          ) : null}
          {invalidValue ? (
            <p className="text-xs font-medium text-destructive">Enter a numeric value.</p>
          ) : null}
          {!invalidValue && outOfTolerance ? (
            <p className="text-xs font-medium text-destructive">Value outside tolerance.</p>
          ) : null}
        </div>
      </div>
    );
  };



  const renderPhotoStep = (step: StepDefinition, orientation: "front" | "back") => {
    const key = `photo-${step.side}-${orientation}`;
    const selection = photoSelections[key];
    const skipped = notes[key] === PHOTO_SKIP_SENTINEL;
    const label = `${formatSide(step.side)} ${orientation === "front" ? "Front" : "Back"} photo`;

    const handleSkipToggle = (checked: boolean) => {
      if (checked) {
        handlePhotoSelected(key, undefined);
        handleNoteChange(key, PHOTO_SKIP_SENTINEL);
      } else if (notes[key] === PHOTO_SKIP_SENTINEL) {
        handleNoteChange(key, "");
      }
    };

    const handleCameraCapture = async (base64Data: string) => {
      if (!order || !wire) return;

      try {
        const machineIdentifier =
          flowState.session?.machineId?.trim() || order.machineId?.trim() || null;

        const savedPath = await saveCameraPhoto({
          imageData: base64Data,
          ofId: order.ofId,
          reference: order.reference,
          refWire: wire.refWire,
          marquage: wire.marquage,
          side: step.side,
          orientation: orientation,
          machineId: machineIdentifier,
          operatorId: operatorId,
          qualityAgentId: variant === "quality" ? qualityAgent : null,
        });

        await handlePhotoSelected(key, savedPath);

        // Auto-advance to the next step after successful capture
        if (activeStep < steps.length - 1) {
          setTimeout(() => {
            setActiveStep((prev) => prev + 1);
          }, 300); // Small delay to show "captured" state briefly
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to save camera photo.";
        toast({
          title: "Camera Capture",
          description: message,
          variant: "destructive",
        });
      }
    };

    return (
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Capture the {orientation} microscope photo for the {formatSide(step.side).toLowerCase()} side.
        </p>
        <div className="flex items-center gap-2">
          <Checkbox
            id={`${key}-skip`}
            checked={skipped}
            onCheckedChange={(checked) => handleSkipToggle(checked === true)}
            className="h-4 w-4"
          />
          <Label htmlFor={`${key}-skip`} className="text-xs text-muted-foreground">
            Photo not required for this extremity
          </Label>
        </div>

        {skipped ? (
          <div className="rounded-md border border-dashed border-border/60 bg-muted/10 p-4 text-xs text-muted-foreground">
            Photo capture marked as skipped. Confirm that compliance is recorded in the operator log.
          </div>
        ) : selection ? (
          <div className="space-y-3">
            <div className="aspect-video relative rounded-md overflow-hidden bg-black/10 border border-border/50">
              <img src={selection.url} alt="Captured" className="w-full h-full object-contain" />
            </div>
            <Button variant="outline" className="w-full gap-2" onClick={() => handlePhotoSelected(key, undefined)}>
              <ImagePlus className="h-4 w-4" />
              Retake Photo
            </Button>
          </div>
        ) : (
          <CameraCapture
            label={label}
            onCapture={handleCameraCapture}
          />
        )}
      </div>
    );
  };

  const renderNoticeStep = (step: StepDefinition) => (
    <div className="rounded-md border border-dashed border-border/60 bg-muted/10 p-4 text-sm text-muted-foreground">
      {formatSide(step.side)} extremity has no configured tests.
    </div>
  );

  const handleConfirm = useCallback(async () => {
    if (savingPhotos || isSubmitting) {
      return;
    }

    if (!order || !wire) {
      toast({
        title: "Microscope photos",
        description: "Select a wire and order before completing the operator test.",
        variant: "destructive",
      });
      return;
    }

    setSavingPhotos(true);
    try {
      const uploads: Record<string, string> = {};
      const machineIdentifier =
        flowState.session?.machineId?.trim() || order.machineId?.trim() || null;

      for (const [key, selection] of Object.entries(photoSelectionsRef.current)) {
        const sourcePath = selection.path;
        if (!sourcePath) {
          continue;
        }
        const parts = key.split("-");
        if (parts.length !== 3) {
          continue;
        }
        const [, side, orientation] = parts;
        const savedPath = selection.path; // Updated as per instruction
        uploads[key] = savedPath;
      }

      const normalizedEntries = Object.entries(notes).map<[string, string]>(([key, value]) => [
        key,
        value === PHOTO_SKIP_SENTINEL ? "skipped" : value,
      ]);
      const normalizedNotes: Record<string, string> = Object.fromEntries(normalizedEntries);

      for (const [key, path] of Object.entries(uploads)) {
        normalizedNotes[key] = path;
      }

      await onComplete({ notes: normalizedNotes });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to save microscope photos.";
      toast({
        title: "Microscope photos",
        description: message,
        variant: "destructive",
      });
    } finally {
      setSavingPhotos(false);
    }
  }, [
    flowState.session?.machineId,
    isSubmitting,
    notes,
    onComplete,
    operatorId,
    order,
    qualityAgent,
    savingPhotos,
    toast,
    variant,
    wire,
  ]);

  const renderStepContent = () => {
    if (!currentStep) {
      return <p className="text-sm text-muted-foreground">No tests configured for this wire.</p>;
    }
    switch (currentStep.kind) {
      case "marking":
        return renderMarkingStep();
      case "crimp":
        return renderCrimpStep(currentStep);
      case "traction":
        return renderTractionStep(currentStep);
      case "stripping":
        return renderStrippingStep(currentStep);
      case "length":
        return renderLengthStep();
      case "photo-front":
        return renderPhotoStep(currentStep, "front");
      case "photo-back":
        return renderPhotoStep(currentStep, "back");
      case "notice":
      default:
        return renderNoticeStep(currentStep);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="grid w-[min(100vw-2rem,960px)] max-w-4xl max-h-[90vh] grid-rows-[auto,1fr,auto] overflow-hidden">
        <DialogHeader className="space-y-2">
          <DialogTitle className="flex items-center justify-between gap-2 text-lg">
            <span>{resolvedWorkflowTitle}</span>
            <Badge variant="secondary" className="rounded-full text-xs">
              Step {steps.length === 0 ? 0 : activeStep + 1} / {steps.length || 0}
            </Badge>
          </DialogTitle>
          <DialogDescription>{resolvedWorkflowDescription}</DialogDescription>
        </DialogHeader>

        <ScrollArea className="min-h-0 h-full pr-2">
          <div className="space-y-3 pb-3">
            <section className="rounded-2xl border border-border/50 bg-muted/20 p-2.5 text-sm text-muted-foreground">
              {wire ? (
                <WireIllustration wire={wire} order={order} processLabel={processLabel} />
              ) : (
                <p className="text-sm text-muted-foreground">Select a wire to view its illustration and details.</p>
              )}
            </section>

            <section className="space-y-3">
              <div className="flex flex-wrap gap-2 overflow-x-auto pb-1">
                {steps.map((step, index) => {
                  const unlocked = isStepUnlocked(index);
                  return (
                    <button
                      key={step.key}
                      type="button"
                      className={cn(
                        "flex items-center gap-2 rounded-md border px-3 py-2 text-xs transition",
                        index === activeStep
                          ? "border-primary/60 bg-primary/10 text-primary"
                          : unlocked
                            ? "border-border/60 bg-muted/10 text-muted-foreground hover:bg-muted/20"
                            : "border-border/60 bg-muted/10 text-muted-foreground opacity-60 cursor-not-allowed",
                      )}
                      onClick={() => {
                        if (isSubmitting || !unlocked) return;
                        setActiveStep(index);
                      }}
                      disabled={isSubmitting || !unlocked}
                    >
                      <span className="flex h-5 w-5 items-center justify-center rounded-full border border-current text-[0.65rem]">
                        {index + 1}
                      </span>
                      <span className="font-medium">{getStepNavLabel(step)}</span>
                    </button>
                  );
                })}
              </div>
              <div className="rounded-lg border border-border/50 bg-background/95 p-4 shadow-sm">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-sm font-semibold text-foreground">{stepTitle}</h3>
                    {stepSubtitle ? <p className="text-xs text-muted-foreground">{stepSubtitle}</p> : null}
                  </div>
                  <Badge variant="outline" className="border-border/60 text-xs">
                    {progress}%
                  </Badge>
                </div>
                <Separator className="my-3" />
                {renderStepContent()}
              </div>
            </section>

          </div>
        </ScrollArea>

        <DialogFooter className="flex flex-col gap-3 border-t border-border/60 pt-4 sm:flex-row sm:justify-between">
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={() => setActiveStep((prev) => Math.max(prev - 1, 0))}
              disabled={activeStep === 0 || isSubmitting}
              className="gap-1"
            >
              <ChevronLeft className="h-4 w-4" />
              Back
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                if (nextDisabled) return;
                setActiveStep((prev) => Math.min(prev + 1, Math.max(steps.length - 1, 0)));
              }}
              disabled={nextDisabled}
              className="gap-1"
            >
              Next
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
              Cancel
            </Button>
            {resolvedShowPauseControls ? (
              <Button
                variant={isPaused ? "secondary" : "outline"}
                onClick={() => {
                  void handlePauseOrResume();
                }}
                disabled={!identifier || !canPause || pausePending || isSubmitting}
                className="gap-1"
              >
                {isPaused ? (
                  <>
                    <PlayCircle className="h-4 w-4" />
                    Resume
                  </>
                ) : (
                  <>
                    <PauseCircle className="h-4 w-4" />
                    Pause
                  </>
                )}
              </Button>
            ) : null}
            <Button onClick={handleConfirm} disabled={confirmDisabled} className="gap-2">
              {savingPhotos || isSubmitting ? "Saving…" : resolvedConfirmLabel}
              <BadgeCheck className="h-4 w-4" />
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
