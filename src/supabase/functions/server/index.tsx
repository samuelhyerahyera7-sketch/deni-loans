import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { createClient } from 'jsr:@supabase/supabase-js@^2.38.0';
import { createTransport } from "npm:nodemailer@6.9.7";

// Payment gateway implementations (PayShap / manual bank) will be implemented here.
// The legacy PayFast integration was removed in favor of PayShap/manual flows.
import { db } from './db_helpers.ts';

const app = new Hono();
app.use('*', cors());
app.use('*', logger(console.log));
const supabase = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'));

// SMTP Configuration for Emails
const transporter = createTransport({
  host: "smtp.gmail.com",
  port: 465,
  secure: true,
  auth: {
    user: Deno.env.get('SMTP_USER'),
    pass: Deno.env.get('SMTP_PASSWORD'),
  },
});

// Migration endpoint: Move all applications from KV to SQL
// Added logic to `kv` variable usage.

app.get('/make-server-1ed353c1/admin/migrate-data', requireAdmin, async (c) => {
  try {
    console.log('SQL migration endpoint - Placeholder only.');
    
    return c.json({
      success: true,
      message: "Data is now primarily in SQL. Migration logic from KV removed."
    });
  } catch (err) {
    console.error('Migration endpoint error:', err);
    return c.json({ error: String(err) }, 500);
  }
});

// Initialize storage bucket for documents


// --- Logging helpers -------------------------------------------------
function redactHeaders(headers: Headers) {
  const out: Record<string,string> = {};
  try {
    for (const [k,v] of headers.entries()) {
      if (k.toLowerCase() === 'authorization' && v) {
        out[k] = v.startsWith('Bearer ') ? 'Bearer <REDACTED>' : '<REDACTED>';
      } else {
        out[k] = v;
      }
    }
  } catch (e) {
    // headers may not be iterable in some runtimes
  }
  return out;
}

async function safeStringify(obj: any) {
  try { return JSON.stringify(obj, null, 2); } catch (e) { return String(obj); }
}

function logHandlerStart(c: any, label: string) {
  try {
    const info = {
      label,
      method: c.req.method,
      path: (c.req.url || c.req.path) || '<unknown>',
      headers: redactHeaders(c.req.headers),
      now: new Date().toISOString()
    };
    console.log('[HANDLER START]', label, JSON.stringify(info));
  } catch (e) {
    console.log('[HANDLER START] failed to log start for', label);
  }
}

function logError(label: string, err: any) {
  try {
    console.log('[ERROR]', label, err && err.stack ? err.stack : err);
  } catch (e) {
    console.log('[ERROR] failed to log error for', label, err);
  }
}

// Auth Middleware
async function requireAuth(c, next) {
  const accessToken = c.req.header('Authorization')?.split(' ')[1];
  if (!accessToken) {
    return c.json({
      error: 'Unauthorized - No token provided'
    }, 401);
  }
  const { data: { user }, error } = await supabase.auth.getUser(accessToken);
  if (error || !user) {
    return c.json({
      error: 'Unauthorized - Invalid token'
    }, 401);
  }
  c.set('userId', user.id);
  c.set('userEmail', user.email);
  c.set('userMetadata', user.user_metadata);
  await next();
}

// Admin Middleware
async function requireAdmin(c, next) {
  // Ensure the request is authenticated first. If requireAuth middleware wasn't applied
  // (some admin routes registered only requireAdmin), try to populate user info here.
  let userMetadata = c.get('userMetadata');
  try {
    if (!userMetadata) {
      const accessToken = c.req.header('Authorization')?.split(' ')[1];
      if (!accessToken) {
        return c.json({ error: 'Unauthorized - No token provided' }, 401);
      }
      const { data: { user }, error } = await supabase.auth.getUser(accessToken);
      if (error || !user) {
        return c.json({ error: 'Unauthorized - Invalid token' }, 401);
      }
      c.set('userId', user.id);
      c.set('userEmail', user.email);
      c.set('userMetadata', user.user_metadata);
      userMetadata = user.user_metadata;
    }

    if (userMetadata?.role !== 'admin') {
      // Log useful info to help debug why admin check failed
      try {
        console.log('⚠️ Admin access denied. userId=', c.get('userId'), 'userMetadata=', userMetadata);
      } catch (e) {
        console.log('⚠️ Admin access denied and failed to read context for logging');
      }
      return c.json({ error: 'Forbidden - Admin access required' }, 403);
    }

    await next();
  } catch (err) {
    console.log('requireAdmin exception:', err);
    return c.json({ error: 'Unauthorized - Admin validation failed' }, 401);
  }
}

// Debug endpoint to inspect authenticated user and metadata (requires login)
app.get('/make-server-1ed353c1/debug/me', requireAuth, async (c) => {
  try {
    const userId = c.get('userId');
    const userEmail = c.get('userEmail');
    const userMetadata = c.get('userMetadata');
    return c.json({
      userId,
      userEmail,
      userMetadata
    });
  } catch (error) {
    console.log('Debug me endpoint error:', error);
    return c.json({ error: 'Failed to get debug info' }, 500);
  }
});

// ============ OZOW PAYMENT ROUTES ============
// Note: This implementation uses environment variables to configure Ozow endpoints and keys.
// Set the following in your deployment environment:
// OZOW_API_URL - PostPaymentRequest URL (staging or production)
// OZOW_VERIFY_URL - Optional: endpoint to verify transaction status
// OZOW_SITE_CODE, OZOW_COUNTRY_CODE (ZA), OZOW_CURRENCY_CODE (ZAR)
// OZOW_API_KEY, OZOW_PRIVATE_KEY

// Helper to build canonical Ozow URLs using BASE_URL and optional metadata overrides
function buildOzowUrls(metadata?: any) {
  const base = (Deno.env.get('BASE_URL') || '').replace(/\/$/, '');
  const notify = (metadata && metadata.notifyUrl) || `${base}/make-server-1ed353c1/ozow/notify`;
  const success = (metadata && metadata.successUrl) || `${base}/payments/success`;
  const error = (metadata && metadata.errorUrl) || `${base}/payments/error`;
  const cancel = (metadata && metadata.cancelUrl) || `${base}/payments/cancel`;
  const postUrl = Deno.env.get('OZOW_POST_URL') || 'https://pay.ozow.com/';
  return { base, notify, success, error, cancel, postUrl };
}

// Public endpoint to fetch Ozow config/URLs (read-only, safe to expose site code but not private key)
app.get('/make-server-1ed353c1/ozow/config', async (c) => {
  try {
    const OZOW_SITE_CODE = Deno.env.get('OZOW_SITE_CODE') || null;
    const OZOW_COUNTRY_CODE = Deno.env.get('OZOW_COUNTRY_CODE') || 'ZA';
    const OZOW_CURRENCY_CODE = Deno.env.get('OZOW_CURRENCY_CODE') || 'ZAR';
    const OZOW_API_URL = Deno.env.get('OZOW_API_URL') || 'https://api.ozow.com/PostPaymentRequest';
    const urls = buildOzowUrls();
    return c.json({ 
      success: true, 
      siteCode: OZOW_SITE_CODE, 
      countryCode: OZOW_COUNTRY_CODE, 
      currencyCode: OZOW_CURRENCY_CODE,
      apiUrl: OZOW_API_URL,
      urls 
    });
  } catch (e) {
    console.log('ozow/config error:', e);
    return c.json({ success: false, error: 'Failed to read Ozow config' }, 500);
  }
});

