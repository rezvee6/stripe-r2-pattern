export {};

const stripeMock = vi.hoisted(() => ({
  ctor: vi.fn(),
  retrieve: vi.fn(),
  listLineItems: vi.fn(),
}));

vi.mock('stripe', () => ({
  default: class {
    checkout = {
      sessions: {
        retrieve: stripeMock.retrieve,
        listLineItems: stripeMock.listLineItems,
      },
    };
    constructor(...args: unknown[]) {
      stripeMock.ctor(...args);
    }
  },
}));

// lib/stripe.ts caches the client at module level, so load a fresh copy per test.
async function loadModule() {
  vi.resetModules();
  return import('@/lib/stripe');
}

beforeEach(() => {
  vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_123');
  vi.stubEnv('STRIPE_PRICE_ID', 'price_abc');
});

describe('getStripe', () => {
  it('throws a clear error when STRIPE_SECRET_KEY is missing', async () => {
    vi.stubEnv('STRIPE_SECRET_KEY', '');
    const { getStripe } = await loadModule();
    expect(() => getStripe()).toThrow('STRIPE_SECRET_KEY is not set');
  });

  it('creates the client with the key and a pinned API version', async () => {
    const { getStripe } = await loadModule();
    getStripe();
    expect(stripeMock.ctor).toHaveBeenCalledWith('sk_test_123', {
      apiVersion: expect.stringMatching(/^\d{4}-\d{2}-\d{2}\.\w+$/),
    });
  });

  it('returns the same cached client on later calls', async () => {
    const { getStripe } = await loadModule();
    expect(getStripe()).toBe(getStripe());
    expect(stripeMock.ctor).toHaveBeenCalledTimes(1);
  });

  it('does not create a client at import time', async () => {
    await loadModule();
    expect(stripeMock.ctor).not.toHaveBeenCalled();
  });
});

describe('verifyStripeSession', () => {
  const paidSession = { id: 'cs_1', payment_status: 'paid' };

  function lineItem(priceId: string, productId: string) {
    return { data: [{ price: { id: priceId, product: productId } }] };
  }

  it('accepts a paid session whose price matches STRIPE_PRICE_ID', async () => {
    stripeMock.retrieve.mockResolvedValue(paidSession);
    stripeMock.listLineItems.mockResolvedValue(lineItem('price_abc', 'prod_x'));
    const { verifyStripeSession } = await loadModule();

    await expect(verifyStripeSession('cs_1')).resolves.toEqual({
      valid: true,
      session: paidSession,
    });
    expect(stripeMock.retrieve).toHaveBeenCalledWith('cs_1');
    expect(stripeMock.listLineItems).toHaveBeenCalledWith('cs_1', { limit: 1 });
  });

  it('accepts a paid session whose product matches a prod_ STRIPE_PRICE_ID', async () => {
    vi.stubEnv('STRIPE_PRICE_ID', 'prod_x');
    stripeMock.retrieve.mockResolvedValue(paidSession);
    stripeMock.listLineItems.mockResolvedValue(lineItem('price_other', 'prod_x'));
    const { verifyStripeSession } = await loadModule();

    await expect(verifyStripeSession('cs_1')).resolves.toMatchObject({ valid: true });
  });

  it('rejects an unpaid session without listing line items', async () => {
    stripeMock.retrieve.mockResolvedValue({ id: 'cs_1', payment_status: 'unpaid' });
    const { verifyStripeSession } = await loadModule();

    await expect(verifyStripeSession('cs_1')).resolves.toEqual({
      valid: false,
      error: 'Payment not completed',
    });
    expect(stripeMock.listLineItems).not.toHaveBeenCalled();
  });

  it('rejects when STRIPE_PRICE_ID is not configured', async () => {
    vi.stubEnv('STRIPE_PRICE_ID', '');
    stripeMock.retrieve.mockResolvedValue(paidSession);
    const { verifyStripeSession } = await loadModule();

    await expect(verifyStripeSession('cs_1')).resolves.toEqual({
      valid: false,
      error: 'Product configuration missing',
    });
  });

  it('rejects a session with no line items', async () => {
    stripeMock.retrieve.mockResolvedValue(paidSession);
    stripeMock.listLineItems.mockResolvedValue({ data: [] });
    const { verifyStripeSession } = await loadModule();

    await expect(verifyStripeSession('cs_1')).resolves.toEqual({
      valid: false,
      error: 'No line items found in session',
    });
  });

  it('rejects a session paid for a different price', async () => {
    stripeMock.retrieve.mockResolvedValue(paidSession);
    stripeMock.listLineItems.mockResolvedValue(lineItem('price_other', 'prod_x'));
    const { verifyStripeSession } = await loadModule();

    await expect(verifyStripeSession('cs_1')).resolves.toEqual({
      valid: false,
      error: 'Product mismatch',
    });
  });

  it('rejects a session paid for a different product', async () => {
    vi.stubEnv('STRIPE_PRICE_ID', 'prod_x');
    stripeMock.retrieve.mockResolvedValue(paidSession);
    stripeMock.listLineItems.mockResolvedValue(lineItem('price_other', 'prod_other'));
    const { verifyStripeSession } = await loadModule();

    await expect(verifyStripeSession('cs_1')).resolves.toMatchObject({
      valid: false,
      error: 'Product mismatch',
    });
  });

  it('does not treat a price_ ID as a product ID', async () => {
    // A line item whose *product* happens to equal the configured price_ value must not match.
    stripeMock.retrieve.mockResolvedValue(paidSession);
    stripeMock.listLineItems.mockResolvedValue(lineItem('price_other', 'price_abc'));
    const { verifyStripeSession } = await loadModule();

    await expect(verifyStripeSession('cs_1')).resolves.toMatchObject({ valid: false });
  });

  it('returns the Stripe error message when the API call fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    stripeMock.retrieve.mockRejectedValue(new Error('No such checkout.session: cs_bad'));
    const { verifyStripeSession } = await loadModule();

    await expect(verifyStripeSession('cs_bad')).resolves.toEqual({
      valid: false,
      error: 'No such checkout.session: cs_bad',
    });
  });

  it('falls back to a generic message when the error has none', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    stripeMock.retrieve.mockRejectedValue({});
    const { verifyStripeSession } = await loadModule();

    await expect(verifyStripeSession('cs_1')).resolves.toEqual({
      valid: false,
      error: 'Failed to verify session',
    });
  });
});
