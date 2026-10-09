import { jsonRequest } from '../helpers';

const verifyStripeSession = vi.hoisted(() => vi.fn());
const getSignedDownloadUrl = vi.hoisted(() => vi.fn());
vi.mock('@/lib/stripe', () => ({ verifyStripeSession }));
vi.mock('@/lib/r2', () => ({ getSignedDownloadUrl }));

import { POST } from '@/app/api/download/route';

const request = (body: unknown) => jsonRequest('/api/download', body);

beforeEach(() => {
  vi.stubEnv('R2_OBJECT_KEY', 'product-v1.zip');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  verifyStripeSession.mockResolvedValue({ valid: true, session: { id: 'cs_1' } });
  getSignedDownloadUrl.mockResolvedValue('https://signed.example/product-v1.zip');
});

describe('POST /api/download', () => {
  it('returns a 15-minute signed URL for a verified session', async () => {
    const res = await POST(request({ session_id: 'cs_1' }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: 'https://signed.example/product-v1.zip' });
    expect(verifyStripeSession).toHaveBeenCalledWith('cs_1');
    expect(getSignedDownloadUrl).toHaveBeenCalledWith('product-v1.zip', 900);
  });

  it.each([
    ['missing', {}],
    ['empty', { session_id: '' }],
    ['not a string', { session_id: 123 }],
  ])('returns 400 when session_id is %s', async (_label, body) => {
    const res = await POST(request(body));

    expect(res.status).toBe(400);
    expect(verifyStripeSession).not.toHaveBeenCalled();
  });

  it('returns 403 with the verification error and signs nothing', async () => {
    verifyStripeSession.mockResolvedValue({ valid: false, error: 'Product mismatch' });

    const res = await POST(request({ session_id: 'cs_1' }));

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Product mismatch' });
    expect(getSignedDownloadUrl).not.toHaveBeenCalled();
  });

  it('returns 403 with a default message when verification gives no reason', async () => {
    verifyStripeSession.mockResolvedValue({ valid: false });

    const res = await POST(request({ session_id: 'cs_1' }));

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Invalid or unpaid session' });
  });

  it('returns 403 when verification says valid but has no session', async () => {
    verifyStripeSession.mockResolvedValue({ valid: true });

    const res = await POST(request({ session_id: 'cs_1' }));

    expect(res.status).toBe(403);
    expect(getSignedDownloadUrl).not.toHaveBeenCalled();
  });

  it('returns 500 without leaking config details when R2_OBJECT_KEY is not set', async () => {
    vi.stubEnv('R2_OBJECT_KEY', '');

    const res = await POST(request({ session_id: 'cs_1' }));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Download configuration error' });
  });

  it('returns a generic 500 when signing fails', async () => {
    getSignedDownloadUrl.mockRejectedValue(new Error('R2 credentials invalid'));

    const res = await POST(request({ session_id: 'cs_1' }));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to generate download URL' });
  });
});
