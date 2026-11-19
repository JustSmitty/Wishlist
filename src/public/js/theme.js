// Runs before first paint (classic script, external so the CSP needs no
// inline allowance) to avoid a flash of the wrong theme.
(function () {
  try {
    var saved = localStorage.getItem('hushlist_theme');
    if (saved === 'light' || saved === 'dark') document.documentElement.dataset.theme = saved;
  } catch (e) { /* storage unavailable: follow the system */ }
})();
