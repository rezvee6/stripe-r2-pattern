export {};

const createClient = vi.hoisted(() => vi.fn(() => ({ from: vi.fn() })));
vi.mock('@supabase/supabase-js', () => ({ createClient }));

async function loadModule() {
  vi.resetModules();
  return import('@/lib/supabase');
}

beforeEach(() => {
  vi.stubEnv('SUPABASE_URL', 'https://proj.supabase.co');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role');
});

describe('getSupabaseAdmin', () => {
  it.each(['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'])(
    'throws when %s is missing',
    async (name) => {
      vi.stubEnv(name, '');
      const { getSupabaseAdmin } = await loadModule();
      expect(() => getSupabaseAdmin()).toThrow(
        'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set'
      );
    }
  );

  it('creates a session-less client with the service-role key', async () => {
    const { getSupabaseAdmin } = await loadModule();
    getSupabaseAdmin();
    expect(createClient).toHaveBeenCalledWith('https://proj.supabase.co', 'service-role', {
      auth: { persistSession: false },
    });
  });

  it('returns the same cached client on later calls', async () => {
    const { getSupabaseAdmin } = await loadModule();
    expect(getSupabaseAdmin()).toBe(getSupabaseAdmin());
    expect(createClient).toHaveBeenCalledTimes(1);
  });
});
