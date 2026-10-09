// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

const searchParams = vi.hoisted(() => ({ current: new URLSearchParams() }));
vi.mock('next/navigation', () => ({ useSearchParams: () => searchParams.current }));

import SuccessPage from '@/app/product/your-product/success/page';

const fetchMock = vi.fn();

beforeEach(() => {
  searchParams.current = new URLSearchParams('session_id=cs_123');
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('location', { href: 'http://localhost:3000/product/your-product/success' });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

type Reply = unknown | Error | Promise<never>;

// Route fetch calls by URL: verify-session first, then download.
function api({ verify, download }: { verify: Reply; download?: Reply }) {
  fetchMock.mockImplementation(async (url: string) => {
    const reply = url === '/api/verify-session' ? verify : download;
    if (reply instanceof Promise) return reply;
    if (reply instanceof Error) throw reply;
    return { json: async () => reply };
  });
}

const verified = { success: true, customerEmail: 'buyer@example.com', paymentStatus: 'paid' };
const downloadButton = () => screen.getByRole<HTMLButtonElement>('button');

describe('Success page', () => {
  describe('verification', () => {
    it('shows a loading state while verifying', () => {
      api({ verify: new Promise<never>(() => {}) });
      render(<SuccessPage />);

      expect(screen.getByText('Verifying your purchase…')).toBeTruthy();
    });

    it('verifies the session from the URL and shows the download button', async () => {
      api({ verify: verified });
      render(<SuccessPage />);

      expect(await screen.findByText('Payment successful')).toBeTruthy();
      expect(screen.getByText(/buyer@example\.com/)).toBeTruthy();
      expect(downloadButton().textContent).toBe('Download');
      expect(fetchMock).toHaveBeenCalledWith('/api/verify-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 'cs_123' }),
      });
    });

    it('omits the email line when there is no customer email', async () => {
      api({ verify: { success: true, customerEmail: null } });
      render(<SuccessPage />);

      await screen.findByText('Payment successful');
      expect(screen.queryByText(/confirmation email/)).toBeNull();
    });

    it('shows an error without calling the API when session_id is missing', async () => {
      searchParams.current = new URLSearchParams();
      render(<SuccessPage />);

      expect(await screen.findByText('No session ID found')).toBeTruthy();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('shows the API error when verification is rejected', async () => {
      api({ verify: { error: 'Payment not completed' } });
      render(<SuccessPage />);

      expect(await screen.findByText('Something went wrong')).toBeTruthy();
      expect(screen.getByText('Payment not completed')).toBeTruthy();
      expect(screen.queryByRole('button')).toBeNull();
    });

    it('shows a generic error when the verify request fails', async () => {
      api({ verify: new TypeError('Failed to fetch') });
      render(<SuccessPage />);

      expect(await screen.findByText('Failed to verify payment')).toBeTruthy();
    });

    it('renders nothing for an unexpected response with neither success nor error', async () => {
      api({ verify: {} });
      const { container } = render(<SuccessPage />);

      await waitFor(() => expect(container.textContent).toBe(''));
    });
  });

  describe('download', () => {
    it('requests a signed URL for the session and navigates to it', async () => {
      api({ verify: verified, download: { url: 'https://r2.example/signed' } });
      render(<SuccessPage />);
      await screen.findByText('Payment successful');

      fireEvent.click(downloadButton());

      await waitFor(() => expect(window.location.href).toBe('https://r2.example/signed'));
      expect(fetchMock).toHaveBeenLastCalledWith('/api/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'cs_123' }),
      });
    });

    it('disables the button while generating, then re-enables it after 2s', async () => {
      api({ verify: verified, download: { url: 'https://r2.example/signed' } });
      render(<SuccessPage />);
      await screen.findByText('Payment successful');
      vi.useFakeTimers();

      await act(async () => {
        fireEvent.click(downloadButton());
      });

      expect(downloadButton().disabled).toBe(true);
      expect(downloadButton().textContent).toBe('Generating download…');

      await act(async () => {
        vi.advanceTimersByTime(2000);
      });

      expect(downloadButton().disabled).toBe(false);
      expect(downloadButton().textContent).toBe('Download');
    });

    it('shows the API error and keeps the page usable when the download is refused', async () => {
      api({ verify: verified, download: { error: 'Product mismatch' } });
      render(<SuccessPage />);
      await screen.findByText('Payment successful');

      fireEvent.click(downloadButton());

      expect((await screen.findByRole('alert')).textContent).toBe('Product mismatch');
      expect(screen.getByText('Payment successful')).toBeTruthy();
      expect(downloadButton().disabled).toBe(false);
    });

    it('shows a retry message when the download request fails', async () => {
      api({ verify: verified, download: new TypeError('Failed to fetch') });
      render(<SuccessPage />);
      await screen.findByText('Payment successful');

      fireEvent.click(downloadButton());

      expect((await screen.findByRole('alert')).textContent).toBe(
        'Failed to generate download link. Please try again.'
      );
      expect(downloadButton().disabled).toBe(false);
    });

    it('clears a previous download error on retry', async () => {
      api({ verify: verified, download: { error: 'Too many requests' } });
      render(<SuccessPage />);
      await screen.findByText('Payment successful');
      fireEvent.click(downloadButton());
      await screen.findByRole('alert');

      api({ verify: verified, download: { url: 'https://r2.example/signed' } });
      fireEvent.click(downloadButton());

      await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    });
  });
});
