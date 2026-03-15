import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi } from 'vitest';

import { AppFlowProvider } from '@/context/AppFlowContext';
import { QualityAgentProvider } from '@/context/QualityAgentContext';
import { PrinterConfigProvider } from '@/context/PrinterConfigContext';
import * as api from '@/lib/api';

export function renderWithProviders(ui: React.ReactElement, options?: { qualityAgentId?: string | null }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  if (!vi.isMockFunction(api.fetchLabelPrinterSettings)) {
    vi.spyOn(api, 'fetchLabelPrinterSettings').mockResolvedValue({
      enabled: false,
      labelFormat: null,
      labelPrinterName: null,
      defaultFormat: 'pdf',
      resolvedFormat: 'pdf',
      tsplSettings: {
        widthMm: 100,
        heightMm: 18,
        gapMm: 2,
        speed: 4,
        density: 8,
        direction: 1,
      },
    });
  }
  if (!vi.isMockFunction(api.saveLabelPrinterSettings)) {
    vi.spyOn(api, 'saveLabelPrinterSettings').mockImplementation(async () => ({
      enabled: false,
      labelFormat: null,
      labelPrinterName: null,
      defaultFormat: 'pdf',
      resolvedFormat: 'pdf',
      tsplSettings: {
        widthMm: 100,
        heightMm: 18,
        gapMm: 2,
        speed: 4,
        density: 8,
        direction: 1,
      },
    }));
  }

  return {
    queryClient,
    ui: (
      <AppFlowProvider>
        <PrinterConfigProvider>
          <QualityAgentProvider defaultAgentId={options?.qualityAgentId ?? 'QA-TEST'}>
            <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>
          </QualityAgentProvider>
        </PrinterConfigProvider>
      </AppFlowProvider>
    ),
  };
}