// Create payment via Ozow API
app.post('/make-server-1ed353c1/ozow/create-payment', async (c) => {
  try {
    const body: any = await c.req.json();
    logHandlerStart(c, '/ozow/create-payment');
    console.log('[ozow/create-payment] incoming body:', await safeStringify(body));
    
    const { amount, invoiceId, returnUrl, metadata } = body;
    
    if (!amount || !invoiceId || !returnUrl) {
      return c.json({ error: 'Missing required fields (amount, invoiceId, returnUrl)' }, 400);
    }

    const OZOW_SITE_CODE = (Deno.env.get('OZOW_SITE_CODE') || '').trim();
    const OZOW_COUNTRY_CODE = Deno.env.get('OZOW_COUNTRY_CODE') || 'ZA';
    const OZOW_CURRENCY_CODE = Deno.env.get('OZOW_CURRENCY_CODE') || 'ZAR';
    const OZOW_API_KEY = (Deno.env.get('OZOW_API_KEY') || '').trim();
    const OZOW_PRIVATE_KEY = (Deno.env.get('OZOW_PRIVATE_KEY') || '').trim();
    // Default to the URL from the PHP example if not set
    const OZOW_API_URL = Deno.env.get('OZOW_API_URL') || 'https://api.ozow.com/postpaymentrequest';

    if (!OZOW_SITE_CODE || !OZOW_API_KEY || !OZOW_PRIVATE_KEY) {
      console.log('Ozow configuration missing (site code, API key or private key)');
      return c.json({ error: 'Ozow not configured' }, 500);
    }

    // Build URLs
    // Ensure we have a valid base URL. If BASE_URL env var is not set, try to construct it or fail gracefully.
    // For Supabase Edge Functions, we can't easily auto-detect the full public URL without configuration.
    let base = (Deno.env.get('BASE_URL') || '').replace(/\/$/, '');
    
    if (!base) {
       // Try to get from Origin header (best for localhost/preview deployments)
       const origin = c.req.header('Origin');
       if (origin) {
         base = origin.replace(/\/$/, '');
         console.log('Using Origin header as base URL:', base);
       } else {
         // Fallback for development/testing if BASE_URL is missing
         console.log('Warning: BASE_URL not set and no Origin header, using placeholder. Ozow callbacks may fail.');
         base = 'https://deniloans.co.za'; // Replace with your actual domain or localhost for testing
       }
    }
    
    // Fix for Ozow validation errors:
    // TransactionReference: max 50 chars.
    // BankReference: max 20 chars.
    
    // Frontend sends invoiceId = `${applicationId}-${Date.now()}`.
    // If applicationId is UUID (36) + '-' (1) + Date (13) = 50 chars.
    // We truncate to 50 just in case, but do NOT add extra chars.
    const transactionReference = invoiceId.substring(0, 50);
    
    // Generate a short, unique BankReference (max 20 chars)
    // Format: Ref-{last 9 of timestamp}-{3 random chars}
    // Example: Ref-123456789-abc (17 chars)
    const bankReference = `Ref-${Date.now().toString().slice(-9)}-${Math.random().toString(36).substring(2, 5)}`;
    
    // Match frontend routes in App.tsx (/payment/success, /payment/cancel)
    const cancelUrl = (metadata && metadata.cancelUrl) || `${base}/payment/cancel`;
    const errorUrl = (metadata && metadata.errorUrl) || `${base}/payment/cancel`; // Map error to cancel for now
    const successUrl = (metadata && metadata.successUrl) || `${base}/payment/success`;
    
    // NotifyUrl MUST be public. If base is localhost, use a placeholder or the production URL if known.
    // Ozow will fail if NotifyUrl is not a valid public URL.
    let notifyUrl = (metadata && metadata.notifyUrl) || `${base}/functions/v1/make-server-1ed353c1/ozow/notify`;
    if (notifyUrl.includes('localhost') || notifyUrl.includes('127.0.0.1')) {
        console.log('Warning: NotifyUrl is localhost, which Ozow cannot reach. Using placeholder.');
        // Use a dummy public URL to pass validation during local testing
        notifyUrl = 'https://deniloans.co.za/api/ozow/notify'; 
    }

    const isTest = Deno.env.get('OZOW_IS_TEST') === 'true';

    // Format amount to two decimal places
    const amountStr = Number(amount).toFixed(2);

    // Construct postData exactly as PHP example for hashing order
    // PHP Order: SiteCode, CountryCode, CurrencyCode, Amount, TransactionReference, BankReference, CancelUrl, ErrorUrl, SuccessUrl, NotifyUrl, IsTest
    const postData = {
      SiteCode: OZOW_SITE_CODE,
      CountryCode: OZOW_COUNTRY_CODE,
      CurrencyCode: OZOW_CURRENCY_CODE,
      Amount: amountStr,
      TransactionReference: transactionReference,
      BankReference: bankReference,
      CancelUrl: cancelUrl,
      ErrorUrl: errorUrl,
      SuccessUrl: successUrl,
      NotifyUrl: notifyUrl,
      IsTest: isTest
    };

    // Generate Hash
    // PHP: $hashString = strtolower(implode('', $postData) . $privateKey);
    let concatenated = '';
    // Iterate in specific order
    const keys = [
      'SiteCode', 'CountryCode', 'CurrencyCode', 'Amount', 
      'TransactionReference', 'BankReference', 
      'CancelUrl', 'ErrorUrl', 'SuccessUrl', 'NotifyUrl', 'IsTest'
    ];

    for (const key of keys) {
      const val = (postData as any)[key];
      if (typeof val === 'boolean') {
        // Documentation specifies: "boolean values are depicted as true and false strings"
        // "Some languages might convert boolean values to 0 and 1, which will result in a failed hash check."
        concatenated += val ? 'true' : 'false'; 
      } else {
        concatenated += String(val);
      }
    }
    
    concatenated += OZOW_PRIVATE_KEY;
    const toHash = concatenated.toLowerCase();
    
    const encoder = new TextEncoder();
    const dataBuffer = encoder.encode(toHash);
    const hashBuffer = await crypto.subtle.digest('SHA-512', dataBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashCheck = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

    // Add HashCheck to postData
    (postData as any).HashCheck = hashCheck;

    console.log('[ozow/create-payment] Sending to Ozow API:', { url: OZOW_API_URL, postData });

    // Call Ozow API
    const response = await fetch(OZOW_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'ApiKey': OZOW_API_KEY
      },
      body: JSON.stringify(postData)
    });

    const responseText = await response.text();
    console.log('[ozow/create-payment] Ozow API response status:', response.status);
    console.log('[ozow/create-payment] Ozow API response body:', responseText);

    let responseData;
    try {
      responseData = JSON.parse(responseText);
    } catch (e) {

      responseData = { raw: responseText };
    }

    if (!response.ok) {
      console.error('[ozow/create-payment] Ozow API error:', responseData);
      return c.json({ 
        success: false, 
        error: 'Ozow API request failed',
        details: responseData,
        status: response.status 
      }, 500);
    }

    // Check if response contains payment URL
    if (responseData && (responseData.url || responseData.paymentUrl || responseData.redirectUrl)) {
      const paymentUrl = responseData.url || responseData.paymentUrl || responseData.redirectUrl;
      
      // Persist payment request record (placeholder for future SQL implementation if needed)
      try {
        console.log(`Ozow payment record created for ${transactionReference}`);
      } catch (e) {
        console.log('Failed to log Ozow payment record:', e);
      }

      return c.json({ 
        success: true, 
        paymentUrl,
        transactionReference,
        details: responseData
      });
    } else {
      // Unexpected response format
      console.error('[ozow/create-payment] Unexpected Ozow response format:', responseData);
      return c.json({ 
        success: false, 
        error: 'Unexpected response from Ozow API',
        details: responseData 
      }, 500);
    }
  } catch (error) {
    console.log('Ozow create-payment exception:', error);
    return c.json({ error: 'Ozow create-payment failed', details: error.message }, 500);
  }
});

// Ozow notification (webhook) endpoint - Ozow will POST payment status updates here
app.post('/make-server-1ed353c1/ozow/notify', async (c) => {
  try {
    // Ozow sends application/x-www-form-urlencoded POSTs to the notify URL
    logHandlerStart(c, '/ozow/notify');
    console.log('[ozow/notify] headers:', JSON.stringify(redactHeaders(c.req.headers)));
    const body = await c.req.text();
    console.log('[ozow/notify] raw body:', body);

    const params = new URLSearchParams(body);
    // Map expected fields (case-insensitive access)
    const get = (key: string) => params.get(key) ?? params.get(key.toLowerCase()) ?? '';

    const SiteCode = get('SiteCode');
    const TransactionId = get('TransactionId');
    const TransactionReference = get('TransactionReference');
    const Amount = get('Amount');
    const Status = get('Status');
    const Optional1 = get('Optional1');
    const Optional2 = get('Optional2');
    const Optional3 = get('Optional3');
    const Optional4 = get('Optional4');
    const Optional5 = get('Optional5');
    const CurrencyCode = get('CurrencyCode');
    const IsTest = get('IsTest');
    const StatusMessage = get('StatusMessage');
    const Hash = get('Hash');
    const SubStatus = get('SubStatus');
    const MaskedAccountNumber = get('MaskedAccountNumber');
    const BankName = get('BankName');

    const txRef = TransactionReference || params.get('transactionReference') || params.get('reference');

    if (!SiteCode || !TransactionId || !TransactionReference || !Amount || !Status || !CurrencyCode || !Hash) {
      console.log('Ozow notify missing required fields, params keys:', Array.from(params.keys()));
      return c.json({ error: 'Missing required Ozow notification fields' }, 400);
    }

    const OZOW_PRIVATE_KEY = Deno.env.get('OZOW_PRIVATE_KEY');
    if (!OZOW_PRIVATE_KEY) {
      console.log('Ozow notify: missing OZOW_PRIVATE_KEY in env');
      return c.json({ error: 'Server not configured' }, 500);
    }

    // According to Ozow spec: concatenate response variables 1..13 (SiteCode..StatusMessage), append private key, lowercase, SHA512
    const concatParts = [
      SiteCode,
      TransactionId,
      TransactionReference,
      Amount,
      Status,
      Optional1,
      Optional2,
      Optional3,
      Optional4,
      Optional5,
      CurrencyCode,
      IsTest,
      StatusMessage
    ];
    const concat = concatParts.join('') + OZOW_PRIVATE_KEY;

    async function sha512hex(input: string) {
      const enc = new TextEncoder();
      const data = enc.encode(input.toLowerCase());
      const hashBuffer = await crypto.subtle.digest('SHA-512', data);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    }

    function trimLeadingZeros(s: string) {
      try { return s.replace(/^0+/, ''); } catch (e) { return s; }
    }

    const calculated = await sha512hex(concat);
    const calcTrim = trimLeadingZeros(calculated.toLowerCase());
    const gotTrim = trimLeadingZeros(Hash.toLowerCase());

    if (calcTrim !== gotTrim) {
      console.log('Ozow notify hash mismatch', { TransactionReference, calculated, received: Hash, calcTrim, gotTrim });
      // Respond 400 so provider can retry later; do not process the notification
      return c.json({ error: 'Invalid hash' }, 400);
    }

    // Idempotent update: log and return OK
    if (txRef) {
      try {
        console.log(`Ozow notify received for ${txRef} with status ${Status}`);
        
        const mappedStatus = (s:string) => {
          switch ((s||'').toLowerCase()) {
            case 'complete': return 'completed';
            case 'cancelled': return 'cancelled';
            case 'error': return 'error';
            case 'abandoned': return 'abandoned';
            case 'pendinginvestigation': return 'pending_investigation';
            case 'pending': return 'pending';
            default: return s || 'unknown';
          }
        };

        // TODO: In the future, persist these updates to a SQL 'payments' or 'ozow_transactions' table
        console.log('[ozow/notify] processing ozow_payment status update for', txRef);
        
        // If status indicates completed, create payment record / bookkeeping entry (idempotency handled by DB in future)
        if (mappedStatus(Status) === 'completed') {
          try {
            // Defer detailed payment creation to admin flow or separate reconcile job to avoid accidental double-credits
            console.log('Ozow notify: transaction completed:', txRef);
          } catch (e) {
            console.log('Ozow notify: failed to process completion during notify (non-fatal):', e);
          }
        }
      } catch (e) {
        console.log('Failed to log ozow payment notification:', e);
      }
    }

    // Acknowledge
    return c.text('OK', 200);
  } catch (error) {
    console.log('Ozow notify exception:', error);
    return c.json({ error: 'Notify processing failed' }, 500);
  }
});

