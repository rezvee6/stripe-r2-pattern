import { jsonRequest } from '../helpers';

const stripe = vi.hoisted(() => ({
  checkout: { sessions: { create: vi.fn() } },
  prices: { list: vi.fn() },
}));
const getStripe = vi.hoisted(() => vi.fn());
vi.mock('@/lib/stripe', () => ({ getStripe }));

import { POST } from '@/app/api/checkout/route';

const request = () =>
  jsonRequest('/api/checkout', {}, { origin: 'https://shop.example' });

beforeEach(() => {
  getStripe.mockReturnValue(stripe);
  vi.stubEnv('STRIPE_PRICE_ID', 'price_abc');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  stripe.checkout.sessions.create.mockResolvedValue({
    id: 'cs_123',
    url: 'https://checkout.stripe.com/c/pay/cs_123',
  });
});

describe('POST /api/checkout', () => {
  it('creates a card-only, one-time payment session and returns its URL', async () => {
    const res = await POST(request());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      sessionId: 'cs_123',
      url: 'https://checkout.stripe.com/c/pay/cs_123',
    });
    expect(stripe.prices.list).not.toHaveBeenCalled();
    expect(stripe.checkout.sessions.create).toHaveBeenCalledWith({
      allowed_payment_method_types: ['card'],
      line_items: [{ price: 'price_abc', quantity: 1 }],
      mode: 'payment',
      success_url:
        'https://shop.example/product/your-product/success?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: 'https://shop.example/product/your-product',
      metadata: { product: 'your-product' },
    });
  });

  it('resolves a prod_ ID to its first price', async () => {
    vi.stubEnv('STRIPE_PRICE_ID', 'prod_x');
    stripe.prices.list.mockResolvedValue({ data: [{ id: 'price_from_prod' }] });

    const res = await POST(request());

    expect(res.status).toBe(200);
    expect(stripe.prices.list).toHaveBeenCalledWith({ product: 'prod_x', limit: 1 });
    expect(stripe.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({ line_items: [{ price: 'price_from_prod', quantity: 1 }] })
    );
  });

  it('returns 500 when a prod_ ID has no prices', async () => {
    vi.stubEnv('STRIPE_PRICE_ID', 'prod_x');
    stripe.prices.list.mockResolvedValue({ data: [] });

    const res = await POST(request());

    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/No prices found/);
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it('returns 500 when STRIPE_PRICE_ID is not set', async () => {
    vi.stubEnv('STRIPE_PRICE_ID', '');

    const res = await POST(request());

    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/STRIPE_PRICE_ID/);
  });

  it('returns 500 with the message when the Stripe client cannot be created', async () => {
    getStripe.mockImplementation(() => {
      throw new Error('STRIPE_SECRET_KEY is not set');
    });

    const res = await POST(request());

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'STRIPE_SECRET_KEY is not set' });
  });

  it('returns 500 with the Stripe error message when session creation fails', async () => {
    stripe.checkout.sessions.create.mockRejectedValue(new Error('Invalid price'));

    const res = await POST(request());

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Invalid price' });
  });

  it('falls back to a generic message for errors without one', async () => {
    stripe.checkout.sessions.create.mockRejectedValue({});

    const res = await POST(request());

    expect(await res.json()).toEqual({ error: 'An error occurred' });
  });
});
