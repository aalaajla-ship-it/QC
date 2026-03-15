import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';

import { OperatorActionsDialog } from './OperatorActionsDialog';
import type { WireSummary, WorkOrderSummary } from '@/lib/types';
import { renderWithProviders } from '@/tests/utils';
import * as api from '@/lib/api';

const baseWire: WireSummary = {
  id: 101,
  refCoil: 'COIL-100',
  refWire: 'WIRE-100',
  marquage: 'MK-100',
  operatorTestDone: true,
  lengthMm: 1200,
  section: 1.5,
  colorPrimary: 'Red',
  colorSecondary: null,
  bundleCount: 4,
  status: 'validated',
  previousStatus: null,
  producedQuantity: 200,
  targetQuantity: 800,
  progressPercent: 25,
  bootTestDone: true,
  bootTestRequired: false,
  bootTestRequiredCount: 0,
  bootTestDoneCount: 0,
  wheelTestDone: true,
  wheelTestRequired: false,
  finalTestDone: false,
  finalTestRequired: false,
  ext1: null,
  ext2: null,
};

const baseOrder: WorkOrderSummary = {
  id: 7,
  ofId: 'OF-700',
  reference: 'REF-700',
  quantityTotal: 800,
  bundleCount: 4,
  status: 'in_production',
  progressPercent: 25,
  machineId: null,
  wires: [baseWire],
};

const defaultResults: api.TestResult = {
  status: 'OK',
  overallPassed: true,
  verdicts: [],
};

describe('OperatorActionsDialog', () => {
  beforeEach(() => {
    vi.spyOn(api, 'fetchOperatorTestResults').mockResolvedValue(defaultResults);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function renderDialog(
    overrides: Partial<React.ComponentProps<typeof OperatorActionsDialog>> = {},
  ) {
    const { ui } = renderWithProviders(
      <OperatorActionsDialog
        open
        wire={baseWire}
        order={baseOrder}
        notes={{}}
        isRecording={false}
        onOpenChange={() => {}}
        onRecordBundle={() => {}}
        {...overrides}
      />,
    );
    return render(ui);
  }

  it('calls onChangeCoil when change coil button is pressed', async () => {
    const onChangeCoil = vi.fn();
    renderDialog({ onChangeCoil });

    const user = userEvent.setup();
    const button = await screen.findByRole('button', { name: /change coil/i });
    await user.click(button);

    expect(onChangeCoil).toHaveBeenCalledTimes(1);
  });

  it('disables change coil button when changeCoilDisabled is true', async () => {
    renderDialog({ onChangeCoil: vi.fn(), changeCoilDisabled: true });

    const button = await screen.findByRole('button', { name: /change coil/i });
    expect(button).toBeDisabled();
  });
});