// Optional: Verify transaction status by calling Ozow verify endpoint
app.post('/make-server-1ed353c1/ozow/verify', async (c) => {
  try {
    const reqBody: any = await c.req.json();
    logHandlerStart(c, '/ozow/verify');
    console.log('[ozow/verify] body:', await safeStringify(reqBody));
    const { transactionReference } = reqBody;
    if (!transactionReference) return c.json({ error: 'transactionReference required' }, 400);

    const OZOW_VERIFY_URL = Deno.env.get('OZOW_VERIFY_URL');
    const OZOW_API_KEY = Deno.env.get('OZOW_API_KEY');
    if (!OZOW_VERIFY_URL || !OZOW_API_KEY) {
      return c.json({ error: 'Ozow verify not configured' }, 500);
    }

    const res = await fetch(OZOW_VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': OZOW_API_KEY },
      body: JSON.stringify({ TransactionReference: transactionReference })
    });

    // Log outgoing request result for easier debugging
    let data: any = null;
    try {
      const text = await res.text();
      data = text;
      try { data = JSON.parse(text); } catch (e) { /* keep raw text */ }
      console.log('[ozow/verify] outgoing verify request:', { url: OZOW_VERIFY_URL, status: res.status, ok: res.ok });
      // Log a trimmed response (avoid huge logs)
      try { console.log('[ozow/verify] response snippet:', typeof text === 'string' ? text.slice(0, 200) : JSON.stringify(text).slice(0,200)); } catch(e) {}
    } catch (e) {
      console.log('[ozow/verify] failed to read verify response:', e);
      data = null;
    }

    // Optional: Log verification (Removed KV persistence)
    try {
      console.log(`Ozow verify response for ${transactionReference}:`, data);
    } catch (e) {
      console.log('Failed to log ozow verify response:', e);
    }

    return c.json({ success: true, data });
  } catch (error) {
    console.log('Ozow verify exception:', error);
    return c.json({ error: 'Ozow verify failed' }, 500);
  }
});

// Query Ozow API by transaction reference (GetTransactionByReference)
app.post('/make-server-1ed353c1/ozow/get-transaction-by-reference', async (c) => {
  try {
    const reqBody: any = await c.req.json();
    logHandlerStart(c, '/ozow/get-transaction-by-reference');
    console.log('[ozow/get-transaction-by-reference] body:', await safeStringify(reqBody));
    const { transactionReference, isTest } = reqBody;
    if (!transactionReference) return c.json({ error: 'transactionReference required' }, 400);

    const OZOW_API_BASE = Deno.env.get('OZOW_API_BASE') || 'https://api.ozow.com';
    const OZOW_API_KEY = Deno.env.get('OZOW_API_KEY');
    const OZOW_SITE_CODE = Deno.env.get('OZOW_SITE_CODE');
    if (!OZOW_API_KEY || !OZOW_SITE_CODE) return c.json({ error: 'Ozow API not configured' }, 500);

    const url = `${OZOW_API_BASE}/GetTransactionByReference?siteCode=${encodeURIComponent(OZOW_SITE_CODE)}&transactionReference=${encodeURIComponent(transactionReference)}${isTest ? '&IsTest=true' : ''}`;

    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'x-api-key': OZOW_API_KEY,
        'Accept': 'application/json'
      }
    });

    const text = await res.text();
    let data: any = text;
    try { data = JSON.parse(text); } catch (e) { /* leave as text */ }

    // Log outgoing request to Ozow GetTransactionByReference (Removed KV persistence)
    try {
      console.log('[ozow/get-transaction-by-reference] outgoing GET', url, 'status=', res.status, 'ok=', res.ok);
      try { console.log('[ozow/get-transaction-by-reference] response snippet:', (typeof text === 'string' ? text.slice(0,300) : JSON.stringify(text).slice(0,300))); } catch(e) {}
      console.log(`Ozow get-transaction-by-reference response for ${transactionReference}:`, data);
    } catch (e) {
      console.log('[ozow/get-transaction-by-reference] logging failed:', e);
    }

    return c.json({ success: true, data });
  } catch (error) {
    console.log('GetTransactionByReference exception:', error);
    return c.json({ error: 'GetTransactionByReference failed' }, 500);
  }
});

// Query Ozow API by Ozow TransactionId (GetTransaction)
app.post('/make-server-1ed353c1/ozow/get-transaction', async (c) => {
  try {
    const reqBody: any = await c.req.json();
    logHandlerStart(c, '/ozow/get-transaction');
    console.log('[ozow/get-transaction] body:', await safeStringify(reqBody));
    const { transactionId, isTest } = reqBody;
    if (!transactionId) return c.json({ error: 'transactionId required' }, 400);

    const OZOW_API_BASE = Deno.env.get('OZOW_API_BASE') || 'https://api.ozow.com';
    const OZOW_API_KEY = Deno.env.get('OZOW_API_KEY');
    const OZOW_SITE_CODE = Deno.env.get('OZOW_SITE_CODE');
    if (!OZOW_API_KEY || !OZOW_SITE_CODE) return c.json({ error: 'Ozow API not configured' }, 500);

    const url = `${OZOW_API_BASE}/GetTransaction?siteCode=${encodeURIComponent(OZOW_SITE_CODE)}&transactionId=${encodeURIComponent(transactionId)}${isTest ? '&IsTest=true' : ''}`;

    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'x-api-key': OZOW_API_KEY,
        'Accept': 'application/json'
      }
    });

    const text = await res.text();
    let data: any = text;
    try { data = JSON.parse(text); } catch (e) { /* leave as text */ }

    // Log outgoing request to Ozow GetTransaction (Removed KV persistence)
    try {
      console.log('[ozow/get-transaction] outgoing GET', url, 'status=', res.status, 'ok=', res.ok);
      try { console.log('[ozow/get-transaction] response snippet:', (typeof text === 'string' ? text.slice(0,300) : JSON.stringify(text).slice(0,300))); } catch(e) {}
    } catch (e) {
      console.log('[ozow/get-transaction] logging failed:', e);
    }

    return c.json({ success: true, data });
  } catch (error) {
    console.log('GetTransaction exception:', error);
    return c.json({ error: 'GetTransaction failed' }, 500);
  }
});

// ============ AUTH ROUTES ============
app.post('/make-server-1ed353c1/signup', async (c)=>{
  try {
    const { email, password, fullName, phone, role } = await c.req.json();
    
  // Create user without confirming email
  // Supabase will automatically send a confirmation email (link) when email_confirm is false
    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password,
      user_metadata: {
        fullName,
        phone,
        role: role || 'borrower'
      },
  email_confirm: false  // ← User must verify email via confirmation link
    });

    // Diagnostic: log full createUser response so we can inspect mailer/send attempts
    try {
      console.log('DEBUG createUser response:', JSON.stringify({ data, error }, null, 2));
    } catch (e) {
      console.log('DEBUG createUser response (non-serializable):', data, error);
    }

    if (error) {
      console.log(`Signup error: ${error.message}`);
      return c.json({
        error: error.message
      }, 400);
    }

    console.log(`✅ User created (unconfirmed): ${email}`);

    // Explicitly send the confirmation email since admin.createUser might not trigger it automatically
    const { error: resendError } = await supabase.auth.resend({
      type: 'signup',
      email: email
    });

    if (resendError) {
      console.log(`⚠️ Failed to send confirmation email: ${resendError.message}`);
    } else {
      console.log(`📧 Confirmation email sent to: ${email}`);
    }
    
    return c.json({
      success: true,
      user: data.user,
      message: 'Account created. Please check your email for a confirmation link.'
    });
  } catch (error) {
    console.log(`Signup exception: ${error}`);
    return c.json({
      error: 'Signup failed'
    }, 500);
  }
});

// ============ EMAIL VERIFICATION ROUTES ============
app.post('/make-server-1ed353c1/check-verification', async (c)=>{
  try {
    const { email } = await c.req.json();
    if (!email) {
      return c.json({
        error: 'Email is required'
      }, 400);
    }
    
    // Get user by email to check verification status
    const { data: { users }, error } = await supabase.auth.admin.listUsers();
    if (error) {
      return c.json({
        error: 'Failed to check verification status'
      }, 500);
    }
    
    const user = users.find((u)=>u.email === email);
    if (!user) {
      return c.json({
        error: 'User not found'
      }, 404);
    }
    
    return c.json({
      email_confirmed: user.email_confirmed_at ? true : false,
      user_id: user.id
    });
  } catch (error) {
    console.log(`Check verification error: ${error}`);
    return c.json({
      error: 'Failed to check verification status'
    }, 500);
  }
});

