import Stripe from 'stripe';
import { jsonRequest } from '../helpers';

// Signature verification is local, so the route gets a real Stripe client and
// we sign payloads exactly as Stripe would.
const stripe = vi.hoisted(() => ({ client: null as unknown as Stripe }));
vi.mock('@/lib/stripe', () => ({ getStripe: () => stripe.client }));

const db = vi.hoisted(() => ({
  insert: vi.fn(),
  upsert: vi.fn(),
  deleteEq: vi.fn(),
}));
vi.mock('@/lib/supabase', () => ({
  getSupabaseAdmin: () => ({
    from: (table: string) => ({
      insert: (row: unknown) => db.insert(table, row),
      upsert: (row: unknown, opts: unknown) => db.upsert(table, row, opts),
      delete: () => ({
        eq: (column: string, value: unknown) => db.deleteEq(table, column, value),
      }),
    }),
  }),
}));

import { POST } from '@/app/api/webhooks/stripe/route';

const SECRET = 'whsec_test_secret';
const CREATED = 1_760_000_000; // 2025-10-09T08:53:20Z

function makeEvent(type: string, object: Record<string, unknown>) {
  return { id: 'evt_1', object: 'event', type, created: CREATED, data: { object } };
}

const paidSession = {
  id: 'cs_1',
  object: 'checkout.session',
  payment_status: 'paid',
  customer_details: { email: 'buyer@example.com' },
  metadata: { product: 'your-product' },
  amount_total: 2900,
  currency: 'usd',
};

function signedRequest(event: unknown, secret = SECRET) {
  const payload = JSON.stringify(event);
  const header = stripe.client.webhooks.generateTestHeaderString({ payload, secret });
  return jsonRequest('/api/webhooks/stripe', payload, { 'stripe-signature': header });
}

beforeAll(() => {
  stripe.client = new Stripe('sk_test_dummy');
});

beforeEach(() => {
  vi.stubEnv('STRIPE_WEBHOOK_SECRET', SECRET);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  db.insert.mockResolvedValue({ error: null });
  db.upsert.mockResolvedValue({ error: null });
  db.deleteEq.mockResolvedValue({ error: null });
});

describe('POST /api/webhooks/stripe', () => {
  describe('request validation', () => {
    it('returns 500 when STRIPE_WEBHOOK_SECRET is not set', async () => {
      vi.stubEnv('STRIPE_WEBHOOK_SECRET', '');

      const res = await POST(signedRequest(makeEvent('checkout.session.completed', paidSession)));

      expect(res.status).toBe(500);
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('returns 400 when the signature header is missing', async () => {
      const res = await POST(jsonRequest('/api/webhooks/stripe', makeEvent('x', {})));

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'No signature' });
    });

    it('returns 400 and touches nothing when signed with the wrong secret', async () => {
      const res = await POST(
        signedRequest(makeEvent('checkout.session.completed', paidSession), 'whsec_wrong')
      );

      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/^Webhook Error:/);
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('returns 400 when the body was tampered with after signing', async () => {
      const original = JSON.stringify(makeEvent('checkout.session.completed', paidSession));
      const header = stripe.client.webhooks.generateTestHeaderString({
        payload: original,
        secret: SECRET,
      });
      const tampered = original.replace('2900', '1');

      const res = await POST(
        jsonRequest('/api/webhooks/stripe', tampered, { 'stripe-signature': header })
      );

      expect(res.status).toBe(400);
    });
  });

  describe('idempotency', () => {
    it('claims the event ID before processing', async () => {
      await POST(signedRequest(makeEvent('checkout.session.completed', paidSession)));

      expect(db.insert).toHaveBeenCalledWith('stripe_events', {
        id: 'evt_1',
        type: 'checkout.session.completed',
      });
      expect(db.insert.mock.invocationCallOrder[0]).toBeLessThan(
        db.upsert.mock.invocationCallOrder[0]
      );
    });

    it('returns 200 and skips processing for an already-handled event', async () => {
      db.insert.mockResolvedValue({ error: { code: '23505', message: 'duplicate key' } });

      const res = await POST(signedRequest(makeEvent('checkout.session.completed', paidSession)));

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ received: true, duplicate: true });
      expect(db.upsert).not.toHaveBeenCalled();
    });

    it('returns 500 so Stripe retries when the claim cannot be written', async () => {
      db.insert.mockResolvedValue({ error: { code: '08006', message: 'connection failure' } });

      const res = await POST(signedRequest(makeEvent('checkout.session.completed', paidSession)));

      expect(res.status).toBe(500);
      expect(db.upsert).not.toHaveBeenCalled();
    });

    it('releases the claim and returns 500 when processing fails, so the retry is not skipped', async () => {
      db.upsert.mockResolvedValue({ error: { code: '08006', message: 'connection failure' } });

      const res = await POST(signedRequest(makeEvent('checkout.session.completed', paidSession)));

      expect(res.status).toBe(500);
      expect(db.deleteEq).toHaveBeenCalledWith('stripe_events', 'id', 'evt_1');
    });
  });

  describe('checkout.session.completed', () => {
    it('records the purchase, keyed on the session ID', async () => {
      const res = await POST(signedRequest(makeEvent('checkout.session.completed', paidSession)));

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ received: true });
      expect(db.upsert).toHaveBeenCalledWith(
        'purchases',
        {
          stripe_session_id: 'cs_1',
          customer_email: 'buyer@example.com',
          product: 'your-product',
          amount_total: 2900,
          currency: 'usd',
          paid_at: new Date(CREATED * 1000).toISOString(),
        },
        { onConflict: 'stripe_session_id', ignoreDuplicates: true }
      );
      expect(db.deleteEq).not.toHaveBeenCalled();
    });

    it('stores nulls and zero when optional session fields are absent', async () => {
      const sparse = {
        id: 'cs_2',
        object: 'checkout.session',
        payment_status: 'paid',
        customer_details: null,
        metadata: null,
        amount_total: null,
        currency: null,
      };

      await POST(signedRequest(makeEvent('checkout.session.completed', sparse)));

      expect(db.upsert).toHaveBeenCalledWith(
        'purchases',
        expect.objectContaining({
          stripe_session_id: 'cs_2',
          customer_email: null,
          product: null,
          amount_total: 0,
          currency: null,
        }),
        expect.anything()
      );
    });

    it('does not record a purchase for a session that is not paid yet', async () => {
      const res = await POST(
        signedRequest(
          makeEvent('checkout.session.completed', { ...paidSession, payment_status: 'unpaid' })
        )
      );

      expect(res.status).toBe(200);
      expect(db.upsert).not.toHaveBeenCalled();
    });
  });

  it('acknowledges unhandled event types without writing a purchase', async () => {
    const res = await POST(signedRequest(makeEvent('customer.created', { id: 'cus_1' })));

    expect(res.status).toBe(200);
    expect(db.insert).toHaveBeenCalledWith('stripe_events', {
      id: 'evt_1',
      type: 'customer.created',
    });
    expect(db.upsert).not.toHaveBeenCalled();
  });
});
