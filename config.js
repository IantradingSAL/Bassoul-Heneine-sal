// ─────────────────────────────────────────────────────────────────
// Bassoul, Heneine Sal — Supabase configuration
// ─────────────────────────────────────────────────────────────────
export const SUPABASE_CONFIG = {
  url:     "https://egcbbfiqzaccsquaytvz.supabase.co",
  anonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVnY2JiZmlxemFjY3NxdWF5dHZ6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcxMDE1MzgsImV4cCI6MjA5MjY3NzUzOH0.2qLR3uLTE8C2tKSQUEV-9q2DF8Hrfad08UQoLv5Q72c"
}

// Bridge to make these readable from non-module scripts (access.js).
try { window.__SUPA__ = SUPABASE_CONFIG } catch (e) {}
