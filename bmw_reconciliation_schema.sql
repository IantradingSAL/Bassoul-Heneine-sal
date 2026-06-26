-- ═══════════════════════════════════════════════════════════════════
--  BMW Warranty Reconciliation — schema for warranty_bmw.html (v3)
--  Run ONCE in the Supabase SQL editor for project egcbbfiqzaccsquaytvz.
--
--  Three dedicated tables, isolated from the existing bmw_* / warranty_bmw_*
--  systems so nothing else can break:
--    bmw_rec_invoices     ← incadea export      (one row per GAR invoice)
--    bmw_rec_submissions  ← Warranty + BSI sheet (one row per submission)
--    bmw_rec_credits      ← SAP credit-notes     (one row per credit line)
--
--  Link chain used by the page:
--    invoice.doc_no  =  submission.doc_no                    (GAR…)
--    submission.sub_key  =  credit.dcn_key                   (zero-stripped)
-- ═══════════════════════════════════════════════════════════════════

-- ── 1. Invoices (incadea) ──────────────────────────────────────────
create table if not exists public.bmw_rec_invoices (
  doc_no                  text primary key,          -- "No." e.g. GAR0277645
  make_code               text,                      -- BMW / BMW-MINI / BMW-MOT
  vin                     text,
  model                   text,
  sell_to_customer_name   text,
  bill_to_name            text,
  service_order_no        text,                      -- GOR…
  order_date              date,
  posting_date            date,
  initial_registration    date,
  total_labors            numeric default 0,         -- € (confirmed)
  total_parts             numeric default 0,         -- €
  total_ext               numeric default 0,         -- € (G/L + ext. service)
  total_invoiced          numeric default 0,         -- labors + parts + ext
  vehicle_mileage         integer,
  service_mileage         integer,
  service_posting_group   text,
  payment_method_code     text,
  own_sale                boolean,
  month                   text,                      -- YYYY-MM of posting_date
  file_name               text,
  uploaded_at             timestamptz default now()
);

-- ── 2. Submissions (Warranty + BSI) ────────────────────────────────
create table if not exists public.bmw_rec_submissions (
  id                      text primary key,          -- claim_kind || ':' || no
  claim_kind              text,                       -- 'warranty' | 'bsi'
  no                      text,                       -- "No." (70075 / SERVCON17784)
  make_code               text,
  status                  text,                       -- Cr. Memo Received / Sent / Refused…
  last_submission         text,                       -- raw (70084 / 513074)
  sub_key                 text,                       -- normalized: digits, no leading zeros
  vin                     text,
  license_no              text,
  doc_no                  text,                       -- Document No. = GAR invoice
  service_order_no        text,
  document_date           date,
  dealer_status           text,
  dealer_claim_submitted_date date,
  warranty_type           text,
  bill_to_customer_no     text,
  sell_to_customer_no     text,
  service_advisor         text,
  created_by              text,
  created_on              date,
  month                   text,                       -- YYYY-MM of document_date
  file_name               text,
  uploaded_at             timestamptz default now()
);
create index if not exists idx_bmw_rec_sub_key   on public.bmw_rec_submissions (sub_key);
create index if not exists idx_bmw_rec_sub_doc   on public.bmw_rec_submissions (doc_no);
create index if not exists idx_bmw_rec_sub_kind  on public.bmw_rec_submissions (claim_kind);

-- ── 3. Credit lines (SAP) ──────────────────────────────────────────
create table if not exists public.bmw_rec_credits (
  id                      text primary key,          -- cnn|item|pos|dcn
  credit_type             text,                       -- 'warranty' | 'bsi'
  dealer_claim_number     text,
  dcn_key                 text,                       -- normalized: digits, no leading zeros
  credit_note_number      text,
  credit_note_date        date,
  bmw_internal_claim      text,
  claimant                text,
  brand                   text,                       -- BMW CAR / MINI / BMW I
  vin                     text,
  repair_date             date,
  defect_code             text,
  defect_text             text,
  claim_item_number       text,
  claim_item_position     text,                       -- Labor Value / Spare Part… / External
  claim_item_type         text,                       -- FR / MAT / 00
  claim_item_description  text,
  manufacturer_no         text,                       -- part / manufacturer number (Spare Part lines)
  accepted_price_excl_hc  numeric default 0,
  hc                      numeric default 0,
  tax                     numeric default 0,
  accepted_price_incl_hc  numeric default 0,          -- the headline accepted € (incl HC, excl tax)
  accepted_price_incl_tax numeric default 0,
  claimed_price           numeric default 0,
  claimed_pct             numeric default 0,
  accepted_pct            numeric default 0,
  claimed_qty             numeric default 0,
  accepted_qty            numeric default 0,
  crediting_item_status   text,                       -- Success / Warning / Error
  crediting_status        text,
  most_decisive_message   text,
  collective_claim_ref    text,
  month                   text,                       -- YYYY-MM of credit_note_date
  file_name               text,
  uploaded_at             timestamptz default now()
);
create index if not exists idx_bmw_rec_cr_key    on public.bmw_rec_credits (dcn_key);
create index if not exists idx_bmw_rec_cr_cnn    on public.bmw_rec_credits (credit_note_number);
create index if not exists idx_bmw_rec_cr_status on public.bmw_rec_credits (crediting_item_status);

-- ── Row Level Security ─────────────────────────────────────────────
-- Permissive policies (any logged-in user can read/write), matching how
-- the rest of this internal app uses the anon key behind auth_guard.
-- Tighten later if you need per-role restrictions.
alter table public.bmw_rec_invoices    enable row level security;
alter table public.bmw_rec_submissions enable row level security;
alter table public.bmw_rec_credits     enable row level security;

do $$
declare t text;
begin
  foreach t in array array['bmw_rec_invoices','bmw_rec_submissions','bmw_rec_credits']
  loop
    execute format('drop policy if exists %I_all on public.%I;', t, t);
    execute format(
      'create policy %I_all on public.%I for all to anon, authenticated using (true) with check (true);',
      t, t);
  end loop;
end $$;

-- The page also reuses two existing tables (no changes needed):
--   warranty_uploads     — upload history (file_type: bmw_incadea / bmw_submission / bmw_credits)
--   warranty_bmw_resub   — resubmission / recovery tracking (keyed by orig_claim)
