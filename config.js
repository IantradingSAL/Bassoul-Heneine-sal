// ─────────────────────────────────────────────────────────────────
// Cedarwings/Bassoul-Heneine — Supabase configuration
// ─────────────────────────────────────────────────────────────────
// Replace the two values below with your Supabase project credentials.
// Find them in Supabase dashboard → Settings → API:
//   • url:     "Project URL"
//   • anonKey: "anon public" key (NOT the service_role key)
//
// The anon key is safe to ship to the browser; Row Level Security
// in your database is what actually protects the data. Make sure
// RLS is enabled on every table.
// ─────────────────────────────────────────────────────────────────
export const SUPABASE_CONFIG = {
  url:     "https://YOUR-PROJECT-REF.supabase.co",
  anonKey: "YOUR-ANON-PUBLIC-KEY"
}

// Bridge to make these readable from non-module scripts (access.js).
// access.js cannot `import` from this module, but can read globals.
try { window.__SUPA__ = SUPABASE_CONFIG } catch (e) {}

