/* Theme picker: <html data-theme>, remembered per device. The saved theme is
   applied by a tiny inline script in <head> (before paint); this file wires
   up the picker menus. */
(function () {
  var KEY = 'cbt-theme';
  var COLORS = { dark: '#080c14', light: '#f3f5fa', sepia: '#f3ead6', ocean: '#03151b' };

  function current() { return document.documentElement.getAttribute('data-theme') || 'dark'; }

  function apply(theme) {
    if (!COLORS[theme]) theme = 'dark';
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem(KEY, theme); } catch (e) { /* private mode: not remembered */ }
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', COLORS[theme]);
    document.querySelectorAll('.theme-opt').forEach(function (b) {
      b.setAttribute('aria-checked', b.getAttribute('data-set-theme') === theme ? 'true' : 'false');
    });
  }

  function closeAll(except) {
    document.querySelectorAll('.theme-picker.open').forEach(function (p) {
      if (p !== except) { p.classList.remove('open'); p.querySelector('.theme-btn').setAttribute('aria-expanded', 'false'); }
    });
  }

  document.addEventListener('click', function (e) {
    var btn = e.target.closest('.theme-btn');
    if (btn) {
      var picker = btn.closest('.theme-picker');
      closeAll(picker);
      var open = picker.classList.toggle('open');
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      return;
    }
    var opt = e.target.closest('.theme-opt');
    if (opt) { apply(opt.getAttribute('data-set-theme')); closeAll(); return; }
    if (!e.target.closest('.theme-menu')) closeAll();
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeAll(); });

  apply(current());
})();
