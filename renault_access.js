/* renault_access.js
 * Role-based access control for the Renault Warranty module.
 * Drop this one file into your repo and add to the <head> of BOTH
 * index.html and renault_warranty_v4.html:
 *
 *     <script src="renault_access.js"></script>
 *
 * No other markup changes needed.
 *
 * Behaviour:
 *   - Reads the logged-in role (cw_role, same key your app already uses).
 *   - If the role is a Service Advisor:
 *       * on the Renault Warranty page  -> redirect away to index.html
 *       * anywhere else (e.g. dashboard) -> hide every link/card that
 *         points to the Renault Warranty page.
 */
(function () {
  // ---- CONFIG -------------------------------------------------------------
  // Roles that are NOT allowed to access Renault Warranty.
  // Loose substring match, case-insensitive (matches "Service Advisor",
  // "service_advisor", "advisor", etc.).
  var BLOCKED_ROLE_KEYWORDS = ["advisor"];

  // Filename of the Renault Warranty page (used to detect the page and to
  // find links pointing to it). Change here if the file is renamed.
  var RENAULT_PAGE = "renault_warranty_v4.html";

  // Where to send a blocked user who tries to open the page directly.
  var REDIRECT_TO = "index.html";
  // ------------------------------------------------------------------------

  function getRole() {
    var r =
      localStorage.getItem("cw_role") ||
      sessionStorage.getItem("cw_role") ||
      "";
    return String(r).toLowerCase();
  }

  function isBlocked(role) {
    return BLOCKED_ROLE_KEYWORDS.some(function (kw) {
      return role.indexOf(kw) !== -1;
    });
  }

  var role = getRole();
  if (!isBlocked(role)) return; // allowed -> do nothing

  // Are we currently ON the Renault Warranty page?
  var onRenaultPage =
    window.location.pathname.toLowerCase().indexOf(RENAULT_PAGE.toLowerCase()) !==
    -1;

  if (onRenaultPage) {
    // Hard block: kick them back to the dashboard before content renders.
    window.location.replace(REDIRECT_TO);
    return;
  }

  // Otherwise (e.g. on the dashboard): hide any link/card to the page.
  function hideRenaultLinks() {
    var links = document.querySelectorAll(
      'a[href*="' + RENAULT_PAGE + '"]'
    );
    links.forEach(function (a) {
      // Hide the link AND its surrounding card/list-item if it has one,
      // so the whole module tile disappears, not just the text.
      var container =
        a.closest(".nav-link, .mod-card, .module-card, li, .card") || a;
      container.style.display = "none";
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", hideRenaultLinks);
  } else {
    hideRenaultLinks();
  }
})();