app.post('/make-server-1ed353c1/resend-verification', async (c)=>{
  try {
    const { email } = await c.req.json();
    if (!email) {
      return c.json({
        error: 'Email is required'
      }, 400);
    }
    
    // Resend confirmation email using Supabase auth
    // Use the 'resend' method with type 'signup' to trigger a confirmation link
    const { error } = await supabase.auth.resend({
      email,
      type: 'signup'
    });

    if (error) {
      console.log(`Resend confirmation error: ${error.message}`);
      return c.json({
        error: error.message || 'Failed to resend confirmation email'
      }, 400);
    }

    console.log(`✅ Confirmation email resent to: ${email}`);

    return c.json({
      success: true,
      message: 'Confirmation email sent to your email'
    });
  } catch (error) {
    console.log(`Resend exception: ${error}`);
    // Log the full error object if possible
    try { console.log(JSON.stringify(error, Object.getOwnPropertyNames(error))); } catch(e) {}
    
    return c.json({
      error: 'Failed to resend confirmation email'
    }, 500);
  }
});

// ============ LOAN APPLICATION ROUTES ============
app.post('/make-server-1ed353c1/loan-application', requireAuth, async (c)=>{
  try {
    const userId = c.get('userId');

    // --- 30-DAY COOLING OFF & ACTIVE LOAN CHECK ---
    // 1. Fetch user's existing applications
    const sortedApps = await db.getApplicationsByUser(userId);

    const lastApp = sortedApps[0];

    // Debug active loan check
    console.log(`Checking loan eligibility for user ${userId}. Last App:`, lastApp ? { id: lastApp.id, status: lastApp.status, date: lastApp.createdAt } : 'None');

    if (lastApp) {
      // Rule A: Prevent multiple active loans
      // Disbursed always blocks, pending/review blocks, approved only blocks within 30 days
      const alwaysBlockStatuses = ['draft', 'pending', 'review', 'disbursed'];
      if (alwaysBlockStatuses.includes(lastApp.status)) {
         console.log(`Blocked: Active loan found with status ${lastApp.status}`);
         return c.json({
          error: 'You already have an active application or loan. Please settle it or wait for a decision before applying again.'
        }, 400);
      }
      
      // Rule A2: Approved loans only block for 30 days - after that they're stale
      if (lastApp.status === 'approved') {
        const approvedDateStr = lastApp.updatedAt || lastApp.createdAt;
        const approvedDate = new Date(approvedDateStr);
        const today = new Date();
        const diffDays = Math.floor((today.getTime() - approvedDate.getTime()) / (1000 * 60 * 60 * 24));
        
        console.log(`Last app approved on ${approvedDateStr}. Days passed: ${diffDays}`);
        
        if (diffDays < 30) {
          return c.json({
            error: 'You have an approved loan waiting to be disbursed. Please contact support if you need assistance.'
          }, 400);
        }
        // Approved more than 30 days ago - allow new application
        console.log(`Approved loan is ${diffDays} days old (>30), allowing new application`);
      }

      // Rule B: 30-Day Cooling Period for Declined Applications
      if (lastApp.status === 'declined') {
        // Use updatedAt for declined date if available, else createdAt
        // Ensure accurate date parsing
        const decidedDateStr = lastApp.updatedAt || lastApp.createdAt;
        const decidedDate = new Date(decidedDateStr);
        const today = new Date();
        
        // Calculate difference in milliseconds
        const diffTime = today.getTime() - decidedDate.getTime();
        
        // Convert to days (rounding down to be safe, or direct division)
        const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
        
        console.log(`Last app declined on ${decidedDateStr}. Days passed: ${diffDays}`);

        if (diffDays < 30) {
          const daysRemaining = 30 - diffDays;
           return c.json({
            error: `Your previous application was declined on ${decidedDate.toLocaleDateString()}. You can apply again in ${daysRemaining} days.`
          }, 400);
        }
      }
    }
    // ---------------------------------------------------

    const applicationData = await c.req.json();
    const application = {
      id: crypto.randomUUID(),
      userId,
      ...applicationData,
      status: 'draft',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await db.saveApplication(application);
    return c.json({
      success: true,
      application
    });
  } catch (error) {
    console.log(`Create loan application error: ${error}`);
    return c.json({
      error: 'Failed to create application'
    }, 500);
  }
});

app.get('/make-server-1ed353c1/loan-application/:id', requireAuth, async (c)=>{
  try {
    const userId = c.get('userId');
    const applicationId = c.req.param('id');
    const application = await db.getApplication(applicationId);
    if (!application) {
      return c.json({
        error: 'Application not found'
      }, 404);
    }
    // Check if user owns this application or is admin
    const userMetadata = c.get('userMetadata');
    if (application.userId !== userId && userMetadata?.role !== 'admin') {
      return c.json({
        error: 'Forbidden'
      }, 403);
    }
    return c.json({
      application
    });
  } catch (error) {
    console.log(`Get loan application error: ${error}`);
    return c.json({
      error: 'Failed to get application'
    }, 500);
  }
});

app.get('/make-server-1ed353c1/my-applications', requireAuth, async (c)=>{
  try {
    const userId = c.get("userId");
    const applications = await db.getApplicationsByUser(userId);
    return c.json({
      applications
    });
  } catch (error) {
    console.log(`Get user applications error: ${error}`);
    return c.json({
      error: 'Failed to get applications'
    }, 500);
  }
});

app.patch('/make-server-1ed353c1/loan-application/:id', requireAuth, async (c)=>{
  try {
    const userId = c.get('userId');
    const userMetadata = c.get('userMetadata');
    const isAdmin = userMetadata?.role === 'admin';
    const applicationId = c.req.param('id');
    const updates = await c.req.json();
    const application = await db.getApplication(applicationId);
    if (!application) {
      return c.json({
        error: 'Application not found'
      }, 404);
    }
    
    // Allow if user owns the application OR is an admin
    if (application.userId !== userId && !isAdmin) {
      return c.json({
        error: 'Forbidden'
      }, 403);
    }
    const updatedApplication = {
      ...application,
      ...updates,
      updatedAt: new Date().toISOString()
    };
    await db.saveApplication(updatedApplication);

    // Trigger "Counter Offer Accepted" email
    if (updates.counterOfferStatus === 'accepted' && application.counterOfferStatus !== 'accepted') {
      try {
        const acceptedAmount = updates.approvedAmount ?? updates.requestedAmount ?? application.counterOfferAmount;
        console.log(`Sending Counter Offer Accepted email to Admin`);
        await transporter.sendMail({
          from: '"Deni Loans System" <admin@deniloans.co.za>',
          to: 'admin@deniloans.co.za',
          subject: `Counter Offer Accepted - ${application.fullName}`,
          text: `Applicant ${application.fullName} has accepted the counter offer of R${acceptedAmount}.\nPlease review and finalize the application.`,
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <h2 style="color: #2563eb;">Counter Offer Accepted</h2>
              <p>Applicant <strong>${application.fullName}</strong> has accepted the counter offer.</p>
              <p><strong>New Amount:</strong> R${acceptedAmount}</p>
              <p>Please review and finalize the application.</p>
            </div>
          `
        });
      } catch (emailError) {
        console.error('Failed to send counter offer accepted email:', emailError);
      }
    }

    // Trigger "Application Received" email
    // Check if it's a new application or re-submission (not counter offer acceptance)
    if (updates.status === 'pending' && application.status !== 'pending' && updates.counterOfferStatus !== 'accepted') {
      try {
        console.log(`Sending Application Received email to ${application.email}`);
        await transporter.sendMail({
          from: '"Deni Loans" <admin@deniloans.co.za>', // Update this sender email
          to: application.email,
          subject: "Application Received - Deni Loans",
          text: `Dear ${application.fullName},\n\nWe have received your loan application and it is currently under review.\nOur team will assess your application and you will be notified of the outcome shortly.\n\nBest regards,\nDeni Loans Team`,
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <h2 style="color: #2563eb;">Application Received</h2>
              <p>Dear ${application.fullName},</p>
              <p>We have received your loan application and it is currently under review.</p>
              <p>Our team will assess your application and you will be notified of the outcome shortly.</p>
              <p>Best regards,<br>Deni Loans Team</p>
            </div>
          `
        });

        console.log(`Sending New Application Alert email to Admin`);
        await transporter.sendMail({
          from: '"Deni Loans System" <admin@deniloans.co.za>',
          to: 'admin@deniloans.co.za',
          subject: "New Loan Application Submitted",
          text: `A new loan application has been submitted.\n\nApplicant: ${application.fullName}\nID Number: ${application.idNumber}\nPhone: ${application.phone}`,
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <h2 style="color: #2563eb;">New Application Alert</h2>
              <p>A new loan application has been submitted.</p>
              <p><strong>Applicant:</strong> ${application.fullName}</p>
              <p><strong>ID Number:</strong> ${application.idNumber}</p>
              <p><strong>Phone:</strong> ${application.phone}</p>
              <p><strong>Email:</strong> ${application.email}</p>
              <p>Please log in to the admin dashboard to review it.</p>
            </div>
          `
        });
      } catch (emailError) {
        console.error('Failed to send application received email:', emailError);
      }
    }

    return c.json({
      success: true,
      application: updatedApplication
    });
  } catch (error) {
    console.log(`Update loan application error: ${error}`);
    return c.json({
      error: 'Failed to update application'
    }, 500);
  }
});

// ============ DOCUMENT ROUTES ============
app.post('/make-server-1ed353c1/upload-document', requireAuth, async (c)=>{
  try {
    const userId = c.get('userId');
    const formData = await c.req.formData();
    const file = formData.get('file');
    const applicationId = formData.get('applicationId');
    const documentType = formData.get('documentType');
    if (!file || !applicationId || !documentType) {
      return c.json({
        error: 'Missing required fields'
      }, 400);
    }
    const fileExt = file.name.split('.').pop();
    const fileName = `${userId}/${applicationId}/${documentType}_${Date.now()}.${fileExt}`;
    const { data, error } = await supabase.storage.from('make-1ed353c1-loan-documents').upload(fileName, file, {
      contentType: file.type,
      upsert: false
    });
    if (error) {
      console.log(`Document upload error: ${error.message}`);
      return c.json({
        error: 'Failed to upload document'
      }, 500);
    }
    const document = {
      id: crypto.randomUUID(),
      userId,
      applicationId,
      usageType: documentType, // Map documentType to usageType for db_helpers
      fileName: file.name,
      filePath: data.path,
      createdAt: new Date().toISOString()
    };
    await db.saveDocumentMetadata(document);
    return c.json({
      success: true,
      document
    });
  } catch (error) {
    console.log(`Upload document exception: ${error}`);
    return c.json({
      error: 'Failed to upload document'
    }, 500);
  }
});

app.get('/make-server-1ed353c1/documents/:applicationId', requireAuth, async (c)=>{
  try {
    const userId = c.get('userId');
    const applicationId = c.req.param('applicationId');
    // Verify application ownership
    const application = await db.getApplication(applicationId);
    const userMetadata = c.get('userMetadata');
    if (!application) {
      return c.json({
        error: 'Application not found'
      }, 404);
    }
    if (application.userId !== userId && userMetadata?.role !== 'admin') {
      return c.json({
        error: 'Forbidden'
      }, 403);
    }
    const documents = await db.getApplicationDocuments(applicationId);
    // Get signed URLs for documents
    const documentsWithUrls = await Promise.all(documents.filter(Boolean).map(async (doc)=>{
      const { data } = await supabase.storage.from('make-1ed353c1-loan-documents').createSignedUrl(doc.filePath, 3600);
      return {
        ...doc,
        signedUrl: data?.signedUrl
      };
    }));
    return c.json({
      documents: documentsWithUrls
    });
  } catch (error) {
    console.log(`Get documents error: ${error}`);
    return c.json({
      error: 'Failed to get documents'
    }, 500);
  }
});

// ============ CREDIT CHECK ROUTE ============
app.post('/make-server-1ed353c1/credit-check', requireAuth, async (c)=>{
  try {
    const { idNumber, income, existingDebts, applicationId } = await c.req.json();

    // Check if we already have a report for this application
    if (applicationId) {
      const existingApp = await db.getApplication(applicationId);
      if (existingApp && existingApp.creditReport) {
        console.log(`Returning persisted credit report for app ${applicationId}`);
        return c.json({ creditReport: existingApp.creditReport });
      }
    }

    const creditScore = Math.floor(Math.random() * 400) + 400;
    const monthlyIncome = parseFloat(income);
    const monthlyDebts = parseFloat(existingDebts || 0);
    const disposableIncome = monthlyIncome - monthlyDebts;
    const affordabilityThreshold = monthlyIncome * 0.35;
    const maxLoanAmount = Math.min(4000, affordabilityThreshold * 3);
    const approved = creditScore >= 550 && disposableIncome > 2000 && maxLoanAmount >= 500;
    const creditReport = {
      id: crypto.randomUUID(),
      idNumber,
      creditScore,
      disposableIncome,
      maxLoanAmount: approved ? Math.floor(maxLoanAmount) : 0,
      approved,
      reason: approved ? 'Meets affordability requirements' : creditScore < 550 ? 'Credit score below minimum threshold' : 'Insufficient disposable income',
      checkedAt: new Date().toISOString()
    };

    // Persist the report if attached to an application
    if (applicationId) {
      const existingApp = await db.getApplication(applicationId);
      if (existingApp) {
        await db.saveApplication({ ...existingApp, creditReport });
        console.log(`Persisted credit report for app ${applicationId}`);
      }
    }

    return c.json({
      creditReport
    });
  } catch (error) {
    console.log(`Credit check error: ${error}`);
    return c.json({
      error: 'Credit check failed'
    }, 500);
  }
});

// ============ ADMIN ROUTES ============
app.get('/make-server-1ed353c1/admin/users', requireAdmin, async (c) => {
  try {
    const users = await db.getAllUsers();
    return c.json({ users });
  } catch (error) {
    console.log(`Get all users error: ${error}`);
    return c.json({ error: 'Failed to get users' }, 500);
  }
});

app.get('/make-server-1ed353c1/admin/applications', requireAdmin, async (c)=>{
  try {
    const applications = await db.getAllApplications();
    return c.json({
      applications
    });
  } catch (error) {
    console.log(`Get all applications error: ${error}`);
    return c.json({
      error: 'Failed to get applications'
    }, 500);
  }
});

// Debug endpoint to search by email
app.get('/make-server-1ed353c1/admin/search-by-email', requireAdmin, async (c)=>{
  try {
    const email = c.req.query('email');
    if (!email) {
      return c.json({ error: 'Email parameter required' }, 400);
    }

    console.log(`🔍 Searching for applications with email: ${email}`);

    // Get all applications
    const applications = await db.getAllApplications();
    const validApps = applications.filter(Boolean);
    
    console.log(`📊 Total applications in DB: ${validApps.length}`);

    // Filter by email (case-insensitive)
    const matches = validApps.filter(app => 
      app && app.email?.toLowerCase() === email.toLowerCase()
    );

    console.log(`🎯 Applications matching ${email}: ${matches.length}`);
    
    // Log each match
    matches.forEach((app, idx) => {
      console.log(`Match ${idx + 1}:`, {
        id: app.id,
        email: app.email,
        fullName: app.fullName,
        status: app.status,
        createdAt: app.createdAt
      });
    });

    return c.json({ 
      success: true,
      email,
      totalApplications: validApps.length,
      matchCount: matches.length,
      applications: matches 
    });
  } catch (error) {
    console.error('❌ Search by email error:', error);
    return c.json({ error: 'Search failed', details: String(error) }, 500);
  }
});

app.post('/make-server-1ed353c1/admin/verify-document', requireAdmin, async (c)=>{
  try {
    const { documentId, verified, notes } = await c.req.json();
    // TODO: Implement db.getDocument if specifically needed for verification logic, 
    // or use a direct SQL update. For now, this requires a db helper for documents.
    console.log(`Document verification (pending SQL implementation): ${documentId}, verified: ${verified}`);
    
    return c.json({
      success: true,
      message: 'Verification received. SQL persistence pending.'
    });
  } catch (error) {
    console.log(`Verify document error: ${error}`);
    return c.json({
      error: 'Failed to verify document'
    }, 500);
  }
});

app.post('/make-server-1ed353c1/admin/update-loan-status', requireAdmin, async (c)=>{
  try {
    const { applicationId, status, approvedAmount, declineReason, counterOfferAmount } = await c.req.json();
    const normalizedStatus = String(status || '').toLowerCase().trim().replace(/[-\s]+/g, '_');
    const isCounterOfferStatus = normalizedStatus === 'counter_offer';

    if (!normalizedStatus) {
      return c.json({ error: 'Status is required' }, 400);
    }

    const application = await db.getApplication(applicationId);
    if (!application) {
      return c.json({
        error: 'Application not found'
      }, 404);
    }
    const resolvedApprovedAmount =
      typeof approvedAmount === 'number' && approvedAmount > 0
        ? approvedAmount
        : normalizedStatus === 'approved'
          ? (application.approvedAmount || application.requestedAmount)
          : application.approvedAmount;

    const updatedApplication = {
      ...application,
      status: normalizedStatus,
      // Only default to requestedAmount when explicitly approving a loan.
      approvedAmount: resolvedApprovedAmount,
      declineReason: declineReason ?? application.declineReason,
      counterOfferAmount: counterOfferAmount ?? application.counterOfferAmount,
      decidedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await db.saveApplication(updatedApplication);

    // Trigger emails based on status
    try {
      if (normalizedStatus === 'approved') {
        console.log(`Sending Loan Approved email to ${application.email}`);
        await transporter.sendMail({
          from: '"Deni Loans" <admin@deniloans.co.za>',
          to: application.email,
          subject: "Loan Approved - Deni Loans",
          text: `Dear ${application.fullName},\n\nCongratulations! Your loan application for R${updatedApplication.approvedAmount} has been approved.\nThe funds will be disbursed to your account shortly.\n\nBest regards,\nDeni Loans Team`,
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <h2 style="color: #16a34a;">Loan Approved!</h2>
              <p>Dear ${application.fullName},</p>
              <p>Congratulations! Your loan application for R${updatedApplication.approvedAmount} has been approved.</p>
              <p>The funds will be disbursed to your account shortly.</p>
              <p>Best regards,<br>Deni Loans Team</p>
            </div>
          `
        });
      } else if (normalizedStatus === 'declined') {
        console.log(`Sending Loan Declined email to ${application.email}`);
        await transporter.sendMail({
          from: '"Deni Loans" <admin@deniloans.co.za>',
          to: application.email,
          subject: "Loan Application Update - Deni Loans",
          text: `Dear ${application.fullName},\n\nThank you for your application. After careful review, we regret to inform you that we are unable to approve your loan at this time.\nReason: ${declineReason || 'Did not meet credit criteria'}\n\nYou may apply again in 30 days.\n\nBest regards,\nDeni Loans Team`,
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <h2 style="color: #dc2626;">Application Update</h2>
              <p>Dear ${application.fullName},</p>
              <p>Thank you for your application. After careful review, we regret to inform you that we are unable to approve your loan at this time.</p>
              <p><strong>Reason:</strong> ${declineReason || 'Did not meet credit criteria'}</p>
              <p>You may apply again in 30 days.</p>
              <p>Best regards,<br>Deni Loans Team</p>
            </div>
          `
        });
      } else if (isCounterOfferStatus) {
        const counterAmountForEmail =
          typeof updatedApplication.counterOfferAmount === 'number' && updatedApplication.counterOfferAmount > 0
            ? updatedApplication.counterOfferAmount
            : (typeof application.counterOfferAmount === 'number' ? application.counterOfferAmount : undefined);

        console.log(
          `Sending Counter Offer email to ${application.email} (status=${normalizedStatus}, amount=${counterAmountForEmail ?? 'n/a'})`
        );
        await transporter.sendMail({
          from: '"Deni Loans" <admin@deniloans.co.za>',
          to: application.email,
          subject: "Loan Application Update - Counter Offer",
          text: `Dear ${application.fullName},\n\nWe have reviewed your application. While we cannot offer the full requested amount, we can offer you R${counterAmountForEmail ?? 'N/A'}.\n\nPlease log in to your dashboard to accept or decline this offer.\n\nBest regards,\nDeni Loans Team`,
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <h2 style="color: #ca8a04;">Counter Offer Received</h2>
              <p>Dear ${application.fullName},</p>
              <p>We have reviewed your application. While we cannot offer the full requested amount, we can offer you <strong>R${counterAmountForEmail ?? 'N/A'}</strong>.</p>
              <p>Please log in to your dashboard to accept or decline this offer.</p>
              <p>Best regards,<br>Deni Loans Team</p>
            </div>
          `
        });
      } else if (normalizedStatus === 'repaid') {
        console.log(`Sending Loan Repaid email to ${application.email}`);
        await transporter.sendMail({
          from: '"Deni Loans" <admin@deniloans.co.za>',
          to: application.email,
          subject: "Loan Repaid Successfully - Deni Loans",
          text: `Dear ${application.fullName},\n\nThank you for settling your loan. Your status has been updated to repaid.\n\nYou are now eligible to apply for a new loan immediately.\n\nBest regards,\nDeni Loans Team`,
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 8px;">
              <div style="text-align: center; margin-bottom: 20px;">
                <h2 style="color: #16a34a; margin-bottom: 5px;">Loan Repaid Successfully!</h2>
              </div>
              <p>Dear ${application.fullName},</p>
              <p>Thank you for settling your loan. Your loan status has been updated to <strong>Repaid</strong>.</p>
              <div style="background-color: #f0fdf4; border: 1px solid #bbf7d0; padding: 15px; border-radius: 6px; margin: 20px 0;">
                <p style="margin: 0; color: #166534; font-weight: bold;">✅ You are now eligible to apply for a new loan immediately.</p>
              </div>
              <p>Log in to your dashboard to view your history or start a new application.</p>
              <br>
              <p style="color: #64748b; font-size: 0.9em;">Best regards,<br>Deni Loans Team</p>
            </div>
          `
        });
      }
    } catch (emailError) {
      console.error(`Failed to send ${normalizedStatus} email:`, emailError);
    }

    return c.json({
      success: true,
      application: updatedApplication
    });
  } catch (error) {
    console.log(`Update loan status error: ${error}`);
    return c.json({
      error: 'Failed to update loan status'
    }, 500);
  }
});

app.delete('/make-server-1ed353c1/admin/applications/:id', requireAdmin, async (c) => {
  try {
    const applicationId = c.req.param('id');
    const application = await db.getApplication(applicationId);

    if (!application) {
      return c.json({ error: 'Application not found' }, 404);
    }

    // Delete application
    await db.deleteApplication(applicationId);


    // Document cleanup (Handled by ON DELETE CASCADE in SQL if properly configured)
    console.log(`Application ${applicationId} and related data deleted from SQL.`);

    return c.json({ success: true, message: 'Application deleted' });
  } catch (error) {
    console.log(`Delete application error: ${error}`);
    return c.json({ error: 'Failed to delete application' }, 500);
  }
});

// Admin disburse route - supports PayShap (payshapId) or manual bank disbursement (bank details)
app.post('/make-server-1ed353c1/admin/disburse', requireAdmin, async (c) => {
  try {
    const { applicationId, method, payshapId, bankName, accountNumber, amount } = await c.req.json();

    if (!applicationId || !method) {
      return c.json({ error: 'applicationId and method are required' }, 400);
    }

    const application = await db.getApplication(applicationId);
    if (!application) {
      return c.json({ error: 'Application not found' }, 404);
    }

    const finalAmount = amount || application.approvedAmount || application.requestedAmount || 0;
    
    console.log(`Disbursing application ${applicationId}:`, { 
      requested: amount, 
      fromAppApproved: application.approvedAmount, 
      fromAppRequested: application.requestedAmount,
      final: finalAmount
    });

    // Create a disbursement record
    const disbursement = {
      id: crypto.randomUUID(),
      applicationId,
      method,
      payshapId: payshapId || null,
      bankName: bankName || null,
      accountNumber: accountNumber || null,
      amount: finalAmount,
      disbursedAt: new Date().toISOString(),
      disbursedBy: c.get('userId')
    };

    // TODO: Implement db.saveDisbursement
    console.log('✅ Disbursement details (SQL persistence pending):', disbursement);

    // Update application status to disbursed
    const updatedApplication = {
      ...application,
      status: 'disbursed',
      disbursedAt: disbursement.disbursedAt,
      updatedAt: new Date().toISOString()
    };

    await db.saveApplication(updatedApplication);

    // Record a payment-like entry for bookkeeping
    const payment = {
      id: crypto.randomUUID(),
      applicationId,
      amount: disbursement.amount,
      paymentMethod: method === 'payshap' ? 'payshap-disburse' : 'bank-transfer-disburse',
      paidAt: disbursement.disbursedAt
    };

    // TODO: Implement db.savePayment
    console.log('✅ Payment/Disbursement entry (SQL persistence pending):', payment);

    // Queue an email record for disbursement confirmation
    console.log('📧 Queueing disbursement email for:', application.email);

    return c.json({ success: true, disbursement, application: updatedApplication, emailQueued: true });
  } catch (error) {
    console.log('❌ Disburse error:', error);
    return c.json({ error: 'Failed to disburse' }, 500);
  }
});

app.post('/make-server-1ed353c1/admin/record-payment', requireAdmin, async (c)=>{
  try {
    const { applicationId, amount, paymentMethod } = await c.req.json();
    const payment = {
      id: crypto.randomUUID(),
      applicationId,
      amount,
      paymentMethod,
      paidAt: new Date().toISOString()
    };
    // TODO: Implement db.savePayment
    console.log(`Payment recorded for application ${applicationId}:`, payment);
    
    return c.json({
      success: true,
      payment
    });
  } catch (error) {
    console.log(`Record payment error: ${error}`);
    return c.json({
      error: 'Failed to record payment'
    }, 500);
  }
});

app.post('/make-server-1ed353c1/admin/send-payment-reminder', requireAdmin, async (c) => {
  try {
    const { applicationId } = await c.req.json();
    
    // Fetch application details to get user info
    const application = await db.getApplication(applicationId);
    if (!application) {
      return c.json({ error: 'Application not found' }, 404);
    }

    // Send email using nodemailer
    try {
      await transporter.sendMail({
        from: '"Deni Loans" <admin@deniloans.co.za>',
        to: application.email,
        subject: "Payment Reminder - Deni Loans",
        text: `Dear ${application.fullName},\n\nThis is a reminder that your loan payment is due on ${application.nextPayDate}.\nPlease ensure you have sufficient funds or make a payment via the dashboard.\n\nBest regards,\nDeni Loans Team`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #2563eb;">Payment Reminder</h2>
            <p>Dear ${application.fullName},</p>
            <p>This is a reminder that your loan payment is due on <strong>${application.nextPayDate}</strong>.</p>
            <p>Please ensure you have sufficient funds or make a payment via the dashboard.</p>
            <p>Best regards,<br>Deni Loans Team</p>
          </div>
        `
      });
      console.log(`Payment reminder sent to ${application.email}`);
    } catch (emailError) {
      console.error('Failed to send payment reminder email:', emailError);
      return c.json({ error: 'Failed to send email' }, 500);
    }

    return c.json({ success: true, message: 'Reminder sent successfully' });
  } catch (error) {
    console.log(`Send reminder error: ${error}`);
    return c.json({ error: 'Failed to send reminder' }, 500);
  }
});

app.get('/make-server-1ed353c1/payments/:applicationId', async (c)=>{
  try {
    const applicationId = c.req.param('applicationId');
    const payments = await db.getPaymentByReference(applicationId); // TODO: Implement getAllAppPayments
    // For now we just return empty array or fix the query if needed
    // Assuming payments table migration is separate/later.
    // If you want to migrate payments too, you need `getPaymentsByApplication` in db_helpers.
    return c.json({
      payments: []
    });
  } catch (error) {
    console.log(`Get payments error: ${error}`);
    return c.json({
      error: 'Failed to get payments'
    }, 500);
  }
});

// ============ PAYMENT ROUTES ============
app.post('/make-server-1ed353c1/create-payment', requireAuth, async (c)=>{
  try {
    logHandlerStart(c, '/create-payment');
    const userId = c.get('userId');
    const userEmail = c.get('userEmail');
    // Accept additional fields: paymentMethod, reference, documentId
    const reqBody: any = await c.req.json();
    console.log('[create-payment] incoming body:', await safeStringify(reqBody));
    const { applicationId, amount, paymentType, paymentMethod, reference, documentId } = reqBody;

    console.log('🔄 Creating payment (incoming):', {
      userId,
      applicationId,
      amount,
      paymentType,
      paymentMethod,
      reference,
      documentId
    });

    // Validate application exists and belongs to user
    const application = await db.getApplication(applicationId);
    if (!application) {
      console.log('❌ Application not found:', applicationId);
      return c.json({ success: false, error: 'Application not found' }, 404);
    }
    if (application.userId !== userId) {
      console.log('❌ Application does not belong to user');
      return c.json({ success: false, error: 'Forbidden' }, 403);
    }

    // If borrower included a paymentMethod and proof (documentId or reference), treat this as a real payment
    if (paymentMethod && (documentId || reference)) {
      // Create a pending payment record (awaiting admin verification)
      const payment = {
        id: crypto.randomUUID(),
        applicationId,
        userId,
        amount: amount || 0,
        paymentMethod,
        reference: reference || null,
        documentId: documentId || null,
        status: 'pending_verification',
        createdAt: new Date().toISOString()
      };

      // TODO: Implement db.savePayment
      console.log('Payment pending verification (record creation pending SQL):', payment.id);

      // Create a payment claim referencing this payment so admins can review
      const claim = {
        id: crypto.randomUUID(),
        applicationId,
        paymentId: payment.id,
        userId,
        amount: payment.amount || null,
        paymentMethod,
        reference: reference || null,
        documentId: documentId || null,
        status: 'submitted',
        createdAt: new Date().toISOString()
      };

      // TODO: Implement db.savePaymentClaim
      console.log('Payment claim created (record creation pending SQL):', claim.id);

      // Notify admins if configured
      const adminEmail = Deno.env.get('ADMIN_NOTIFICATION_EMAIL') || null;
      if (adminEmail) {
        console.log(`📧 Admin notification queued for payment review to: ${adminEmail}`);
      }

      console.log('🔔 Payment pending verification and claim recorded:', payment.id, claim.id);

      return c.json({ success: true, paymentId: payment.id, claimId: claim.id, status: 'pending_verification' });
    }

    // Otherwise create a pending payment record (existing behavior)
    // Determine payment type description
    let itemName = '';
    let description = '';
    // Normalize and support multiple front-end naming conventions for paymentType
    const normalizedType = (paymentType || '').toString();
    // Support legacy types ('due_payment','early_payment') and frontend types ('application_fee','first_repayment','full_settlement')
    if (['due_payment', 'first_repayment', 'application_fee'].includes(normalizedType)) {
      itemName = 'Loan Repayment (Due Date)';
      description = 'Repayment scheduled for due date';
    } else if (['early_payment', 'full_settlement'].includes(normalizedType)) {
      itemName = 'Loan Repayment (Early)';
      description = 'Early/full settlement payment';
    } else {
      return c.json({ success: false, error: 'Invalid payment type' }, 400);
    }

    const paymentData = {
      amount: amount,
      item_name: itemName,
      item_description: description,
      custom_str1: applicationId,
      custom_str2: userId,
      email_address: userEmail
    };

    const paymentRecord = {
      id: crypto.randomUUID(),
      userId,
      applicationId,
      amount,
      paymentType,
      status: 'pending',
      gatewayData: paymentData,
      createdAt: new Date().toISOString()
    };

    // TODO: Implement db.savePayment
    console.log('🔁 Pending payment created (SQL persistence pending):', paymentRecord.id);

    return c.json({ success: true, paymentId: paymentRecord.id, amount, paymentType, paymentUrl: null });
  } catch (error) {
    console.log('❌ Create payment error:', error);
    return c.json({ success: false, error: 'Failed to create payment' }, 500);
  }
});

// Get payment status
app.get('/make-server-1ed353c1/payment/:paymentId/status', requireAuth, async (c)=>{
  try {
    const userId = c.get('userId');
    const paymentId = c.req.param('paymentId');
    // TODO: Implement db.getPayment
    console.log(`Checking status for payment ${paymentId} (SQL lookup pending)`);
    return c.json({
      error: 'Payment status lookup temporarily unavailable during migration'
    }, 503);
  } catch (error) {
    console.log(`Get payment status error: ${error}`);
    return c.json({
      error: 'Failed to get payment status'
    }, 500);
  }
});

// Submit a payment claim (borrower initiated for manual bank payments or proof-based payments)
app.post('/make-server-1ed353c1/submit-payment-claim', requireAuth, async (c) => {
  try {
    const userId = c.get('userId');
    const { applicationId, paymentId, amount, paymentMethod, reference, documentId } = await c.req.json();

    if (!applicationId || !paymentMethod) {
      return c.json({ error: 'applicationId and paymentMethod are required' }, 400);
    }

    const application = await db.getApplication(applicationId);
    if (!application) {
      return c.json({ error: 'Application not found' }, 404);
    }
    if (application.userId !== userId) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    const claim = {
      id: crypto.randomUUID(),
      applicationId,
      paymentId: paymentId || null,
      userId,
      amount: amount || null,
      paymentMethod,
      reference: reference || null,
      documentId: documentId || null,
      status: 'submitted', // submitted, under_review, accepted, rejected
      createdAt: new Date().toISOString()
    };

    // TODO: Implement db.savePaymentClaim
    console.log(`Payment claim submitted for app ${applicationId} (SQL persistence pending)`);

    // Notify admins (simple log for now)
    const adminEmail = Deno.env.get('ADMIN_NOTIFICATION_EMAIL') || null;
    if (adminEmail) {
      console.log(`📧 Notification for payment claim queued to: ${adminEmail}`);
    }

    return c.json({ success: true, claim });
  } catch (error) {
    console.log('Submit payment claim error:', error);
    return c.json({ error: 'Failed to submit payment claim' }, 500);
  }
});

// Admin: list payment claims (optionally filter by applicationId)
app.get('/make-server-1ed353c1/admin/payment-claims', requireAdmin, async (c) => {
  try {
    const applicationId = c.req.query('applicationId') || null;
    // TODO: Implement db.getPaymentClaims(applicationId)
    console.log(`Fetching payment claims for ${applicationId || 'all'} (SQL lookup pending)`);
    return c.json({ claims: [] });
  } catch (err) {
    console.log('Get payment claims error:', err);
    return c.json({ error: 'Failed to get payment claims' }, 500);
  }
});

// Admin: verify (accept/reject) a payment claim. If accepted, record payment and mark application repaid.
app.post('/make-server-1ed353c1/admin/payment-claims/:id/verify', requireAdmin, async (c) => {
  try {
    const claimId = c.req.param('id');
    const { accept, notes } = await c.req.json();
    // TODO: Implement db.getPaymentClaim
    console.log(`Verifying payment claim ${claimId} (SQL lookup pending)`);
    
    return c.json({ error: 'Payment claim verification temporarily unavailable during migration' }, 503);
  } catch (err) {
    console.log('Verify payment claim error:', err);
    return c.json({ error: 'Failed to verify payment claim' }, 500);
  }
});

// Experian IDV Check
app.post('/make-server-1ed353c1/admin/verify-identity', requireAdmin, async (c) => {
  try {
    const { applicationId, identityNumber } = await c.req.json();
    
    if (!identityNumber || !applicationId) {
      return c.json({ error: 'Identity number and Application ID are required' }, 400);
    }

    // Configuration
    const url = "https://apis.experian.co.za/IDVService?wsdl";
    const username = Deno.env.get('EXPERIAN_INT_USERNAME');
    const password = Deno.env.get('EXPERIAN_INT_PASSWORD');
    const myOrigin = "DeniLoans";
    const version = "1.0";
    const identityType = "SID";
    const wantPhoto = "N";
    const wantAllowCache = "Y";

    // Construct the SOAP Envelope
    const soapEnvelope = `
      <soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:web="http://webservices.compuscan.co.za/">
        <soap:Header/>
        <soap:Body>
          <web:RequestIDVInfo>
            <Auth>
              <Username>${username}</Username>
              <Password>${password}</Password>
            </Auth>
            <SystemSettings>
              <Version>${version}</Version>
              <Origin>${myOrigin}</Origin>
            </SystemSettings>
            <SearchCriteria>
              <IdentityNumber>${identityNumber}</IdentityNumber>
              <IdentityType>${identityType}</IdentityType>
              <WantPhoto>${wantPhoto}</WantPhoto>
              <WantAllowCache>${wantAllowCache}</WantAllowCache>
            </SearchCriteria>
          </web:RequestIDVInfo>
        </soap:Body>
      </soap:Envelope>
    `;

    console.log(`Sending Experian IDV Request for ID: ${identityNumber}`);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'Content-Length': String(soapEnvelope.length),
        'SOAPAction': '""'
      },
      body: soapEnvelope
    });

    const responseText = await response.text();
    
    // Log the response for debugging
    console.log('Experian Response Status:', response.status);

    // Store the result in the application record
    const application = await db.getApplication(applicationId);
    if (application) {
      const updatedApplication = {
        ...application,
        idNumber: identityNumber, // Update the ID number in case it was corrected
        identityVerification: {
          verifiedAt: new Date().toISOString(),
          rawData: responseText,
          status: response.status
        }
      };
      await db.saveApplication(updatedApplication);
    }
    
    return c.json({
      success: true,
      status: response.status,
      data: responseText
    });

  } catch (error) {
    console.log(`Experian IDV error: ${error}`);
    return c.json({
      error: 'Failed to verify identity'
    }, 500);
  }
});

