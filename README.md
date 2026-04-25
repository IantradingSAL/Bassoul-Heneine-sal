# Bassoul, Heneine Sal — Operations Platform

Customer feedback module + dashboard hub + role management, on Supabase.

## What changed in this drop

| File | Status | What it does |
|------|--------|-------------|
| **`settings.html`** | NEW | Role / user / permission management page (the main ask) |
| **`customer_feedback.html`** | UPDATED | "Doctor" relabelled as "Service VIN" everywhere in the UI; rebranded to Bassoul Heneine / IanTradingSAL |
| **`access.js`** | REWRITTEN | Now actually enforces page permissions (none / view / edit), not just a stub |
| **`config.js`** | UPDATED | Exposes `window.__SUPA__` so `access.js` (a classic script) can read the Supabase URL |
| **`03_schema_permissions.sql`** | NEW | Adds `role_templates.permissions` JSONB + `effective_page_permission()` SQL function + built-in `manager` / `employee` rows |
| `index.html`, `lang.js`, `table_sort.js`, `02_schema_supplement.sql` | unchanged | |

Already in place from earlier: `auth_guard.js`, `brevo.js`, `bulk_actions.js`, `csv_export.js`, `notify_assignment.js`, `user_views.js`, `01_schema.sql`.

---

## Setup steps

### 1. Run the SQL — three files, in order

In **Supabase SQL editor**:

1. `01_schema.sql` (already done if you ran the earlier drop)
2. `02_schema_supplement.sql` (already done if you ran the earlier drop)
3. **`03_schema_permissions.sql`** ← run this one now

All three are idempotent. The third file:
- Adds a `permissions` JSONB column to `role_templates`
- Inserts built-in `manager` and `employee` roles with sensible defaults
- Creates the `effective_page_permission(uid, page)` function that `access.js` calls

### 2. Drop the new files into the same folder

`settings.html`, `access.js`, `config.js`, `customer_feedback.html` (replace the old one), `03_schema_permissions.sql`. Keep all the other files from earlier alongside them.

### 3. Make sure `config.js` is filled in

Open it and replace the two placeholders with your Supabase URL + anon key.

### 4. Make yourself a manager

In Supabase → Authentication → Users → **Add user** (email + password). Then in the SQL editor:

```sql
INSERT INTO public.employees
  (name, username, email, role, auth_user_id, is_active, notification_prefs)
VALUES
  ('Imad',
   'imad',
   'imad@bashen.com',
   'manager',
   '00000000-0000-0000-0000-000000000000',  -- ← paste UUID from Authentication
   true,
   '{"email":true,"whatsapp":true,"sms":true}'::jsonb);
```

Now sign in at `index.html` and click ⚙️ **Settings** in the sidebar.

---

## How the role / permission system works

### The model

- **Employees** are people who log in. Each is linked to an `auth.users` row by `auth_user_id`.
- **Roles** describe what someone is allowed to do. Each role has a permission map: page → level.
- **Levels** are exactly three:
  - `edit` — full access (default behaviour)
  - `view` — page loads, but every input/button is disabled, anything tagged `class="editor-only"` is hidden, and a yellow "View-only" banner appears at the top
  - `none` — page is blocked; user is shown a "No access" notice and a link back to the dashboard
- Built-in roles:
  - **Manager** — always has `edit` everywhere, regardless of what's stored in `permissions`
  - **Employee** — defaults to `edit` on Customer Feedback, `view` on Warranty, `none` on Settings, `view` on Dashboard
- An employee can have a primary role + a custom role + extra roles. The highest level across all of them wins.

### Where the rules live

The single source of truth is the SQL function `effective_page_permission(uid, page)` in `03_schema_permissions.sql`. It walks every role membership the user has and returns the highest level. Both the client (`access.js`) and any future server-side RLS check call the same function.

### How to use the Settings page

**Employees tab** — list / add / edit / delete employee profiles.

