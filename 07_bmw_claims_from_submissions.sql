-- 07_bmw_claims_from_submissions.sql — applied 2026-11-03.
-- Claim dates come from the Incadea claim submissions (bmw_rec_submissions):
-- the first warranty submission = warranty claim date, the first BSI one =
-- service claim date. BMW's answer (paid / cut / rejected) from the SAP credit
-- lines (bmw_rec_credits, crediting_item_status).

CREATE OR REPLACE FUNCTION public.bmw_order_claims(p_order text)
RETURNS TABLE (w date, b date)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT min(document_date) FILTER (WHERE claim_kind = 'warranty'),
         min(document_date) FILTER (WHERE claim_kind = 'bsi')
    FROM bmw_rec_submissions
   WHERE service_order_no = 'GOR0' || regexp_replace(coalesce(p_order, ''), '\D', '', 'g')
$$;
GRANT EXECUTE ON FUNCTION public.bmw_order_claims(text) TO authenticated;

-- Fill: also the claim dates, when still empty (trg_bmw_orders_fill runs before the guard).
CREATE OR REPLACE FUNCTION public.bmw_orders_fill_from_incadea()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE l record; vv record; n int; cl record;
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
  SELECT * INTO cl FROM public.bmw_order_claims(NEW.order_number);
  IF NEW.warranty_claim_date IS NULL AND cl.w IS NOT NULL THEN NEW.warranty_claim_date := cl.w; END IF;
  IF NEW.service_claim_date  IS NULL AND cl.b IS NOT NULL THEN NEW.service_claim_date  := cl.b; END IF;
  RETURN NEW;
END $$;

-- Guard: someone who is not a warranty admin still cannot type claim dates,
-- but the dates the claim submissions give are accepted.
CREATE OR REPLACE FUNCTION public.bmw_orders_guard()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE cl record;
BEGIN
  IF public.is_warranty_admin() THEN
    RETURN NEW;
  END IF;
  SELECT * INTO cl FROM public.bmw_order_claims(NEW.order_number);
  IF tg_op = 'INSERT' THEN
    NEW.pickup_date := NULL; NEW.return_date := NULL; NEW.warranty_note := NULL;
    NEW.warranty_claim_date := cl.w; NEW.service_claim_date := cl.b;
    RETURN NEW;
  END IF;
  IF NEW.pickup_date   IS DISTINCT FROM OLD.pickup_date
  OR NEW.return_date   IS DISTINCT FROM OLD.return_date
  OR NEW.warranty_note IS DISTINCT FROM OLD.warranty_note
  OR (NEW.warranty_claim_date IS DISTINCT FROM OLD.warranty_claim_date AND NEW.warranty_claim_date::date IS DISTINCT FROM cl.w)
  OR (NEW.service_claim_date  IS DISTINCT FROM OLD.service_claim_date  AND NEW.service_claim_date::date  IS DISTINCT FROM cl.b) THEN
    RAISE EXCEPTION 'Only a warranty admin can edit pick-up date, return date, warranty note, or claim dates';
  END IF;
  RETURN NEW;
END $function$;

-- New submissions fill the matching orders.
CREATE OR REPLACE FUNCTION public.bmw_orders_backfill_from_submission()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  IF NEW.service_order_no LIKE 'GOR0%' THEN
    UPDATE public.warranty_bmw_orders o SET order_date = o.order_date
     WHERE o.order_number = substr(NEW.service_order_no, 5)
       AND (o.warranty_claim_date IS NULL OR o.service_claim_date IS NULL);
  END IF;
  RETURN NULL;
END $$;
CREATE OR REPLACE TRIGGER trg_bmw_rec_submissions_backfill
  AFTER INSERT OR UPDATE ON public.bmw_rec_submissions
  FOR EACH ROW EXECUTE FUNCTION public.bmw_orders_backfill_from_submission();

-- BMW's answer per order and claim kind, for the orders page.
CREATE OR REPLACE VIEW public.bmw_order_claim_status AS
WITH s AS (
  SELECT substr(service_order_no, 5) AS order_number, claim_kind,
         array_agg(DISTINCT sub_key) FILTER (WHERE sub_key IS NOT NULL) AS keys,
         (array_agg(status ORDER BY document_date DESC NULLS LAST))[1] AS last_status
    FROM bmw_rec_submissions WHERE service_order_no LIKE 'GOR0%'
   GROUP BY 1, 2
),
c AS (
  SELECT s.order_number, s.claim_kind,
         bool_or(cr.crediting_item_status = 'Success') AS ok,
         bool_or(cr.crediting_item_status = 'Warning') AS cut,
         bool_or(cr.crediting_item_status = 'Error')   AS err,
         sum(cr.accepted_price_incl_hc) AS credited
    FROM s JOIN bmw_rec_credits cr ON cr.dcn_key = ANY (s.keys)
   GROUP BY 1, 2
)
SELECT s.order_number, s.claim_kind, s.last_status,
       CASE WHEN c.order_number IS NULL THEN 'at_bmw'
            WHEN c.err AND NOT coalesce(c.ok, false) AND NOT coalesce(c.cut, false) THEN 'rejected'
            WHEN c.cut OR c.err THEN 'cut'
            ELSE 'paid' END AS answer,
       c.credited
  FROM s LEFT JOIN c USING (order_number, claim_kind);
GRANT SELECT ON public.bmw_order_claim_status TO authenticated;

-- Fill the orders whose claims were already uploaded.
UPDATE public.warranty_bmw_orders o SET order_date = o.order_date
 WHERE (o.warranty_claim_date IS NULL OR o.service_claim_date IS NULL)
   AND EXISTS (SELECT 1 FROM public.bmw_rec_submissions s WHERE s.service_order_no = 'GOR0' || o.order_number);
