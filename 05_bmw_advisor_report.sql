-- 05_bmw_advisor_report.sql — monthly report per BMW service advisor.
-- Already applied to the Bassoul, Heneine Sal project (2026-11-03).
-- One row per (month of the order date, advisor). Claims come from the order
-- itself or from the Incadea claim submissions on the same GOR0 order; BMW's
-- answer from the SAP credit lines (Error = sent back, Warning = cut).
CREATE OR REPLACE FUNCTION public.bmw_advisor_monthly(p_from date DEFAULT NULL, p_to date DEFAULT NULL)
RETURNS TABLE (
  month text, advisor text,
  orders int, warranty int, service int, pending int,
  answered int, rejected int, cut int,
  returned int, picked_up int,
  days_to_claim_sum bigint, days_to_claim_n int
)
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $$
  WITH o AS (
    SELECT o.order_number,
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
           bool_or(true) AS answered,
           bool_or(cr.crediting_item_status = 'Error')   AS rejected,
           bool_or(cr.crediting_item_status = 'Warning') AS cut
      FROM s JOIN bmw_rec_credits cr ON cr.dcn_key = ANY (s.keys)
     GROUP BY 1
  ),
  x AS (
    SELECT o.*, COALESCE(o.wc, s.w) AS w, COALESCE(o.sc, s.b) AS b,
           COALESCE(c.answered, false) AS answered,
           COALESCE(c.rejected, false) AS rejected,
           COALESCE(c.cut, false) AS cut
      FROM o LEFT JOIN s USING (order_number) LEFT JOIN c USING (order_number)
  )
  SELECT to_char(d, 'YYYY-MM'), advisor,
         count(*)::int,
         count(*) FILTER (WHERE w IS NOT NULL)::int,
         count(*) FILTER (WHERE b IS NOT NULL)::int,
         count(*) FILTER (WHERE w IS NULL AND b IS NULL)::int,
         count(*) FILTER (WHERE answered)::int,
         count(*) FILTER (WHERE rejected)::int,
         count(*) FILTER (WHERE cut AND NOT rejected)::int,
         count(*) FILTER (WHERE return_date IS NOT NULL)::int,
         count(*) FILTER (WHERE pickup_date IS NOT NULL)::int,
         COALESCE(sum(LEAST(w, COALESCE(b, w)) - d) FILTER (WHERE w IS NOT NULL OR b IS NOT NULL), 0)::bigint,
         count(*) FILTER (WHERE w IS NOT NULL OR b IS NOT NULL)::int
    FROM x
   WHERE d IS NOT NULL
   GROUP BY 1, 2
   ORDER BY 1, 2
$$;
GRANT EXECUTE ON FUNCTION public.bmw_advisor_monthly(date, date) TO authenticated;
