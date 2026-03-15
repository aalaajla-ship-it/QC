import { render, waitFor } from "@testing-library/react";
import { useEffect, useRef } from "react";

import {
  PrinterConfigProvider,
  usePrinterConfig,
  type LabelPrintingState,
} from "./PrinterConfigContext";
import * as api from "@/lib/api";

let dialogHandler: ((props: any) => void) | null = null;

vi.mock("@/components/printer/PrinterConfigDialog", () => {
  const React = require("react");
  const { useEffect, useRef } = React;

  const MockDialog = (props: any) => {
    const hasOpenedRef = useRef(false);

    useEffect(() => {
      if (props.open && !hasOpenedRef.current) {
        hasOpenedRef.current = true;
        if (dialogHandler) {
          const handler = dialogHandler;
          dialogHandler = null;
          handler(props);
        }
      }
      if (!props.open) {
        hasOpenedRef.current = false;
      }
    }, [props.open]);

    return null;
  };

  return { PrinterConfigDialog: MockDialog };
});

function captureState(onState: (state: LabelPrintingState) => void) {
  return function Capture() {
    const { state } = usePrinterConfig();
    useEffect(() => {
      if (!state.loading) {
        onState(state);
      }
    }, [state]);
    return null;
  };
}

function triggerSave(onComplete: (state: LabelPrintingState) => void) {
  return function TriggerSave() {
    const { state, openDialog } = usePrinterConfig();
    const openedRef = useRef(false);

    useEffect(() => {
      if (!state.loading && !openedRef.current) {
        openedRef.current = true;
        openDialog();
      }
    }, [state.loading, openDialog]);

    useEffect(() => {
      if (!state.loading && openedRef.current) {
        onComplete(state);
      }
    }, [state, onComplete]);

    return null;
  };
}

describe("PrinterConfigProvider", () => {
  beforeEach(() => {
    dialogHandler = null;
    vi.clearAllMocks();
  });

  test("normalizes API response and preserves TSPL settings", async () => {
    const tspl = {
      widthMm: 62,
      heightMm: 18,
      gapMm: 2,
      speed: 5,
      density: 10,
      direction: 1,
    };
    vi.spyOn(api, "fetchLabelPrinterSettings").mockResolvedValue({
      enabled: true,
      labelFormat: "Direct ",
      labelPrinterName: "Zebra-GX",
      defaultFormat: "PDF",
      resolvedFormat: "DIRECT",
      tsplSettings: tspl,
    });

    const onState = vi.fn();
    const Capture = captureState(onState);

    render(
      <PrinterConfigProvider>
        <Capture />
      </PrinterConfigProvider>,
    );

    await waitFor(() => {
      expect(onState).toHaveBeenCalled();
    });

    const latestState = onState.mock.calls.at(-1)?.[0] as LabelPrintingState;
    expect(latestState.loading).toBe(false);
    expect(latestState.resolvedFormat).toBe("direct");
    expect(latestState.tspl).toEqual(tspl);
    expect(latestState.tspl).not.toBe(tspl);
  });

  test("falls back to default TSPL settings when response omits them", async () => {
    vi.spyOn(api, "fetchLabelPrinterSettings").mockResolvedValue({
      enabled: false,
      labelFormat: null,
      labelPrinterName: null,
      defaultFormat: "pdf",
      resolvedFormat: "pdf",
      tsplSettings: undefined as unknown as api.LabelPrinterTsplSettings,
    });

    const onState = vi.fn();
    const Capture = captureState(onState);

    render(
      <PrinterConfigProvider>
        <Capture />
      </PrinterConfigProvider>,
    );

    await waitFor(() => {
      expect(onState).toHaveBeenCalled();
    });

    const latestState = onState.mock.calls.at(-1)?.[0] as LabelPrintingState;
    expect(latestState.loading).toBe(false);
    expect(latestState.tspl).toEqual({
      widthMm: 100,
      heightMm: 18,
      gapMm: 2,
      speed: 4,
      density: 8,
      direction: 1,
    });
  });

  test("submits TSPL settings and updates state from save response", async () => {
    const initialTspl = {
      widthMm: 100,
      heightMm: 18,
      gapMm: 2,
      speed: 4,
      density: 8,
      direction: 1,
    };
    const updatedTspl = { ...initialTspl, widthMm: 55 };

    vi.spyOn(api, "fetchLabelPrinterSettings").mockResolvedValue({
      enabled: true,
      labelFormat: "direct",
      labelPrinterName: "Zebra-GX",
      defaultFormat: "pdf",
      resolvedFormat: "direct",
      tsplSettings: initialTspl,
    });

    const saveMock = vi
      .spyOn(api, "saveLabelPrinterSettings")
      .mockImplementation(async (payload) => {
        expect(payload).toEqual({
          labelFormat: "direct",
          labelPrinterName: "Zebra-GX",
          tsplSettings: updatedTspl,
        });
        return {
          enabled: true,
          labelFormat: "direct",
          labelPrinterName: "Zebra-GX",
          defaultFormat: "pdf",
          resolvedFormat: "direct",
          tsplSettings: updatedTspl,
        };
      });

    dialogHandler = (props) => {
      void Promise.resolve().then(() => {
        void props.onSubmit({
          labelFormat: "direct",
          labelPrinterName: "Zebra-GX",
          tsplSettings: updatedTspl,
        });
      });
    };

    const onComplete = vi.fn();
    const Trigger = triggerSave(onComplete);

    render(
      <PrinterConfigProvider>
        <Trigger />
      </PrinterConfigProvider>,
    );

    await waitFor(() => {
      expect(saveMock).toHaveBeenCalled();
    });

    await waitFor(() => {
      expect(onComplete).toHaveBeenCalled();
    });

    const latestState = onComplete.mock.calls.at(-1)?.[0] as LabelPrintingState;
    expect(latestState.tspl).toEqual(updatedTspl);
    expect(latestState.resolvedFormat).toBe("direct");
  });
});

