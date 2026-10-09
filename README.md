# Stripe + Cloudflare R2 — Digital Product Checkout Pattern

A drop-in reference for selling a single digital product (LUTs, PDF, zip, etc.) on a Next.js (App Router) site, using **Stripe Checkout** for payment and **Cloudflare R2** for private, signed-URL file delivery.

This markdown file is intentionally self-sufficient — every code block, env var, and dashboard step you need is in here. Drop it next to a fresh Next.js project, follow it top-to-bottom, and end up with a working checkout + download flow.

---

## Table of contents

1. [What this gets you](#what-this-gets-you)
2. [Tradeoffs vs alternatives](#tradeoffs-vs-alternatives)
3. [The flow](#the-flow)
4. [Required services](#required-services)
5. [Dependencies](#dependencies)
6. [Environment variables](#environment-variables)
7. [Source code — seven files](#source-code)
8. [Client wiring (Buy button + Success page)](#client-wiring)
9. [Stripe dashboard setup](#stripe-dashboard-setup)
10. [Cloudflare R2 setup](#cloudflare-r2-setup)
11. [Database setup](#database-setup)
12. [Testing checklist](#testing-checklist)
13. [Common pitfalls](#common-pitfalls)
14. [Improvements — priority-ranked](#improvements)

---

## What this gets you

- A Buy button → Stripe-hosted checkout → success page → "Download" button → 15-minute signed URL to the file in R2.
- Receipt + payment handled by Stripe (no PCI compliance burden, no card data ever touches your server).
- Files never live in your public folder — only ever signed-URL-served to verified buyers.

## Tradeoffs vs alternatives

- **Stripe Payment Links** (no code): cheaper to set up but you can't gate the download server-side. Buyers see a generic "Payment complete" page from Stripe, not your own.
- **Gumroad / Lemon Squeezy / Stan.store**: full hosted storefront. Faster to launch, but you pay 8–15% of revenue and have no control over post-purchase UX. Good for a first product; this pattern wins past ~$1k/month.
- **This pattern**: ~2 hours to set up, 0% additional fees (just Stripe's standard rate), full control over post-purchase UX.

## The flow

```
USER                  YOUR APP                     STRIPE                R2
  |                      |                            |                   |
  | click Buy            |                            |                   |
  |--------------------->| POST /api/checkout         |                   |
  |                      |--------------------------->| create session    |
  |                      |<---------------------------|                   |
  |<---------------------| redirect to checkout URL   |                   |
  |                                                                       |
  | enter card, pay                                  |                   |
  |------------------------------------------------->|                   |
  |                                                                       |
  | redirect to /success?session_id=cs_xxx           |                   |
  |--------------------->|                            |                   |
  |                      | POST /api/verify-session   |                   |
  |                      |--------------------------->| retrieve session  |
  |                      |<---------------------------| payment_status=ok |
  |                                                                       |
  | click Download       |                            |                   |
  |--------------------->| POST /api/download         |                   |
  |                      |--------------------------->| re-verify         |
  |                      |<---------------------------|                   |
  |                      |--------------------------------------------->| presign GET URL
  |                      |<---------------------------------------------|
  |<---------------------| { url: signed R2 url }     |                   |
  |--------------------------------------------------------------------->| download
```

In parallel, Stripe POSTs to `/api/webhooks/stripe` on `checkout.session.completed`. The webhook dedupes the event by ID and records the purchase in a `purchases` table. Sending a post-purchase email is still on you (see [Improvements P2.3](#improvements)).

## Required services

1. **Stripe account** with a product + price created
2. **Cloudflare R2 bucket** with the file uploaded and an API token
3. **Supabase project** (or any Postgres; the snippets use `@supabase/supabase-js`) for webhook dedupe + purchase records

## Dependencies

```bash
npm install stripe@23 @aws-sdk/client-s3 @aws-sdk/s3-request-presigner @supabase/supabase-js
```

(`@stripe/stripe-js` is only needed if you do client-side Stripe.js things — not required for the redirect-to-Checkout flow.)

## Environment variables

Add to `.env.local`:

```
STRIPE_SECRET_KEY=sk_test_...           # from Stripe dashboard
STRIPE_PRICE_ID=price_...               # or prod_... — both work
STRIPE_WEBHOOK_SECRET=whsec_...         # from Stripe webhook config

R2_ACCOUNT_ID=...                       # Cloudflare account ID
R2_ACCESS_KEY_ID=...                    # Cloudflare R2 API token
R2_SECRET_ACCESS_KEY=...                # paired secret
R2_BUCKET_NAME=my-bucket
R2_OBJECT_KEY=my-product-v1.zip         # path of the file inside the bucket

SUPABASE_URL=https://xxxx.supabase.co   # Supabase → Project Settings → API
SUPABASE_SERVICE_ROLE_KEY=...           # server-only — never expose with a NEXT_PUBLIC_ prefix
```

---

## Source code

Seven files. Each block below is preceded by a `> Create at:` marker telling you where to put it.

### `lib/stripe.ts`

> Create at: `lib/stripe.ts`

A single lazily-created Stripe client (`getStripe()`) shared by every route, plus a helper that re-verifies that a session was paid AND that it was paid for the expected product.

Creating the client lazily means a missing `STRIPE_SECRET_KEY` fails with a clear error the first time a request needs Stripe, not as a vague crash when the module loads. The API version is pinned so upgrading the SDK can't silently change response shapes. Use the version your installed SDK is typed for. The `apiVersion` field's TypeScript type only accepts that one value, so a mismatch shows up as a type error.

```ts
import Stripe from 'stripe';

let cached: Stripe | null = null;

export function getStripe(): Stripe {
  if (cached) return cached;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error('STRIPE_SECRET_KEY is not set');
  }
  cached = new Stripe(key, {
    apiVersion: '2026-09-30.endive', // pin to avoid surprise breaking changes on SDK upgrade
  });
  return cached;
}

/**
 * Verify a Stripe checkout session and ensure payment is completed
 * @param sessionId - The Stripe checkout session ID
 * @returns Session object if valid and paid, null otherwise
 */
export async function verifyStripeSession(sessionId: string): Promise<{
  valid: boolean;
  session?: Stripe.Checkout.Session;
  error?: string;
}> {
  try {
    const stripe = getStripe();
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    // Verify payment status
    if (session.payment_status !== 'paid') {
      return {
        valid: false,
        error: 'Payment not completed',
      };
    }

    // Verify product/price matches
    const expectedProductOrPriceId = process.env.STRIPE_PRICE_ID;
    if (!expectedProductOrPriceId) {
      return {
        valid: false,
        error: 'Product configuration missing',
      };
    }

    // Check if session line items match expected product/price
    const lineItems = await stripe.checkout.sessions.listLineItems(sessionId, {
      limit: 1,
    });

    if (lineItems.data.length === 0) {
      return {
        valid: false,
        error: 'No line items found in session',
      };
    }

    const lineItem = lineItems.data[0];
    const priceId = lineItem.price?.id;
    const productId = lineItem.price?.product;

    // Verify against expected product/price ID
    const isPriceMatch = priceId === expectedProductOrPriceId;
    const isProductMatch = expectedProductOrPriceId.startsWith('prod_') &&
      productId === expectedProductOrPriceId;

    if (!isPriceMatch && !isProductMatch) {
      return {
        valid: false,
        error: 'Product mismatch',
      };
    }

    return {
      valid: true,
      session,
    };
  } catch (error: any) {
    console.error('Stripe verification error:', error);
    return {
      valid: false,
      error: error.message || 'Failed to verify session',
    };
  }
}
```

### `lib/r2.ts`

> Create at: `lib/r2.ts`

R2 client (S3-compatible) + a helper that mints a time-limited GET URL.

```ts
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// Initialize R2 client (S3-compatible)
const r2Client = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  },
});

/**
 * Generate a signed URL for a private R2 object
 * @param objectKey - The key/path of the object in R2
 * @param expiresIn - Expiration time in seconds (default: 3600 = 1 hour)
 * @returns Signed URL string
 */
export async function getSignedDownloadUrl(
  objectKey: string,
  expiresIn: number = 3600
): Promise<string> {
  const bucketName = process.env.R2_BUCKET_NAME!;

  const command = new GetObjectCommand({
    Bucket: bucketName,
    Key: objectKey,
  });

  const signedUrl = await getSignedUrl(r2Client, command, { expiresIn });

  return signedUrl;
}
```

### `lib/supabase.ts`

> Create at: `lib/supabase.ts`

A server-only Supabase client using the service-role key, used by the webhook. It bypasses row-level security, so import it only from route handlers and never from client components.

```ts
import { createClient, SupabaseClient } from '@supabase/supabase-js';

let cached: SupabaseClient | null = null;

export function getSupabaseAdmin(): SupabaseClient {
  if (cached) return cached;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
  }
  cached = createClient(url, key, { auth: { persistSession: false } });
  return cached;
}
```

### `app/api/checkout/route.ts`

> Create at: `app/api/checkout/route.ts`

Creates a Stripe Checkout Session and returns the URL. Replace `/product/your-product` with your actual frontend route.

```ts
import { NextRequest, NextResponse } from 'next/server';
import { getStripe } from '@/lib/stripe';

export async function POST(request: NextRequest) {
  try {
    const stripe = getStripe();

    // Get product/price ID from environment variable
    const productOrPriceId = process.env.STRIPE_PRICE_ID;

    if (!productOrPriceId) {
      return NextResponse.json(
        { error: 'Stripe Price/Product ID is not configured. Please set STRIPE_PRICE_ID in your environment variables.' },
        { status: 500 }
      );
    }

    let priceId = productOrPriceId;

    // If it's a product ID (starts with prod_), fetch the first price
    if (productOrPriceId.startsWith('prod_')) {
      const prices = await stripe.prices.list({
        product: productOrPriceId,
        limit: 1,
      });

      if (prices.data.length === 0) {
        return NextResponse.json(
          { error: 'No prices found for this product. Please create a price in your Stripe dashboard.' },
          { status: 500 }
        );
      }

      priceId = prices.data[0].id;
    }

    const session = await stripe.checkout.sessions.create({
      allowed_payment_method_types: ['card'],
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      mode: 'payment',
      success_url: `${request.headers.get('origin')}/product/your-product/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${request.headers.get('origin')}/product/your-product`,
      metadata: {
        product: 'your-product',
      },
    });

    return NextResponse.json({ sessionId: session.id, url: session.url });
  } catch (error: any) {
    console.error('Stripe checkout error:', error);
    return NextResponse.json(
      { error: error.message || 'An error occurred' },
      { status: 500 }
    );
  }
}
```

### `app/api/verify-session/route.ts`

> Create at: `app/api/verify-session/route.ts`

Read-only confirmation — used by the success page on first load to display "Payment successful" + the customer email.

```ts
import { NextRequest, NextResponse } from 'next/server';
import { getStripe } from '@/lib/stripe';

export async function POST(request: NextRequest) {
  try {
    const stripe = getStripe();
    const { sessionId } = await request.json();

    if (!sessionId) {
      return NextResponse.json(
        { error: 'Session ID is required' },
        { status: 400 }
      );
    }

    // Retrieve the checkout session
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (!session) {
      return NextResponse.json(
        { error: 'Session not found' },
        { status: 404 }
      );
    }

    // Check if payment was successful
    if (session.payment_status !== 'paid') {
      return NextResponse.json(
        { error: 'Payment not completed' },
        { status: 400 }
      );
    }

    return NextResponse.json({
      success: true,
      customerEmail: session.customer_details?.email,
      paymentStatus: session.payment_status,
    });
  } catch (error: any) {
    console.error('Session verification error:', error);
    return NextResponse.json(
      { error: error.message || 'An error occurred' },
      { status: 500 }
    );
  }
}
```

### `app/api/download/route.ts`

> Create at: `app/api/download/route.ts`

Gated by `verifyStripeSession`. Returns a signed R2 URL that expires in 15 minutes.

```ts
import { NextRequest, NextResponse } from 'next/server';
import { verifyStripeSession } from '@/lib/stripe';
import { getSignedDownloadUrl } from '@/lib/r2';

/**
 * API Route: Generate signed R2 download URL
 *
 * Security:
 * - Verifies Stripe session is paid
 * - Verifies product/price matches
 * - Only generates signed URL if payment is valid
 * - Signed URL expires in 15 minutes
 *
 * Rate limiting: Consider adding rate limiting in production
 * (e.g., max 10 requests per session_id per hour)
 */
export async function POST(request: NextRequest) {
  try {
    const { session_id } = await request.json();

    // Validate session_id
    if (!session_id || typeof session_id !== 'string') {
      return NextResponse.json(
        { error: 'Session ID is required' },
        { status: 400 }
      );
    }

    // Verify Stripe payment
    const verification = await verifyStripeSession(session_id);

    if (!verification.valid || !verification.session) {
      return NextResponse.json(
        { error: verification.error || 'Invalid or unpaid session' },
        { status: 403 }
      );
    }

    // Get R2 object key from environment
    const objectKey = process.env.R2_OBJECT_KEY;

    if (!objectKey) {
      console.error('R2_OBJECT_KEY not configured');
      return NextResponse.json(
        { error: 'Download configuration error' },
        { status: 500 }
      );
    }

    // Generate signed URL (expires in 15 minutes = 900 seconds)
    const signedUrl = await getSignedDownloadUrl(objectKey, 900);

    // Return minimal information
    return NextResponse.json({
      url: signedUrl,
    });
  } catch (error: any) {
    console.error('Download URL generation error:', error);
    return NextResponse.json(
      { error: 'Failed to generate download URL' },
      { status: 500 }
    );
  }
}
```

### `app/api/webhooks/stripe/route.ts`

> Create at: `app/api/webhooks/stripe/route.ts`

Verifies the Stripe signature, dedupes by `event.id`, then records the purchase. Stripe can deliver the same event more than once and retries on any non-2xx response, so the handler is idempotent at two levels:

- **Event claim.** The handler inserts `event.id` into `stripe_events` before doing any work. A primary-key conflict (`23505`) means the event was already handled, so it returns 200 and Stripe stops retrying. If processing then fails, the claim is released so Stripe's retry runs the work again and isn't skipped as a duplicate.
- **Purchase upsert.** `purchases.stripe_session_id` is unique, so a purchase can't be written twice, even if two deliveries race past the claim.

Needs the tables from [Database setup](#database-setup).

```ts
import { NextRequest, NextResponse } from 'next/server';
import Stripe from 'stripe';
import { getStripe } from '@/lib/stripe';
import { getSupabaseAdmin } from '@/lib/supabase';

export async function POST(request: NextRequest) {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error('STRIPE_WEBHOOK_SECRET is not set');
    return NextResponse.json(
      { error: 'Webhook not configured' },
      { status: 500 }
    );
  }

  const body = await request.text();
  const signature = request.headers.get('stripe-signature');

  if (!signature) {
    return NextResponse.json(
      { error: 'No signature' },
      { status: 400 }
    );
  }

  let event: Stripe.Event;

  try {
    event = getStripe().webhooks.constructEvent(body, signature, webhookSecret);
  } catch (err: any) {
    console.error('Webhook signature verification failed:', err.message);
    return NextResponse.json(
      { error: `Webhook Error: ${err.message}` },
      { status: 400 }
    );
  }

  const supabase = getSupabaseAdmin();

  // Claim the event. A duplicate key means we've already handled it.
  const { error: claimError } = await supabase
    .from('stripe_events')
    .insert({ id: event.id, type: event.type });

  if (claimError) {
    if (claimError.code === '23505') {
      return NextResponse.json({ received: true, duplicate: true });
    }
    console.error('Failed to record webhook event:', claimError);
    return NextResponse.json(
      { error: 'Database error' },
      { status: 500 }
    );
  }

  try {
    await handleEvent(event);
  } catch (err) {
    console.error(`Failed to process ${event.type} ${event.id}:`, err);
    // Release the claim so Stripe's retry is processed instead of skipped as a duplicate.
    await supabase.from('stripe_events').delete().eq('id', event.id);
    return NextResponse.json(
      { error: 'Processing failed' },
      { status: 500 }
    );
  }

  return NextResponse.json({ received: true });
}

async function handleEvent(event: Stripe.Event) {
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;

      // With delayed payment methods (bank debits etc.), `completed` fires before
      // the money settles. This pattern is card-only, but guard anyway.
      if (session.payment_status !== 'paid') {
        console.log(`Session ${session.id} completed but not paid yet`);
        return;
      }

      const { error } = await getSupabaseAdmin()
        .from('purchases')
        .upsert(
          {
            stripe_session_id: session.id,
            customer_email: session.customer_details?.email ?? null,
            product: session.metadata?.product ?? null,
            amount_total: session.amount_total ?? 0,
            currency: session.currency ?? null,
            paid_at: new Date(event.created * 1000).toISOString(),
          },
          { onConflict: 'stripe_session_id', ignoreDuplicates: true }
        );

      if (error) throw error;

      // Next: send the post-purchase email here (Improvements P2.3).
      break;
    }

    default:
      console.log(`Unhandled event type ${event.type}`);
  }
}
```

---

## Client wiring

### Buy button

> Create at: `components/BuyButton.tsx`

Render `<BuyButton />` on your product page (it must be a client component because of the `onClick`):

```tsx
'use client';

import { useState } from 'react';

export function BuyButton() {
  const [loading, setLoading] = useState(false);

  const handleCheckout = async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      const data = await response.json();

      if (data.error) {
        console.error('Checkout error:', data.error);
        alert('An error occurred. Please try again.');
        setLoading(false);
        return;
      }

      // Redirect to Stripe Checkout
      if (data.url) {
        window.location.href = data.url;
      }
    } catch (error) {
      console.error('Checkout error:', error);
      alert('An error occurred. Please try again.');
      setLoading(false);
    }
  };

  return (
    <button onClick={handleCheckout} disabled={loading}>
      {loading ? 'Processing…' : 'Buy now'}
    </button>
  );
}
```

### Success page

> Create at: `app/product/your-product/success/page.tsx`

The two-step UX (verify on mount → Download on click) keeps the signed URL fresh: if the buyer leaves the tab open for hours, the URL won't expire until they actually press Download.

```tsx
'use client';

import { useEffect, useState, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';

function SuccessPageContent() {
  const searchParams = useSearchParams();
  const sessionId = searchParams.get('session_id');
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [verified, setVerified] = useState(false);
  const [customerEmail, setCustomerEmail] = useState<string | null>(null);

  useEffect(() => {
    const verifySession = async () => {
      if (!sessionId) {
        setError('No session ID found');
        setLoading(false);
        return;
      }

      try {
        const response = await fetch('/api/verify-session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId }),
        });

        const data = await response.json();

        if (data.error) {
          setError(data.error);
          setLoading(false);
          return;
        }

        if (data.success) {
          setVerified(true);
          setCustomerEmail(data.customerEmail);
        }
      } catch (error) {
        console.error('Verification error:', error);
        setError('Failed to verify payment');
      } finally {
        setLoading(false);
      }
    };

    verifySession();
  }, [sessionId]);

  const handleDownload = async () => {
    if (!sessionId) {
      setError('No session ID available');
      return;
    }

    setDownloading(true);
    setError(null);

    try {
      const response = await fetch('/api/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId }),
      });

      const data = await response.json();

      if (data.error) {
        setError(data.error);
        setDownloading(false);
        return;
      }

      if (data.url) {
        // Redirect browser to signed URL to start download
        window.location.href = data.url;
        setTimeout(() => setDownloading(false), 2000);
      }
    } catch (error) {
      console.error('Download error:', error);
      setError('Failed to generate download link. Please try again.');
      setDownloading(false);
    }
  };

  if (loading) return <div>Verifying your purchase…</div>;

  if (error && !verified) {
    return (
      <div>
        <h1>Something went wrong</h1>
        <p>{error}</p>
      </div>
    );
  }

  if (!verified) return null;

  return (
    <div>
      <h1>Payment successful</h1>
      {customerEmail && <p>A confirmation email has been sent to {customerEmail}</p>}
      <button onClick={handleDownload} disabled={downloading}>
        {downloading ? 'Generating download…' : 'Download'}
      </button>
      {error && <p role="alert">{error}</p>}
      <p>Download link expires in 15 minutes.</p>
    </div>
  );
}

export default function SuccessPage() {
  return (
    <Suspense fallback={<div>Loading…</div>}>
      <SuccessPageContent />
    </Suspense>
  );
}
```

---

## Stripe dashboard setup

1. Sign in to <https://dashboard.stripe.com>.
2. **Product catalog → Add product.** Create your product with a one-time price. Copy the price ID (`price_xxx`) into `STRIPE_PRICE_ID`.
3. **Developers → API keys.** Copy the **Secret key** (`sk_test_...` in test mode) into `STRIPE_SECRET_KEY`.
4. **Developers → Webhooks → Add endpoint:**
   - URL: `https://yourdomain.com/api/webhooks/stripe`
   - Events: `checkout.session.completed`
   - Copy the **Signing secret** (`whsec_...`) into `STRIPE_WEBHOOK_SECRET`.

## Cloudflare R2 setup

1. Sign in to <https://dash.cloudflare.com> → R2.
2. **Create bucket.** Note the bucket name → `R2_BUCKET_NAME`.
3. Upload your product file. Note the object key (filename inside the bucket) → `R2_OBJECT_KEY`.
4. **Manage R2 API tokens → Create API token:**
   - Permission: **Object Read** (scoped to your bucket only, not "all buckets")
   - Copy **Access Key ID** → `R2_ACCESS_KEY_ID`
   - Copy **Secret Access Key** → `R2_SECRET_ACCESS_KEY`
5. Find your **Cloudflare Account ID** in the right sidebar of the R2 dashboard → `R2_ACCOUNT_ID`.

## Database setup

1. Create a project at <https://supabase.com/dashboard>.
2. **Project Settings → API.** Copy the **Project URL** → `SUPABASE_URL` and the **service_role** key → `SUPABASE_SERVICE_ROLE_KEY`.
3. **SQL Editor:** run this migration:

```sql
-- One row per Stripe event we've handled (webhook dedupe).
create table stripe_events (
  id text primary key,
  type text not null,
  processed_at timestamptz not null default now()
);

-- One row per paid checkout session.
create table purchases (
  id bigint generated always as identity primary key,
  stripe_session_id text not null unique,
  customer_email text,
  product text,
  amount_total bigint not null,   -- smallest currency unit (e.g. cents)
  currency text,
  paid_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index purchases_customer_email_idx on purchases (customer_email);

-- RLS on with no policies: only the server-side service-role key can read/write.
alter table stripe_events enable row level security;
alter table purchases enable row level security;
```

---

## Testing checklist

Always start in Stripe's test mode (`sk_test_...`).

1. In a second terminal, listen for webhooks locally:
   ```bash
   stripe login
   stripe listen --forward-to localhost:3000/api/webhooks/stripe
   ```
   The CLI prints a temporary signing secret — use that in your local `.env.local` instead of the dashboard one.
2. Run the buy flow:
   - Click Buy → Stripe Checkout opens
   - Test card: `4242 4242 4242 4242`, any future expiry, any CVC, any postal code
   - Submit → redirected to the success page
3. Confirm the success page shows "Payment successful" + customer email.
4. Click **Download** → file downloads from R2.
5. The webhook terminal should show `checkout.session.completed` arriving with a `200`. Check that Supabase has one new row in `purchases` and one in `stripe_events`.
6. Test idempotency: resend the same event with `stripe events resend evt_xxx` (copy the ID from the `stripe listen` output). The response should be `{"received":true,"duplicate":true}` and `purchases` should still have one row.
7. Refresh the success page — Download button should still work (within 15-min URL TTL).
8. Switch to live mode by changing the env-var prefixes (`sk_live_...`) and updating the webhook endpoint URL in the Stripe dashboard to your production domain.

---

## Common pitfalls

- **Webhook URL must match exactly.** If the dashboard says `/api/webhooks/stripe` but your route is `/api/webhook/stripe`, Stripe gets a 404 on every event and the signing secret never validates anything.
- **`{CHECKOUT_SESSION_ID}` is a literal placeholder.** Don't replace it in code — Stripe expands it when redirecting.
- **R2 endpoint is `<account>.r2.cloudflarestorage.com`** — not `<bucket>.<account>.r2…`. The bucket goes in the path / SDK config, not the hostname.
- **Webhook signing secret is per-endpoint.** Changing the webhook URL gives you a new secret. Update both.
- **R2 API tokens are scoped at creation.** If you can't read objects with your token, check it has Object Read for your specific bucket.
- **Stripe SDK version ≠ API version.** Without an explicit `apiVersion`, the SDK uses whatever its current default is — which can change between `npm install`s. `getStripe()` in `lib/stripe.ts` pins it. When you upgrade the SDK, update the pin deliberately.
- **Never ship the service-role key to the browser.** It bypasses RLS. Keep it out of `NEXT_PUBLIC_*` vars and only import `lib/supabase.ts` from server code.
- **`success_url` MUST be HTTPS in live mode.** HTTP is allowed in test mode only.

---

## Improvements

Prioritised so you know what to fix BEFORE reusing this pattern on the next product, vs nice-to-haves you can iterate to.

Each P1 item includes a replacement snippet you can paste in.

### P0 — done (now part of the source above)

- **P0.1 — Shared, lazily-created Stripe client with a pinned API version.** See `getStripe()` in [`lib/stripe.ts`](#libstripets).
- **P0.2 — Webhook idempotency.** The webhook claims `event.id` in `stripe_events` and releases the claim if processing fails, so retries aren't lost.
- **P0.3 — Persist purchases.** `checkout.session.completed` upserts into `purchases`, keyed on the unique `stripe_session_id`.

A possible next step: `/api/download` still re-checks every download with the Stripe API (200–500 ms each). It could look up `purchases` first and only fall back to Stripe if the webhook hasn't arrived yet.

### P1 — multi-product readiness

**P1.1 — Slugify the download route.**

`/api/download/route.ts` is hard-coded to one product (via env var). For multi-product:

```ts
// app/api/download/[slug]/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { verifyStripeSession } from '@/lib/stripe';
import { getSignedDownloadUrl } from '@/lib/r2';
import { PRODUCTS } from '@/lib/products';

export async function POST(
  request: NextRequest,
  { params }: { params: { slug: string } },
) {
  const product = PRODUCTS[params.slug];
  if (!product) {
    return NextResponse.json({ error: 'Unknown product' }, { status: 404 });
  }

  const { session_id } = await request.json();
  if (!session_id) {
    return NextResponse.json({ error: 'session_id required' }, { status: 400 });
  }

  // Verify against THIS product specifically — pass the expected priceId
  // into verifyStripeSession instead of reading from a global env var.
  const v = await verifyStripeSession(session_id, product.stripePriceId);
  if (!v.valid) {
    return NextResponse.json({ error: v.error }, { status: 403 });
  }

  const url = await getSignedDownloadUrl(product.r2ObjectKey, 900);
  return NextResponse.json({ url });
}
```

You'll also need to refactor `verifyStripeSession(sessionId, expectedPriceId)` to take the expected priceId as an argument instead of reading from `process.env.STRIPE_PRICE_ID`.

**P1.2 — Product registry.**

Replace global `STRIPE_PRICE_ID` + `R2_OBJECT_KEY` env vars with a registry:

```ts
// lib/products.ts
export const PRODUCTS: Record<
  string,
  { stripePriceId: string; r2ObjectKey: string; name: string }
> = {
  'my-first-product': {
    stripePriceId: process.env.STRIPE_PRICE_FIRST!,
    r2ObjectKey: 'first-product-v1.zip',
    name: 'My First Product',
  },
  'my-second-product': {
    stripePriceId: process.env.STRIPE_PRICE_SECOND!,
    r2ObjectKey: 'second-product-v1.zip',
    name: 'My Second Product',
  },
};
```

**P1.3 — Verify product match in `verify-session` too.**

Currently `verify-session` only checks `payment_status === 'paid'` — not which product the customer paid for. The download route does check, but the success page would happily render "Payment successful" for any valid paid session ID (in a multi-product world, that means showing the wrong product's success page). Pass expected priceId and verify there too.

### P2 — UX + ops hardening

**P2.1 — Rate-limit downloads.**

A valid `session_id` can request infinite signed URLs. Bound to e.g. 10/hour. With Upstash Redis:

```ts
const key = `downloads:${session_id}`;
const count = await redis.incr(key);
if (count === 1) await redis.expire(key, 60 * 60);
if (count > 10) {
  return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
}
```

**P2.2 — Pre-fill customer email.**

If you know the buyer's email (from a lead capture, logged-in account, etc.):

```ts
await stripe.checkout.sessions.create({
  ...,
  customer_email: knownEmail,
});
```

Reduces checkout friction by one field.

**P2.3 — Post-purchase email.**

Add to the webhook handler (using Resend, Postmark, SES — whatever you've already wired up). Buyers shouldn't need to keep the success page open to access their download.

**P2.4 — One-time-use download tokens.**

`session_id` lives in the success page URL — a buyer could share that URL and let others download. Issue a single-use token on first verify and burn it on first download:

```sql
create table download_tokens (
  token text primary key,
  stripe_session_id text not null,
  used_at timestamptz
);
```

Generate on the success page mount, swap into the Download button, mark `used_at` on download.

**P2.5 — Origin check on checkout.**

Bots can POST to `/api/checkout` from anywhere. Add:

```ts
const origin = request.headers.get('origin');
if (origin !== process.env.NEXT_PUBLIC_SITE_URL) {
  return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
}
```

Doesn't prevent abuse but raises the cost.

**P2.6 — Idempotency key on session creation.**

Double-click protection — a flaky network shouldn't create two sessions for the same buyer intent:

```ts
await stripe.checkout.sessions.create({...}, { idempotencyKey: someCartId });
```

### P3 — code quality

**P3.1 — `error: unknown`** instead of `error: any` in catch blocks, with proper narrowing:

```ts
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : 'Unknown error';
  console.error('Stripe checkout error:', error);
  return NextResponse.json({ error: message }, { status: 500 });
}
```

**P3.2 — Discriminated union for verify result.**

Current `{ valid, session?, error? }` requires runtime checks everywhere. Better:

```ts
type VerifyResult =
  | { valid: true; session: Stripe.Checkout.Session }
  | { valid: false; error: string };
```

TypeScript narrows on `result.valid` — callers don't need to handle `session: undefined`.

**P3.3 — Reusable `useDownloadKit` hook.**

For multi-product, every success page repeats the same loading / error / verify / download dance. Extract to a hook.

**P3.4 — E2E test against Stripe test mode.**

Stripe provides the `4242` test card. A Playwright test of the full flow (Buy → Pay → Verify → Download → file present) catches regressions before production.

---

## Testing the snippets in this README

Every code block with a `> Create at:` marker is pulled out into `.snippets/` (gitignored) by `scripts/extract-snippets.mjs`, then type-checked and unit-tested against those exact files. Stripe, Supabase and `fetch` are mocked. R2 presigning and Stripe webhook signatures are computed for real, since neither needs the network.

```bash
npm install
npm test               # unit tests
npm run test:coverage  # with coverage report (HTML in coverage/), fails under 95% lines / 90% branches
npm run typecheck      # tsc over the snippets + tests
```

If you edit a snippet, run these again. The tests check the README's code itself, so a broken snippet fails them.

## Notes when porting this `.md` to a different project

- The verbatim source uses `/api/checkout`, `/api/verify-session`, `/api/download`, `/api/webhooks/stripe`. Match those exact paths in the target project, OR update both the route file location AND every `fetch('/api/...')` call in the client code.
- The success page route (`/product/your-product/success`) is the one place you'll want to namespace per product. Update both the page path AND the `success_url` in `app/api/checkout/route.ts`.
- If your project uses absolute imports (`@/lib/stripe`), make sure `tsconfig.json` has the matching `paths` entry. Otherwise switch the imports to relative.
