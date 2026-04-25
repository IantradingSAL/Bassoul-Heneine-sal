// ═════════════════════════════════════════════════════════════════
//  admin-create-user — Supabase Edge Function
//  Bassoul, Heneine Sal customer-care platform
// ─────────────────────────────────────────────────────────────────
//  Why this exists:
//    Creating a Supabase auth user requires the SERVICE_ROLE key,
//    which can NEVER be exposed in browser code (it bypasses all
//    security and RLS). So the Settings page POSTs here, this
//    function verifies the caller is a manager, then uses the
//    service-role key (only accessible server-side as an env var)
//    to create the auth user.
//
//  Deploy:
//    Supabase dashboard → Edge Functions → Deploy a new function
//    → Via Editor → name it exactly  admin-create-user  → paste
//    this whole file → Deploy. No env vars to set: SUPABASE_URL,
//    SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY are auto-
//    injected by Supabase.
//
//  Security:
//    1. CORS allows any origin (browser-only API; calls are
//       authenticated by JWT).
//    2. Caller must send a valid Bearer JWT from a signed-in user.
//    3. That user must satisfy public.is_manager() — i.e. their
//       linked employee row has role='manager'.
// ═════════════════════════════════════════════════════════════════

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0'

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders })
  }
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed — POST only' }, 405)
  }

  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
    const ANON_KEY     = Deno.env.get('SUPABASE_ANON_KEY')
    const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    if (!SUPABASE_URL || !ANON_KEY || !SERVICE_KEY) {
      return json({ error: 'Function is missing environment variables' }, 500)
    }

    // ── 1. Caller authentication ──────────────────────────────
    const authHeader = req.headers.get('Authorization')
    if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) {
      return json({ error: 'Missing or malformed Authorization header' }, 401)
    }

    // Use the caller's JWT to verify they are a manager via RPC
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth:   { persistSession: false, autoRefreshToken: false },
    })
    const { data: isMan, error: imErr } = await userClient.rpc('is_manager')
    if (imErr)  return json({ error: 'Authorization check failed: ' + imErr.message }, 500)
    if (!isMan) return json({ error: 'Forbidden — only managers can create logins' }, 403)

    // ── 2. Validate input ─────────────────────────────────────
    let body: { email?: string; password?: string }
    try { body = await req.json() }
    catch { return json({ error: 'Body must be JSON' }, 400) }

    const email    = String(body.email    || '').trim().toLowerCase()
    const password = String(body.password || '')
    if (!email)              return json({ error: 'email is required' }, 400)
    if (!password)           return json({ error: 'password is required' }, 400)
    if (password.length < 6) return json({ error: 'Password must be at least 6 characters' }, 400)
    if (!/^\S+@\S+\.\S+$/.test(email)) return json({ error: 'Email looks invalid' }, 400)

    // ── 3. Create the auth user with the service-role key ─────
    const adminClient = createClient(SUPABASE_URL, SERVICE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    })

    const { data, error } = await adminClient.auth.admin.createUser({
      email,
      password,
      email_confirm: true, // auto-confirm so the user can sign in immediately
    })

    if (error) {
      // Common: 'A user with this email address has already been registered.'
      return json({ error: error.message }, 400)
    }
    if (!data?.user) {
      return json({ error: 'Auth user creation returned no user object' }, 500)
    }

    return json({
      user_id: data.user.id,
      email:   data.user.email,
      created: true,
    }, 200)
  } catch (e) {
    return json({ error: (e as Error).message || String(e) }, 500)
  }
})
