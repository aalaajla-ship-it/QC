import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach } from 'vitest';
import Wires from './Wires';
import { renderWithProviders } from '@/tests/utils';
import * as api from '@/lib/api';
import type { ProductionSnapshot, WireSummary } from '@/lib/types';

afterEach(() => {
  vi.restoreAllMocks();
});

function makeWire(overrides: Partial<WireSummary> = {}): WireSummary {
  return {
    id: 10,
    refCoil: 'C1',
    refWire: 'A12-RED',
    marquage: '12-R',
    operatorTestDone: false,
    lengthMm: 500,
    section: 1.5,
    colorPrimary: 'Red',
    colorSecondary: null,
    bundleCount: 1,
    status: 'not_validated',
    previousStatus: null,
    producedQuantity: 0,
    targetQuantity: 100,
    progressPercent: 0,
    bootTestDone: false,
    bootTestRequired: true,
    bootTestRequiredCount: 1,
    bootTestDoneCount: 0,
    wheelTestDone: false,
    wheelTestRequired: false,
    finalTestDone: false,
    finalTestRequired: false,
    ext1: {
      terminal: 'T-A',
      joint: 'J-A',
      stripping: 5,
      kind: 'sertissage_simple',
    },
    ext2: {
      terminal: 'T-B',
      joint: 'J-B',
      stripping: 5,
      kind: 'sertissage_simple',
    },
    ...overrides,
  };
}

function makeSnapshot(): ProductionSnapshot {
  return {
    totals: {
      totalOrders: 1,
      activeOrders: 1,
      completedOrders: 0,
      totalWires: 1,
      validatedWires: 0,
      completedWires: 0,
      testsBlocking: 0,
      averageProgress: 0,
    },
    orders: [
      {
        id: 1,
        ofId: 'OF-100',
        reference: 'REF-1',
        quantityTotal: 100,
        bundleCount: 1,
        status: 'in_production',
        progressPercent: 0,
        machineId: null,
        wires: [
          makeWire(),
        ],
      },
    ],
  };
}

describe('Wires page', () => {
  test('renders orders table and allows wire validation and production add', async () => {
    const initialSnapshot = makeSnapshot();
    const afterValidation = makeSnapshot();
    afterValidation.orders[0].wires[0] = {
      ...afterValidation.orders[0].wires[0],
      status: 'qc_boot',
    };
    const afterBoot = makeSnapshot();
    afterBoot.orders[0].wires[0] = {
      ...afterBoot.orders[0].wires[0],
      status: 'validated',
      bootTestDone: true,
      bootTestRequired: false,
      bootTestDoneCount: afterBoot.orders[0].wires[0].bootTestRequiredCount,
    };
    const afterProduction = makeSnapshot();
    afterProduction.orders[0].wires[0] = {
      ...afterProduction.orders[0].wires[0],
      status: 'in_production',
      producedQuantity: 5,
      progressPercent: 5,
    };

    vi.spyOn(api, 'fetchProductionSnapshot').mockResolvedValue(initialSnapshot);
    const validateMock = vi.spyOn(api, 'validateWire').mockResolvedValue(afterValidation);
    const qualityMock = vi.spyOn(api, 'completeQualityTest').mockResolvedValue({
      snapshot: afterBoot,
      result: {
        stage: 'boot',
        result: {
          status: 'OK',
          overallPassed: true,
          verdicts: [],
        },
      },
    });
    const progressMock = vi.spyOn(api, 'recordWireProgress').mockResolvedValue(afterProduction);

    const { ui } = renderWithProviders(<Wires />);
    render(ui);

    expect(await screen.findByText(/Wire production control/i)).toBeInTheDocument();
    const table = await screen.findByRole('table');
    const row = within(table).getByText('A12-RED').closest('tr') as HTMLElement;
    expect(within(row).getByText('12-R')).toBeInTheDocument();

    // Validate wire
    await userEvent.click(within(row).getByRole('button', { name: /validate/i }));
    const validateCall = validateMock.mock.calls[0][0];
    expect(validateCall).toEqual({ workOrderId: 1, refWire: 'A12-RED', marquage: '12-R' });

    // Complete boot test
    await userEvent.click(within(row).getByRole('button', { name: /boot/i }));
    const qualityCall = qualityMock.mock.calls[0][0];
    expect(qualityCall).toEqual({
      wire: { workOrderId: 1, refWire: 'A12-RED', marquage: '12-R' },
      test: 'boot',
      notes: {},
      qualityAgentId: 'QA-TEST',
    });

    // Add production after boot test
    const input = within(row).getByRole('spinbutton') as HTMLInputElement;
    await userEvent.clear(input);
    await userEvent.type(input, '5');
    await userEvent.click(within(row).getByRole('button', { name: /add/i }));
    const progressCall = progressMock.mock.calls[0][0];
    expect(progressCall).toEqual({
      wire: { workOrderId: 1, refWire: 'A12-RED', marquage: '12-R' },
      producedIncrement: 5,
    });
  });
});


