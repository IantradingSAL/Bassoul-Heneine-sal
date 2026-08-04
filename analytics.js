/* ============================================================
   analytics.js — PostHog wrapper
   Same file for both repos: Bassoul-Heneine-sal + wadi-el-sit-main-gate

   Usage (one line per page, before </body>):
     <script src="analytics.js?v=1" data-site="bassoul-heneine"></script>
     <script src="analytics.js?v=1" data-site="wadi-el-sit"></script>

   Optional: data-module="sandouk" to override the auto module name.
   Never blocks or breaks the page — all failures are swallowed.
   ============================================================ */
(function () {
  'use strict';

  // ---------- CONFIG (edit these two per repo) ----------
  var KEY  = 'phc_BbcFyCTvooUfNoXE9eTTWJjCNDjE8qL4iTU62XKXd5RJ';            // PostHog project API key — public by design, safe in git
  var REG  = 'us';                        // 'eu' or 'us' — must match your PostHog cloud region
  // Emails whose activity is NOT tracked (you, while testing)
  var IGNORE = ['imadaehn@gmail.com'];
  // Pages that display citizen / customer / financial data:
  // no session replay, no autocapture of text. Custom events only.
  var SENSITIVE_RE = /(sandouk|mrs|mrs-update|mrs-import|water-admin|water-finance|citizen|warranty|si-cloud|employee|user)/i;
  // ------------------------------------------------------

  var S      = document.currentScript;
  var SITE   = (S && S.dataset.site) || 'unknown';
  var MODULE = (S && S.dataset.module) ||
               ((location.pathname.split('/').pop() || 'index').replace(/\.html?$/i, '') || 'index');
  var SENSITIVE = SENSITIVE_RE.test(location.pathname);

  var API    = 'https://' + REG + '.i.posthog.com';
  var ASSETS = 'https://' + REG + '-assets.i.posthog.com';

  // Safe no-op API so pages can call track() even if PostHog never loads
  var queue = [];
  window.track = function (name, props) {
    try {
      if (window.posthog && window.posthog.__loaded) window.posthog.capture(name, props || {});
      else queue.push([name, props || {}]);
    } catch (e) {}
  };
  window.trackUser = function (user) {   // pass a Supabase user object
    try {
      if (!user || !user.email) return;
      if (IGNORE.indexOf(String(user.email).toLowerCase()) > -1) {
        if (window.posthog && window.posthog.opt_out_capturing) window.posthog.opt_out_capturing();
        return;
      }
      var md = user.user_metadata || {};
      if (window.posthog && window.posthog.__loaded) {
        window.posthog.identify(user.id, {
          email: user.email,
          role: md.role || md.user_role || null,
          site: SITE
        });
      }
    } catch (e) {}
  };
  window.trackLogout = function () {
    try { if (window.posthog && window.posthog.reset) window.posthog.reset(); } catch (e) {}
  };

  if (KEY.indexOf('REPLACE') > -1) return;   // not configured yet → stay a no-op

  var s = document.createElement('script');
  s.src = ASSETS + '/static/array.js';
  s.async = true;
  s.onerror = function () { /* blocked / offline — ignore, app keeps working */ };
  s.onload = function () {
    try {
      window.posthog.init(KEY, {
        api_host: API,
        ui_host: 'https://' + (REG === 'eu' ? 'eu' : 'us') + '.posthog.com',
        person_profiles: 'identified_only',      // anonymous visitors cost less / stay anonymous
        capture_pageview: true,
        capture_pageleave: true,
        autocapture: !SENSITIVE,                 // no blind click-text capture on data pages
        mask_all_element_attributes: true,
        mask_all_text: SENSITIVE,
        disable_session_recording: SENSITIVE,    // never record receipts, signatures, taxpayer data
        session_recording: {
          maskAllInputs: true,
          maskTextSelector: SENSITIVE ? '*' : '[data-ph-mask]'
        },
        persistence: 'localStorage+cookie',
        loaded: function (ph) {
          ph.register({ site: SITE, module: MODULE, pwa: window.matchMedia('(display-mode: standalone)').matches });
          var q = queue; queue = [];
          q.forEach(function (a) { try { ph.capture(a[0], a[1]); } catch (e) {} });
          // auto-identify if a Supabase client is already on the page
          try {
            var c = window.supabaseClient || window.sb || window.supa || window._sb;
            if (c && c.auth && c.auth.getUser) {
              c.auth.getUser().then(function (r) {
                if (r && r.data && r.data.user) window.trackUser(r.data.user);
              }).catch(function () {});
            }
          } catch (e) {}
        }
      });
    } catch (e) {}
  };
  document.head.appendChild(s);
})();
