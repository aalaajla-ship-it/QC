import { describe, it, expect } from "vitest";

import { buildWireColorInfo, deriveSteps } from "./OperatorTestDialog";
import type { WireSummary } from "@/lib/types";
import type { FeatureFlags } from "@/lib/featureFlags";

const minimalWire: WireSummary = {
  id: 1,
  refCoil: "BASE-COIL",
  refWire: "BASE-WIRE",
  marquage: "BASE",
  operatorTestDone: false,
  lengthMm: 50,
  section: 0.5,
  colorPrimary: "Rouge",
  colorSecondary: null,
  bundleCount: 1,
  status: "validated",
  previousStatus: null,
  producedQuantity: 0,
  targetQuantity: 1,
  progressPercent: 0,
  bootTestDone: false,
  bootTestRequired: false,
  bootTestRequiredCount: 0,
  bootTestDoneCount: 0,
  wheelTestDone: false,
  wheelTestRequired: false,
  finalTestDone: false,
  finalTestRequired: false,
  ext1: {
    terminal: "TER-1",
    joint: null,
    stripping: 4,
    kind: "Sertissage simple",
  },
  ext2: {
    terminal: "TER-2",
    joint: null,
    stripping: 4,
    kind: "Sertissage simple",
  },
};

const allEnabledFlags: FeatureFlags = {
  crimpTest: true,
  comparatorTest: true,
  microscopeTest: true,
  labelPrinting: true,
};

describe("deriveSteps", () => {

  it("builds expected workflow for reference 9854423.1 sample", () => {
    const sampleWire: WireSummary = {
      id: 1,
      refCoil: "CAB-6913",
      refWire: "CAB-6913-1",
      marquage: "X1:2/01/:2A",
      operatorTestDone: false,
      lengthMm: 75,
      section: 0.75,
      colorPrimary: "Rouge",
      colorSecondary: null,
      bundleCount: 1,
      status: "validated",
      previousStatus: null,
      producedQuantity: 0,
      targetQuantity: 1,
      progressPercent: 0,
      bootTestDone: false,
      bootTestRequired: false,
      bootTestRequiredCount: 0,
      bootTestDoneCount: 0,
      wheelTestDone: false,
      wheelTestRequired: false,
      finalTestDone: false,
      finalTestRequired: false,
      ext1: {
        terminal: "TER-521",
        joint: null,
        stripping: 4,
        kind: "Sertissage simple",
      },
      ext2: {
        terminal: null,
        joint: null,
        stripping: 7,
        kind: "Dénuder",
      },
    };

    const steps = deriveSteps(sampleWire, allEnabledFlags);
    const kinds = steps.map((step) => step.kind);

    expect(kinds).toEqual([
      "marking",
      "crimp",
      "traction",
      "stripping",
      "length",
      "photo-front",
      "photo-back",
      "stripping",
    ]);
    expect(steps[0]).toMatchObject({ side: "left" });
    const lastStep = steps[steps.length - 1];
    expect(lastStep).toMatchObject({ side: "right", kind: "stripping" });
    expect(kinds).not.toContain("notice");
  });

  it("omits crimp steps when crimp feature disabled", () => {
    const wire = {
      ...minimalWire,
      ext1: { ...minimalWire.ext1, kind: "Sertissage simple" },
      ext2: { ...minimalWire.ext2, kind: "Sertissage simple" },
    } satisfies WireSummary;

    const steps = deriveSteps(wire, { ...allEnabledFlags, crimpTest: false });
    const kinds = steps.map((step) => step.kind);

    expect(kinds).not.toContain("crimp");
    expect(kinds).toContain("marking");
  });

  it("omits microscope photo steps when microscope feature disabled", () => {
    const wire = {
      ...minimalWire,
      ext1: { ...minimalWire.ext1, kind: "Sertissage simple" },
    } satisfies WireSummary;

    const steps = deriveSteps(wire, { ...allEnabledFlags, microscopeTest: false });
    const kinds = steps.map((step) => step.kind);

    expect(kinds).not.toContain("photo-front");
    expect(kinds).not.toContain("photo-back");
  });

  it("omits marking validation when label printing disabled", () => {
    const wire = {
      ...minimalWire,
      ext1: { ...minimalWire.ext1, kind: "Sertissage simple" },
      ext2: { ...minimalWire.ext2, kind: "Sertissage simple" },
    } satisfies WireSummary;

    const steps = deriveSteps(wire, { ...allEnabledFlags, labelPrinting: false });
    const kinds = steps.map((step) => step.kind);

    expect(kinds).not.toContain("marking");
    expect(kinds).toContain("crimp");
  });
});

describe("buildWireColorInfo", () => {
  it("returns uppercase label and swatch for hex values", () => {
    const result = buildWireColorInfo("#1f2a3b");
    expect(result).toEqual({ label: "#1F2A3B", swatch: "#1F2A3B" });
  });

  it("falls back to placeholder label when value missing", () => {
    expect(buildWireColorInfo(null)).toEqual({ label: "—" });
  });

  it("returns mapped swatch for known color names", () => {
    expect(buildWireColorInfo("Rouge")).toEqual({ label: "ROUGE", swatch: "#e53935" });
  });
});
