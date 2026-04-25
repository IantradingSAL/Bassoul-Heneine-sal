// lang.js — minimal i18n hook.
// Loaded by every page as a regular script. The real translator
// can be plugged in later; this stub just makes sure pages that
// reference window.cwLang don't throw, and toggles .en/.fr blocks
// based on a saved preference (defaulting to English).

(function () {
  var KEY = 'cw_lang'
  var lang
  try { lang = localStorage.getItem(KEY) || 'en' } catch (e) { lang = 'en' }

  function applyLang (l) {
    lang = (l === 'fr') ? 'fr' : 'en'
    try { localStorage.setItem(KEY, lang) } catch (e) {}
    document.documentElement.lang = lang
    document.querySelectorAll('.en').forEach(function (el) {
      el.style.display = (lang === 'en') ? '' : 'none'
    })
    document.querySelectorAll('.fr').forEach(function (el) {
      el.style.display = (lang === 'fr') ? '' : 'none'
    })
  }

  window.cwLang = {
    get:    function ()  { return lang },
    set:    function (l) { applyLang(l) },
    toggle: function ()  { applyLang(lang === 'en' ? 'fr' : 'en') }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { applyLang(lang) })
  } else {
    applyLang(lang)
  }
})()
