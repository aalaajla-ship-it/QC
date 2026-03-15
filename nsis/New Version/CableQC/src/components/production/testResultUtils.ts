import type { TestMeasurementVerdict } from "@/lib/api";

export const MEASUREMENT_LABELS: Record<string, string> = {
  "crimp-left": "Crimp height (left)",
  "crimp-right": "Crimp height (right)",
  "traction-left": "Traction (left)",
  "traction-right": "Traction (right)",
  "strip-left": "Stripping (left)",
  "strip-right": "Stripping (right)",
  length: "Wire length",
};

export function formatMeasurementValue(value: number | null, unit?: string | null): string {
  if (value == null || Number.isNaN(value)) {
    return "—";
  }
  const decimals = unit === "N" ? 1 : 2;
  const suffix = unit ? ` ${unit}` : "";
  return `${value.toFixed(decimals)}${suffix}`;
}

export function formatSpec(verdict: TestMeasurementVerdict): string | null {
  const unitSuffix = verdict.unit ? ` ${verdict.unit}` : "";
  const decimals = verdict.unit === "N" ? 1 : 2;
  const fmt = (value: number) => value.toFixed(decimals);
  if (verdict.lowerBound != null && verdict.upperBound != null) {
    return `Spec ${fmt(verdict.lowerBound)} – ${fmt(verdict.upperBound)}${unitSuffix}`;
  }
  if (verdict.lowerBound != null) {
    return `Min ${fmt(verdict.lowerBound)}${unitSuffix}`;
  }
  if (verdict.upperBound != null) {
    return `Max ${fmt(verdict.upperBound)}${unitSuffix}`;
  }
  if (verdict.nominal != null) {
    return `Nominal ${fmt(verdict.nominal)}${unitSuffix}`;
  }
  return null;
}
