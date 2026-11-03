-- 06_bmw_order_lookup.sql — the order date comes from Incadea, the VIN from its
-- last characters, and the warranty admin's pick-up / send-back.
-- Applied to the Bassoul, Heneine Sal project (2026-11-03).

-- ── What Incadea already says about a GOR0 order ─────────────────────
-- The invoice uploads (Credits / Upload) carry each order's Order Date, VIN
-- and customer. Earliest order date wins; VIN/customer from the latest row.
CREATE OR REPLACE FUNCTION public.bmw_order_lookup(p_order text)
RETURNS TABLE (order_date date, vin text, customer text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  WITH k AS (SELECT 'GOR0' || regexp_replace(coalesce(p_order, ''), '\D', '', 'g') AS ref),
  src AS (
    SELECT r.order_date, upper(trim(r.vin)) AS vin, trim(r.sell_to_customer_name) AS c, r.posting_date AS seen
      FROM bmw_rec_invoices r, k WHERE r.service_order_no = k.ref
    UNION ALL
    SELECT b.order_date, upper(trim(coalesce(nullif(b.service_vin, ''), b.reference_vin))), trim(b.sell_to_customer_name), b.posting_date
      FROM bmw_invoices b, k WHERE b.service_order_no = k.ref
  )
  SELECT (SELECT min(s.order_date) FROM src s),
         (SELECT s.vin FROM src s WHERE coalesce(s.vin, '') <> '' ORDER BY s.seen DESC NULLS LAST LIMIT 1),
         (SELECT s.c   FROM src s WHERE coalesce(s.c, '')   <> '' ORDER BY s.seen DESC NULLS LAST LIMIT 1)
$$;
GRANT EXECUTE ON FUNCTION public.bmw_order_lookup(text) TO authenticated;

-- ── A VIN from its last characters (advisors type the last 7) ───────
-- Every place the system has seen a vehicle: orders, Incadea invoices,
-- BMW invoices, Service Inclusive vehicles. One row per VIN, newest first.
CREATE OR REPLACE FUNCTION public.bmw_vin_lookup(p_q text)
RETURNS TABLE (vin text, customer text, model text, last_seen date)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  WITH q AS (SELECT upper(regexp_replace(coalesce(p_q, ''), '\s', '', 'g')) AS s),
  src AS (
    SELECT upper(trim(o.vin)) v, trim(o.customer_name) c, NULL::text m, coalesce(o.order_date, o.created_at::date) d FROM warranty_bmw_orders o, q WHERE length(q.s) >= 5 AND upper(o.vin) LIKE '%' || q.s
    UNION ALL
    SELECT upper(trim(r.vin)), trim(r.sell_to_customer_name), r.model, coalesce(r.posting_date, r.order_date) FROM bmw_rec_invoices r, q WHERE length(q.s) >= 5 AND upper(r.vin) LIKE '%' || q.s
    UNION ALL
    SELECT upper(trim(coalesce(nullif(b.service_vin, ''), b.reference_vin))), trim(b.sell_to_customer_name), b.model, coalesce(b.posting_date, b.order_date) FROM bmw_invoices b, q WHERE length(q.s) >= 5 AND upper(coalesce(nullif(b.service_vin, ''), b.reference_vin)) LIKE '%' || q.s
    UNION ALL
    SELECT upper(trim(v.vin)), trim(v.customer_name), v.model, v.updated_at::date FROM si_vehicles v, q WHERE length(q.s) >= 5 AND upper(v.vin) LIKE '%' || q.s
  ),
  g AS (
    SELECT v,
           (array_agg(c ORDER BY d DESC NULLS LAST) FILTER (WHERE coalesce(c, '') <> ''))[1] AS c,
           (array_agg(m ORDER BY d DESC NULLS LAST) FILTER (WHERE coalesce(m, '') <> ''))[1] AS m,
           max(d) AS d
      FROM src WHERE coalesce(v, '') <> '' GROUP BY v
  )
  SELECT v, c, m, d FROM g ORDER BY d DESC NULLS LAST LIMIT 8
$$;
GRANT EXECUTE ON FUNCTION public.bmw_vin_lookup(text) TO authenticated;

-- ── The order date is Incadea's, not typed ───────────────────────────
-- On every new order (and every change by someone who is not a warranty
-- admin) the order date is the one Incadea gives, or stays empty until the
-- invoice upload brings it. VIN / customer are filled when left empty, and a
-- shortened VIN (the last 7) becomes the full one when it is unambiguous.
CREATE OR REPLACE FUNCTION public.bmw_orders_fill_from_incadea()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE l record; vv record; n int;
BEGIN
  SELECT * INTO l FROM public.bmw_order_lookup(NEW.order_number);
  IF TG_OP = 'INSERT' THEN
    IF NOT public.is_warranty_admin() OR NEW.order_date IS NULL THEN
      NEW.order_date := l.order_date;
    END IF;
  ELSE
    IF NOT public.is_warranty_admin() THEN
      NEW.order_date := coalesce(OLD.order_date, l.order_date);
    END IF;
    NEW.order_date := coalesce(NEW.order_date, l.order_date);
  END IF;
  IF coalesce(NEW.vin, '') = '' THEN NEW.vin := l.vin; END IF;
  IF coalesce(NEW.vin, '') <> '' AND length(NEW.vin) BETWEEN 5 AND 16 THEN
    SELECT count(*) INTO n FROM public.bmw_vin_lookup(NEW.vin);
    IF n = 1 THEN
      SELECT * INTO vv FROM public.bmw_vin_lookup(NEW.vin);
      NEW.vin := vv.vin;
      IF coalesce(NEW.customer_name, '') = '' THEN NEW.customer_name := vv.customer; END IF;
    END IF;
  END IF;
  IF coalesce(NEW.customer_name, '') = '' THEN NEW.customer_name := l.customer; END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE TRIGGER trg_bmw_orders_fill
  BEFORE INSERT OR UPDATE ON public.warranty_bmw_orders
  FOR EACH ROW EXECUTE FUNCTION public.bmw_orders_fill_from_incadea();

-- ── When an invoice upload arrives, the waiting orders get their data ──
CREATE OR REPLACE FUNCTION public.bmw_orders_backfill_from_invoice()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  IF NEW.service_order_no LIKE 'GOR0%' THEN
    UPDATE public.warranty_bmw_orders o SET order_date = o.order_date      -- the fill trigger does the rest
     WHERE o.order_number = substr(NEW.service_order_no, 5)
       AND (o.order_date IS NULL OR coalesce(o.vin, '') = '' OR coalesce(o.customer_name, '') = '');
  END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE TRIGGER trg_bmw_rec_invoices_backfill
  AFTER INSERT OR UPDATE ON public.bmw_rec_invoices
  FOR EACH ROW EXECUTE FUNCTION public.bmw_orders_backfill_from_invoice();
CREATE OR REPLACE TRIGGER trg_bmw_invoices_backfill
  AFTER INSERT OR UPDATE ON public.bmw_invoices
  FOR EACH ROW EXECUTE FUNCTION public.bmw_orders_backfill_from_invoice();

-- ── Pick-up per advisor and month, for the Advisor Report ────────────
CREATE OR REPLACE FUNCTION public.bmw_advisor_pickup(p_from date DEFAULT NULL, p_to date DEFAULT NULL)
RETURNS TABLE (month text, advisor text, picked int, waiting int, days_to_pickup_sum bigint, days_to_pickup_n int)
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $$
  WITH o AS (
    SELECT COALESCE(o.order_date, o.work_date, o.created_at::date) AS d,
           COALESCE(o.work_date, o.order_date, o.created_at::date) AS start_d,
           COALESCE(NULLIF(trim(o.service_advisor), ''), '— not set —') AS advisor,
           o.pickup_date, o.return_date
      FROM warranty_bmw_orders o
  )
  SELECT to_char(d, 'YYYY-MM'), advisor,
         count(*) FILTER (WHERE pickup_date IS NOT NULL)::int,
         count(*) FILTER (WHERE pickup_date IS NULL AND return_date IS NULL)::int,
         COALESCE(sum(GREATEST(pickup_date - start_d, 0)) FILTER (WHERE pickup_date IS NOT NULL AND start_d IS NOT NULL), 0)::bigint,
         count(*) FILTER (WHERE pickup_date IS NOT NULL AND start_d IS NOT NULL)::int
    FROM o
   WHERE d IS NOT NULL
     AND (p_from IS NULL OR d >= p_from) AND (p_to IS NULL OR d <= p_to)
   GROUP BY 1, 2
$$;
GRANT EXECUTE ON FUNCTION public.bmw_advisor_pickup(date, date) TO authenticated;

-- Claim dates from the claim submissions and BMW's answer per claim: see 07_bmw_claims_from_submissions.sql
