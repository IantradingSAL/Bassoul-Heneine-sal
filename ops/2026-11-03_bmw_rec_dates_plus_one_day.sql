-- 2026-11-03 — BMW reconciliation dates were stored ONE DAY EARLY.
--
-- warranty_bmw.html read the Incadea / SAP Excel files with cellDates:true,
-- which gives local-midnight dates, then stored them with toISOString() —
-- in Beirut (UTC+2/+3) that is the previous day. Checked against Incadea's
-- own exports: 1,211 / 1,215 warranty claims and 674 / 674 BSI claims are
-- exactly one day earlier in the database than in Incadea; invoice order
-- dates the same. The weekdays agree: stored claim / posting dates fall on
-- Sunday–Thursday and never on Friday — one day early for a Monday–Friday
-- workshop. Moves 37 claims and 36 invoices into the next month. The upload code is fixed in the same change; this moves
-- the rows already uploaded forward by one day and recomputes the month
-- each one is filed under (it is derived from that date).
--
-- Run it ONCE, BEFORE the fixed warranty_bmw.html goes live (rows uploaded
-- after that are already right). A marker in system_settings stops a
-- second run.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.system_settings WHERE key = 'fix_bmw_rec_dates_2026_11_03') THEN
    RAISE NOTICE 'already applied — nothing done';
    RETURN;
  END IF;

  UPDATE public.bmw_rec_submissions SET
    document_date               = document_date + 1,
    dealer_claim_submitted_date = dealer_claim_submitted_date + 1,
    created_on                  = created_on + 1,
    month = CASE WHEN document_date IS NOT NULL AND month = to_char(document_date, 'YYYY-MM')
                 THEN to_char(document_date + 1, 'YYYY-MM') ELSE month END;

  UPDATE public.bmw_rec_invoices SET
    order_date           = order_date + 1,
    posting_date         = posting_date + 1,
    initial_registration = initial_registration + 1,
    month = CASE WHEN posting_date IS NOT NULL AND month = to_char(posting_date, 'YYYY-MM')
                 THEN to_char(posting_date + 1, 'YYYY-MM') ELSE month END;

  -- Credits: only Repair Date came in as an Excel date. Credit Note Date was
  -- already right (8,209 of 8,533 fall on a Friday, BMW's crediting day), so
  -- it and the month filed from it stay as they are.
  UPDATE public.bmw_rec_credits SET repair_date = repair_date + 1;

  INSERT INTO public.system_settings (key, value, updated_at)
  VALUES ('fix_bmw_rec_dates_2026_11_03', 'bmw_rec_* dates moved +1 day', now());
END $$;
