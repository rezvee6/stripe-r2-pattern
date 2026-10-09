// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BuyButton } from '@/components/BuyButton';

const fetchMock = vi.fn();
const alertMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('alert', alertMock);
  vi.stubGlobal('location', { href: 'http://localhost:3000/product/your-product' });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const respond = (body: unknown) => fetchMock.mockResolvedValue({ json: async () => body });
const button = () => screen.getByRole<HTMLButtonElement>('button');

describe('BuyButton', () => {
  it('POSTs to /api/checkout and redirects to the Stripe Checkout URL', async () => {
    respond({ url: 'https://checkout.stripe.com/c/pay/cs_123' });
    render(<BuyButton />);

    fireEvent.click(button());

    await waitFor(() =>
      expect(window.location.href).toBe('https://checkout.stripe.com/c/pay/cs_123')
    );
    expect(fetchMock).toHaveBeenCalledWith('/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
  });

  it('disables itself while the request is in flight', async () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    render(<BuyButton />);

    fireEvent.click(button());

    expect(button().disabled).toBe(true);
    expect(button().textContent).toBe('Processing…');
  });

  it('alerts and re-enables when the API returns an error', async () => {
    respond({ error: 'No prices found' });
    render(<BuyButton />);

    fireEvent.click(button());

    await waitFor(() => expect(alertMock).toHaveBeenCalled());
    expect(button().disabled).toBe(false);
    expect(button().textContent).toBe('Buy now');
    expect(window.location.href).toBe('http://localhost:3000/product/your-product');
  });

  it('alerts and re-enables when the request fails', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    render(<BuyButton />);

    fireEvent.click(button());

    await waitFor(() => expect(alertMock).toHaveBeenCalled());
    expect(button().disabled).toBe(false);
  });
});
