export {};

// Presigning is computed locally, so this uses the real AWS SDK with no network access.
async function loadModule() {
  vi.resetModules();
  return import('@/lib/r2');
}

beforeEach(() => {
  vi.stubEnv('R2_ACCOUNT_ID', 'acct123');
  vi.stubEnv('R2_ACCESS_KEY_ID', 'AKIDTEST');
  vi.stubEnv('R2_SECRET_ACCESS_KEY', 'secret');
  vi.stubEnv('R2_BUCKET_NAME', 'my-bucket');
});

describe('getSignedDownloadUrl', () => {
  it('signs a GET for the object on the account R2 endpoint', async () => {
    const { getSignedDownloadUrl } = await loadModule();
    const url = new URL(await getSignedDownloadUrl('product-v1.zip', 900));

    expect(url.protocol).toBe('https:');
    expect(url.hostname).toMatch(/acct123\.r2\.cloudflarestorage\.com$/);
    expect(`${url.hostname}${url.pathname}`).toContain('my-bucket');
    expect(url.pathname).toMatch(/\/product-v1\.zip$/);
    expect(url.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(url.searchParams.get('X-Amz-Credential')).toMatch(/^AKIDTEST\//);
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('defaults to a one-hour expiry', async () => {
    const { getSignedDownloadUrl } = await loadModule();
    const url = new URL(await getSignedDownloadUrl('product-v1.zip'));
    expect(url.searchParams.get('X-Amz-Expires')).toBe('3600');
  });

  it('never puts the secret key in the URL', async () => {
    const { getSignedDownloadUrl } = await loadModule();
    expect(await getSignedDownloadUrl('product-v1.zip')).not.toContain('secret');
  });
});
