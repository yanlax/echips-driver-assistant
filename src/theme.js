// Переключатель темы. Тема хранится в localStorage и ставится на <html data-theme>.
// Подключается до отрисовки, чтобы не было вспышки тёмного фона на светлой теме.
(function () {
  var KEY = "echips-theme";
  var saved = null;
  try { saved = localStorage.getItem(KEY); } catch (e) {}
  var theme = saved === "light" || saved === "dark" ? saved : "dark";
  document.documentElement.setAttribute("data-theme", theme);

  var ICON = {
    dark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/></svg>',
    light: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.6v2.2M12 19.2v2.2M2.6 12h2.2M19.2 12h2.2M5.4 5.4l1.6 1.6M17 17l1.6 1.6M18.6 5.4L17 7M7 17l-1.6 1.6"/></svg>'
  };

  function apply(next) {
    theme = next;
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem(KEY, next); } catch (e) {}
    var root = document.querySelector(".theme-toggle");
    if (!root) return;
    root.querySelectorAll("button").forEach(function (b) {
      b.setAttribute("aria-pressed", String(b.dataset.theme === next));
    });
  }

  function mount() {
    var host = document.querySelector(".content");
    if (!host || host.querySelector(".theme-toggle")) return;
    var el = document.createElement("div");
    el.className = "theme-toggle";
    el.setAttribute("role", "group");
    el.setAttribute("aria-label", "Тема оформления");
    el.innerHTML =
      '<button type="button" data-theme="dark" title="Тёмная тема" aria-label="Тёмная тема">' + ICON.dark + "</button>" +
      '<button type="button" data-theme="light" title="Светлая тема" aria-label="Светлая тема">' + ICON.light + "</button>";
    el.addEventListener("click", function (e) {
      var btn = e.target.closest("button[data-theme]");
      if (btn) apply(btn.dataset.theme);
    });
    host.appendChild(el);
    apply(theme);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }
})();