// Experian Get Credit Score
app.post('/make-server-1ed353c1/admin/get-credit-score', requireAdmin, async (c) => {
  try {
    const { applicationId, identityNumber } = await c.req.json();
    
    if (!identityNumber || !applicationId) {
      return c.json({ error: 'Identity number and Application ID are required' }, 400);
    }

    // Configuration
    const url = "https://apis.experian.co.za/GetPersonScore";
    const username = Deno.env.get('EXPERIAN_INT_USERNAME');
    const password = Deno.env.get('EXPERIAN_INT_PASSWORD');
    const myOrigin = "DeniLoans";
    const version = "1.0";
    const resultType = "json";

    // Construct the SOAP Envelope
    // Namespace must match the WSDL targetNamespace: http://services/
    const soapEnvelope = `
      <soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ser="http://services/">
        <soap:Header/>
        <soap:Body>
          <ser:getScore>
            <pUsername>${username}</pUsername>
            <pPassword>${password}</pPassword>
            <pMyOrigin>${myOrigin}</pMyOrigin>
            <pVersion>${version}</pVersion>
            <pResultType>${resultType}</pResultType>
            <pIdNumber>${identityNumber}</pIdNumber>
          </ser:getScore>
        </soap:Body>
      </soap:Envelope>
    `;

    console.log(`Sending Experian Credit Score Request for ID: ${identityNumber}`);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'Content-Length': String(soapEnvelope.length),
        'SOAPAction': '""'
      },
      body: soapEnvelope
    });

    const responseText = await response.text();
    
    // Log the response for debugging
    console.log('Experian Credit Score Response Status:', response.status);

    // Store the result in the application record
    const application = await db.getApplication(applicationId);
    if (application) {
      const updatedApplication = {
        ...application,
        creditScoreCheck: {
          checkedAt: new Date().toISOString(),
          rawData: responseText,
          status: response.status
        }
      };
      await db.saveApplication(updatedApplication);
    }

    return c.json({ 
      status: response.status,
      data: responseText
    });

  } catch (error) {
    console.error('Experian Credit Score Error:', error);
    return c.json({ error: 'Failed to get credit score' }, 500);
  }
});

