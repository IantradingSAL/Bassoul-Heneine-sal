-- 09_warranty_uploads_bmw_types.sql — applied 2026-11-03.
-- Credits / Upload (warranty_bmw.html) logs its files as bmw_incadea,
-- bmw_submission and bmw_credits, but the check only allowed gcm / incadea /
-- bmw, so every BMW upload's history line was refused (HTTP 400, swallowed by
-- the page). The data itself was always saved; only the record of who uploaded
-- what, and when, was lost.
ALTER TABLE public.warranty_uploads DROP CONSTRAINT warranty_uploads_file_type_check;
ALTER TABLE public.warranty_uploads ADD CONSTRAINT warranty_uploads_file_type_check
  CHECK (file_type = ANY (ARRAY['gcm','incadea','bmw','bmw_incadea','bmw_submission','bmw_credits']));
