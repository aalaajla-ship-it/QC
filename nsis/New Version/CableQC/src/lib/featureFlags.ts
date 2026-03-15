import { invoke } from "@tauri-apps/api/tauri";

export interface FeatureFlags {
  crimpTest: boolean;
  comparatorTest: boolean;
  microscopeTest: boolean;
  labelPrinting: boolean;
}

const TRUTHY_VALUES = new Set(["1", "true", "yes", "on"]);

function toBoolean(value: string | boolean | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  const normalized = value.trim().toLowerCase();
  if (normalized === "") return fallback;
  return TRUTHY_VALUES.has(normalized) ? true : false;
}

function readFeatureFlag(names: string[], fallback: boolean): boolean {
  for (const name of names) {
    const raw = (import.meta.env as Record<string, string | boolean | undefined>)[name];
    if (raw !== undefined) {
      return toBoolean(raw, fallback);
    }
  }
  return fallback;
}

export function readFeatureFlagsFromEnv(): FeatureFlags {
  return {
    crimpTest: readFeatureFlag(
      ["ENABLE_CRIMP_TEST", "TEST_CRIMP_HEIGHT", "VITE_ENABLE_CRIMP_TEST", "VITE_TEST_CRIMP_HEIGHT"],
      true,
    ),
    comparatorTest: readFeatureFlag(["COMPARATOR_TEST", "VITE_COMPARATOR_TEST"], true),
    microscopeTest: readFeatureFlag(
      ["ENABLE_MICROSCOPE_TEST", "VITE_ENABLE_MICROSCOPE_TEST"],
      true,
    ),
    labelPrinting: readFeatureFlag(
      ["ENABLE_LABEL_PRINTING", "VITE_ENABLE_LABEL_PRINTING"],
      true,
    ),
  };
}

export const buildTimeFeatureFlags: FeatureFlags = readFeatureFlagsFromEnv();

function hasTauriBridge(): boolean {
  return typeof window !== "undefined" && "__TAURI_IPC__" in window;
}

export async function fetchFeatureFlags(): Promise<FeatureFlags> {
  if (!hasTauriBridge()) {
    return buildTimeFeatureFlags;
  }
  try {
    const flags = await invoke<FeatureFlags>("get_feature_flags");
    return flags;
  } catch (error) {
    console.error("[FeatureFlags] Failed to fetch runtime flags", error);
    return buildTimeFeatureFlags;
  }
}

export function mergeFeatureFlags(base: FeatureFlags, overrides: Partial<FeatureFlags>): FeatureFlags {
  return { ...base, ...overrides };
}