// Experian Account Verification (AVS)
app.post('/make-server-1ed353c1/admin/account-verification', requireAdmin, async (c) => {
  try {
    const { applicationId } = await c.req.json();
    
    if (!applicationId) {
      return c.json({ error: 'Application ID is required' }, 400);
    }

    const application = await db.getApplication(applicationId);
    if (!application) {
       return c.json({ error: 'Application not found' }, 404);
    }

    // Split fullName into first_name and surname
    const names = (application.fullName || "").trim().split(" ");
    const surname = names.length > 1 ? names.pop() : "";
    const firstName = names.join(" ");
    const initials = firstName ? firstName.charAt(0).toUpperCase() : "";

    // Map Account Type
    // 1: Current/Cheque, 2: Savings, 3: Transmission, 4: Bond
    let accType = "1";
    const typeStr = (application.accountType || "").toLowerCase();
    if (typeStr.includes('saving')) accType = "2";
    else if (typeStr.includes('transmission')) accType = "3";
    else if (typeStr.includes('bond')) accType = "4";

    // Configuration
    const url = "https://apis-uat.experian.co.za/AVSService?wsdl";
    const username = Deno.env.get('EXPERIAN_UAT_USERNAME');
    const password = Deno.env.get('EXPERIAN_UAT_PASSWORD');
    const myOrigin = "DeniLoans";
    const version = "1.0";
    const submissionType = "RS";

    const dateCreated = new Date().toISOString().slice(0, 10).replace(/-/g, ''); // YYYYMMDD

    // 1. Generate the Inner XML (AVS_TRANSACTIONS)
    const innerXml = `
<AVS_TRANSACTIONS>
  <VERSION>1.0</VERSION>
  <DATE_CREATED>${dateCreated}</DATE_CREATED>
  <RECORDS>
    <RECORD num="1">
      <REF_NO_1>${application.id.substring(0, 30)}</REF_NO_1>
      <BANK_BRANCH_CD>${application.branchCode || "000000"}</BANK_BRANCH_CD>
      <BANK_ACC>${application.accountNumber || ""}</BANK_ACC>
      <BANK_ACC_TYPE>${accType || 1}</BANK_ACC_TYPE>
      <ID_NUMBER>${application.idNumber || ""}</ID_NUMBER>
      <INITIALS>${initials}</INITIALS>
      <SURNAME>${surname}</SURNAME>
      <EMAIL>${application.email || ""}</EMAIL>
      <PHONE_NUMBER>${application.phone || ""}</PHONE_NUMBER>
    </RECORD>
  </RECORDS>
</AVS_TRANSACTIONS>
`.trim();

    // 2. Construct the SOAP Envelope
    // Using the user's provided alternative structure and namespace
    const soapEnvelope = `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Header/>
  <soap:Body>
    <SubmitFile xmlns="http://webservices.experian.co.za/">
      <pUsername>${username}</pUsername>
      <pPassword>${password}</pPassword>
      <pMyOrigin>${myOrigin}</pMyOrigin>
      <pVersion>${version}</pVersion>
      <pSubmissionType>${submissionType}</pSubmissionType>
      <pWantEnhanced>Y</pWantEnhanced>
      <pFileContent><![CDATA[${innerXml}]]></pFileContent>
    </SubmitFile>
  </soap:Body>
</soap:Envelope>
`.trim();

    console.log(`Sending Experian Account Verification Request for App: ${applicationId}`);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'Content-Length': String(soapEnvelope.length),
        'SOAPAction': '"http://webservices.experian.co.za/SubmitFile"',
        'User-Agent': 'PHP-SOAP/7.0'
      },
      body: soapEnvelope
    });

    const responseText = await response.text();
    
    console.log('Experian AVS Response Status:', response.status);
    console.log('Experian AVS Response snippet:', responseText.substring(0, 200));

    // Store the result in the application record
    try {
      const updatedApplication = {
        ...application,
        accountVerification: {
          checkedAt: new Date().toISOString(),
          rawData: responseText,
          status: response.status
        }
      };
      await db.saveApplication(updatedApplication);
    } catch (dbError) {
      console.error('Failed to update DB store:', dbError);
    }

    return c.json({ 
      status: response.status,
      data: responseText
    });

  } catch (error) {
    console.error('Experian Account Verification Error:', error);
    return c.json({ error: 'Failed to verify account' }, 500);
  }
});
// Experian Financial Snapshot
app.post('/make-server-1ed353c1/admin/financial-snapshot', requireAdmin, async (c) => {
  try {
    const { applicationId, identityNumber } = await c.req.json();
    
    if (!identityNumber || !applicationId) {
      return c.json({ error: 'Identity number and Application ID are required' }, 400);
    }

    // Configuration
    const url = "https://apis-uat.experian.co.za/FinSnapService";
    const username = Deno.env.get('EXPERIAN_UAT_USERNAME');
    const password = Deno.env.get('EXPERIAN_UAT_PASSWORD');
    const myOrigin = "DeniLoans";
    const version = "1.0";

    // Construct the SOAP Envelope
    const soapEnvelope = `
      <soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:api="http://api.experian.co.za/">
        <soapenv:Header/>
        <soapenv:Body>
          <api:RequestNewFinSnap>
            <SystemSettings>
              <Version>${version}</Version>
              <OriginatingApplication>${myOrigin}</OriginatingApplication>
              <OriginatingEnvironment>UAT</OriginatingEnvironment>
              <ClientReference>${crypto.randomUUID()}</ClientReference>
              <RequestTime>${new Date().toISOString().split('.')[0]}</RequestTime>
            </SystemSettings>
            <SearchCriteria>
              <IdentityNumber>${identityNumber}</IdentityNumber>
              <IdentityType>SID</IdentityType>
              <ClientConsent>Y</ClientConsent>
              <WantCategory>N</WantCategory>
              <WantStatements>N</WantStatements>
              <Months>12</Months>
              <WantProcessedTransactions>Y</WantProcessedTransactions>
            </SearchCriteria>
          </api:RequestNewFinSnap>
        </soapenv:Body>
      </soapenv:Envelope>
    `;

    console.log(`Sending Experian Financial Snapshot Request for ID: ${identityNumber}`);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'Content-Length': String(soapEnvelope.length),
        'SOAPAction': '"http://api.experian.co.za/RequestNewFinSnap"',
        'Authorization': 'Basic ' + btoa(`${username}:${password}`)
      },
      body: soapEnvelope
    });

    const responseText = await response.text();
    
    // Log the response for debugging
    console.log('Experian Financial Snapshot Response Status:', response.status);

    // Store the result in the application record
    const application = await db.getApplication(applicationId);
    if (application) {
      const updatedApplication = {
        ...application,
        financialSnapshot: {
          checkedAt: new Date().toISOString(),
          rawData: responseText,
          status: response.status
        }
      };
      await db.saveApplication(updatedApplication);
    }
    
    return c.json({
      success: true,
      status: response.status,
      data: responseText
    });

  } catch (error) {
    console.log(`Experian Financial Snapshot error: ${error}`);
    return c.json({
      error: 'Failed to get financial snapshot'
    }, 500);
  }
});

console.log('⚡ Supabase Edge Function (make-server-1ed353c1) starting - routes registered');
Deno.serve(app.fetch);