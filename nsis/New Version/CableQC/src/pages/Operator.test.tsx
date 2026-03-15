import { render, screen } from '@testing-library/react';

import Operator from './Operator';
import { renderWithProviders } from '@/tests/utils';

describe('Operator page placeholder', () => {
  test('renders an in-development message', () => {
    const { ui } = renderWithProviders(<Operator />);
    render(ui);
    expect(screen.getByText(/operator portal/i)).toBeInTheDocument();
    expect(screen.getByText(/in development/i)).toBeInTheDocument();
  });
});
