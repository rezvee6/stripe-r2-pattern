import { jsonRequest } from '../helpers';

const retrieve = vi.hoisted(() => vi.fn());
vi.mock('@/lib/stripe', () => ({
  getStripe: () => ({ checkout: { sessions: { retrieve } } }),
}));

import { POST } from '@/app/api/verify-session/route';

const request = (body: unknown) => jsonRequest('/api/verify-session', body);

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('POST /api/verify-session', () => {
  it('returns the customer email for a paid session', async () => {
    retrieve.mockResolvedValue({
      payment_status: 'paid',
      customer_details: { email: 'buyer@example.com' },
    });

    const res = await POST(request({ sessionId: 'cs_1' }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      customerEmail: 'buyer@example.com',
      paymentStatus: 'paid',
    });
    expect(retrieve).toHaveBeenCalledWith('cs_1');
  });

  it('omits the email when Stripe has no customer details', async () => {
    retrieve.mockResolvedValue({ payment_status: 'paid', customer_details: null });

    const res = await POST(request({ sessionId: 'cs_1' }));

    expect(await res.json()).toEqual({ success: true, paymentStatus: 'paid' });
  });

  it('returns 400 when sessionId is missing', async () => {
    const res = await POST(request({}));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Session ID is required' });
    expect(retrieve).not.toHaveBeenCalled();
  });

  it('returns 404 when Stripe returns no session', async () => {
    retrieve.mockResolvedValue(null);

    const res = await POST(request({ sessionId: 'cs_1' }));

    expect(res.status).toBe(404);
  });

  it('returns 400 for an unpaid session', async () => {
    retrieve.mockResolvedValue({ payment_status: 'unpaid' });

    const res = await POST(request({ sessionId: 'cs_1' }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Payment not completed' });
  });

  it('returns 500 with the Stripe error message when retrieval fails', async () => {
    retrieve.mockRejectedValue(new Error('No such checkout.session'));

    const res = await POST(request({ sessionId: 'cs_bad' }));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'No such checkout.session' });
  });

  it('returns 500 with a generic message for malformed JSON', async () => {
    const res = await POST(jsonRequest('/api/verify-session', '{not json'));

    expect(res.status).toBe(500);
    expect((await res.json()).error).toBeTruthy();
  });

  it('falls back to a generic message for errors without one', async () => {
    retrieve.mockRejectedValue({});

    const res = await POST(request({ sessionId: 'cs_1' }));

    expect(await res.json()).toEqual({ error: 'An error occurred' });
  });
});
