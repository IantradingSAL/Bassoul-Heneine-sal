-- 08_bmw_advisor_orders.sql — the orders behind the Advisor Report, one row each
-- (order, VIN, customer, claims, BMW's answer, pick-up, return). Same reading as
-- bmw_advisor_monthly, so the list adds up to the report's figures.
-- Applied to the Bassoul, Heneine Sal project (2026-11-03).
CREATE OR REPLACE FUNCTION public.bmw_advisor_orders(p_from date DEFAULT NULL, p_to date DEFAULT NULL)
RETURNS TABLE (
  id bigint, month text, advisor text, order_number text, order_ref text,
  order_date date, vin text, customer text,
  warranty_date date, service_date date,
  answered boolean, rejected boolean, cut boolean,
  pickup_date date, return_date date, warranty_note text
)
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $$
  WITH o AS (
    SELECT o.id::bigint AS id, o.order_number, o.order_ref, o.vin, o.customer_name, o.warranty_note,
           COALESCE(o.order_date, o.work_date, o.created_at::date) AS d,
           COALESCE(NULLIF(trim(o.service_advisor), ''), '— not set —') AS advisor,
           o.warranty_claim_date::date AS wc, o.service_claim_date::date AS sc,
           o.pickup_date, o.return_date
      FROM warranty_bmw_orders o
     WHERE (p_from IS NULL OR COALESCE(o.order_date, o.work_date, o.created_at::date) >= p_from)
       AND (p_to   IS NULL OR COALESCE(o.order_date, o.work_date, o.created_at::date) <= p_to)
  ),
  s AS (
    SELECT substr(service_order_no, 5) AS order_number,
           min(document_date) FILTER (WHERE claim_kind = 'warranty') AS w,
           min(document_date) FILTER (WHERE claim_kind = 'bsi')      AS b,
           array_agg(DISTINCT sub_key) FILTER (WHERE sub_key IS NOT NULL) AS keys
      FROM bmw_rec_submissions
     WHERE service_order_no IN (SELECT 'GOR0' || order_number FROM o)
     GROUP BY 1
  ),
  c AS (
    SELECT s.order_number,
           bool_or(cr.crediting_item_status = 'Error')   AS rejected,
           bool_or(cr.crediting_item_status = 'Warning') AS cut
      FROM s JOIN bmw_rec_credits cr ON cr.dcn_key = ANY (s.keys)
     GROUP BY 1
  )
  SELECT o.id, to_char(o.d, 'YYYY-MM'), o.advisor, o.order_number,
         COALESCE(o.order_ref, 'GOR0' || o.order_number), o.d, o.vin, o.customer_name,
         COALESCE(o.wc, s.w), COALESCE(o.sc, s.b),
         c.order_number IS NOT NULL, COALESCE(c.rejected, false), COALESCE(c.cut, false) AND NOT COALESCE(c.rejected, false),
         o.pickup_date, o.return_date, o.warranty_note
    FROM o LEFT JOIN s USING (order_number) LEFT JOIN c USING (order_number)
   WHERE o.d IS NOT NULL
   ORDER BY o.d DESC, o.order_number DESC
$$;
GRANT EXECUTE ON FUNCTION public.bmw_advisor_orders(date, date) TO authenticated;