**Roles & Access tab** — list of roles. Click a role to expand its permission matrix; click a pill (None / View / Edit) to change the level for that page. Saves immediately. The **+ Add role** button opens a modal for machine key, label, icon, and color.

**System tab** — Brevo (email + WhatsApp) and Twilio (SMS) credentials, plus sender info. Stored in `system_settings` and read by `brevo.js`.

### How a page identifies itself

Each authenticated page has a meta tag near the top:

```html
<meta name="cw-page" content="customer_feedback"/>
```

`access.js` reads this, calls the RPC, and acts on the level. To add a new page:

1. Give the page a `<meta name="cw-page" content="my_page"/>`.
2. Include the same scripts (`auth_guard.js`, `config.js`, `access.js`).
3. Tag editor-only inputs / buttons with `class="editor-only"`.
4. In Settings → Roles, add `my_page` to the `PAGES` array near the top of `settings.html`'s `<script>` block.

### IMPORTANT: this is UX-level enforcement

`access.js` disables form controls and hides buttons in the browser. A determined user with dev tools open can re-enable them. **For real security, enable Row Level Security on every table** and write policies that call `effective_page_permission()`:

```sql
ALTER TABLE public.customer_feedback ENABLE ROW LEVEL SECURITY;

CREATE POLICY "view feedback if allowed"
  ON public.customer_feedback FOR SELECT
  TO authenticated
  USING (public.effective_page_permission(auth.uid(), 'customer_feedback') IN ('view','edit'));

CREATE POLICY "edit feedback if allowed"
  ON public.customer_feedback FOR INSERT
  TO authenticated
  WITH CHECK (public.effective_page_permission(auth.uid(), 'customer_feedback') = 'edit');

CREATE POLICY "update feedback if allowed"
  ON public.customer_feedback FOR UPDATE
  TO authenticated
  USING (public.effective_page_permission(auth.uid(), 'customer_feedback') = 'edit')
  WITH CHECK (public.effective_page_permission(auth.uid(), 'customer_feedback') = 'edit');
```

Repeat for the other tables — generally only managers should be allowed to write to `employees`, `role_templates`, `system_settings`.

---

## Customer Feedback — Doctor → Service VIN

The "Doctor" field is now **Service VIN**, with:

- A 17-character VIN input (`maxlength=17`, auto-uppercase)
- Placeholder `"Vehicle VIN (17 chars, optional)"`
- View-modal label updated to "Service VIN"
- Follow-up note placeholder reworded for vehicle service language

**The underlying database column is still named `doctor`** — that's intentional, so existing data and other code that touches the column don't break. The UI just relabels it. Tell me if you'd rather rename the column to `service_vin` and I'll provide the migration SQL.

The PROTOCOLS object inside `customer_feedback.html` (the smart guidance text per complaint category) still has dental-aligner wording — fitting / Bloom Cases / ISO 13485 etc. That wasn't part of this request; flag it when you want a vehicle-service rewrite.

---

## Troubleshooting

| Symptom | Cause |
|--------|-------|
| Settings page says "Could not load roles" | `03_schema_permissions.sql` not run, or RLS denies SELECT on `role_templates`. |
| Saving a role fails with "permission denied" | RLS is on but no write policy exists. Either disable RLS on `role_templates` for now, or add a manager-only INSERT/UPDATE policy. |
| User signs in but Settings shows "No access" | Their `employees.role` is not `manager`. Either change it, or set their custom role's `settings` permission to `view` or `edit`. |
| Right role but still "No access" | `auth_user_id` on the employee row doesn't match `auth.users.id`. Re-paste from Supabase → Authentication → Users. |
| Yellow "View-only" banner appears for managers | `is_manager()` matches `employees.role = 'manager'` exactly — check for typos / whitespace. |
| Permission change not picked up | `access.js` evaluates once on page load. Refresh the page (no full sign-out needed). |
