-- 04_per_user_access.sql — per-person page access, landing page, default saved view.
-- Idempotent. Already applied to the Bassoul, Heneine Sal project (2026-11-03).

ALTER TABLE public.employees
  ADD COLUMN IF NOT EXISTS page_permissions jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS landing_page text;

COMMENT ON COLUMN public.employees.page_permissions IS
  'Per-person page access: { page_id: none|view|edit }. A page listed here replaces what the roles give for that page; a page not listed follows the roles.';
COMMENT ON COLUMN public.employees.landing_page IS
  'system_pages.id the person is sent to after signing in (NULL = dashboard).';

ALTER TABLE public.user_views
  ADD COLUMN IF NOT EXISTS is_default boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION public.effective_page_permission(p_uid uuid, p_page text)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  rec        RECORD;
  best_level int := 0;   -- 0=none, 1=view, 2=edit
  lvl_int    int;
  override   text;
BEGIN
  -- Built-in manager shortcut: managers always edit everywhere.
  IF EXISTS (
    SELECT 1 FROM public.employees e
     WHERE e.auth_user_id = p_uid
       AND COALESCE(e.is_active, true) = true
       AND e.role = 'manager'
  ) THEN
    RETURN 'edit';
  END IF;

  -- Per-person override: set on this employee alone, wins over the roles.
  SELECT e.page_permissions ->> p_page INTO override
    FROM public.employees e
   WHERE e.auth_user_id = p_uid
     AND COALESCE(e.is_active, true) = true
   LIMIT 1;
  IF override IN ('none', 'view', 'edit') THEN
    RETURN override;
  END IF;

  -- Otherwise the highest level across every role the employee holds.
  FOR rec IN
    SELECT rt.permissions ->> p_page AS lvl
      FROM public.employees e
      JOIN public.role_templates rt
        ON rt.name = e.role
        OR rt.name = e.custom_role
        OR (jsonb_typeof(e.extra_roles) = 'array' AND rt.name IN (
              SELECT jsonb_array_elements_text(e.extra_roles)))
     WHERE e.auth_user_id = p_uid
       AND COALESCE(e.is_active, true) = true
  LOOP
    lvl_int := CASE rec.lvl WHEN 'edit' THEN 2 WHEN 'view' THEN 1 ELSE 0 END;
    IF lvl_int > best_level THEN best_level := lvl_int; END IF;
  END LOOP;

  RETURN CASE best_level WHEN 2 THEN 'edit' WHEN 1 THEN 'view' ELSE 'none' END;
END;
$function$;

-- Where the signed-in person should land after login.
CREATE OR REPLACE FUNCTION public.my_landing_page()
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT e.landing_page FROM public.employees e
   WHERE e.auth_user_id = auth.uid()
     AND COALESCE(e.is_active, true) = true
   LIMIT 1
$function$;
GRANT EXECUTE ON FUNCTION public.my_landing_page() TO authenticated;
