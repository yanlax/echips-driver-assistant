// Кастомная шапка окна: свернуть/закрыть через Tauri API.
// Окно нерастягиваемое (resizable/maximizable: false в tauri.conf.json),
// поэтому кнопки "развернуть" и обработчика двойного клика здесь нет.
(function () {
  var getCurrentWindow = window.__TAURI__.window.getCurrentWindow;

  function mount() {
    var minBtn = document.getElementById("win-minimize");
    var closeBtn = document.getElementById("win-close");
    if (minBtn) minBtn.addEventListener("click", function () { getCurrentWindow().minimize(); });
    if (closeBtn) closeBtn.addEventListener("click", function () { getCurrentWindow().close(); });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }
})();
