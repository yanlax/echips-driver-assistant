// Echips Driver Assistant — фронтенд-логика.
// Все системные операции (WMI, Yandex Disk, pnputil) выполняются в Rust,
// сюда приходят только результаты через invoke().

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const { open } = window.__TAURI__.shell;
const { getCurrentWindow } = window.__TAURI__.window;
const notification = window.__TAURI__.notification;

function closeApp() {
  getCurrentWindow().close();
}

// ============================================================================
//  НАСТРОЙКИ
// ============================================================================
const MANIFEST_PUBLIC_URL = "https://disk.360.yandex.ru/d/79yQHBN93UDZGg";
const SUPPORT_URL = "https://echips.ru/support";

// Проверка обновлений: ссылка на version.json на Yandex Disk с полями
// {"latest_version": "1.1.0", "download_url": "https://echips.ru/download"}
const APP_VERSION = "5.0.0";
const VERSION_CHECK_URL = "https://disk.360.yandex.ru/d/Oo_eBt5Ddv39Rg";

const MIN_FREE_MB_HINT = 500; // должно совпадать с MIN_FREE_MB в main.rs, только для текста подсказки

const screen = document.getElementById("screen");

let state = {
  systemInfo: null,
  manifest: null,
  manifestEntry: null,
  universalEntry: null,
  universalFiles: [],
  filesToDownload: [],
  mode: null,
  autoDetectedKey: null,
  createRestorePoint: true, // чекбокс на экране подтверждения, включён по умолчанию
  installQueueLabels: [],
  doneIndices: new Set(),
};

// ============================================================================
//  Иконки категорий (для универсального набора)
// ============================================================================
function categoryIcon(name) {
  const n = name.toLowerCase();
  const icons = {
    net: '<circle cx="12" cy="12" r="1.6"/><path d="M5 15a10 10 0 0 1 14 0M8 11.5a6 6 0 0 1 8 0" fill="none" stroke="currentColor" stroke-width="1.6"/>',
    media: '<path d="M6 10h3l4-3v10l-4-3H6z"/><path d="M16 9a4 4 0 0 1 0 6" fill="none" stroke="currentColor" stroke-width="1.6"/>',
    bluetooth: '<path d="M8 7l8 6-5 4V3l5 4-8 6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>',
    display: '<rect x="4" y="5" width="16" height="11" rx="1" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M9 19h6M12 16v3" stroke="currentColor" stroke-width="1.6"/>',
    system: '<rect x="7" y="7" width="10" height="10" rx="1" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M9 4v3M15 4v3M9 17v3M15 17v3M4 9h3M4 15h3M17 9h3M17 15h3" stroke="currentColor" stroke-width="1.4"/>',
    hidclass: '<circle cx="12" cy="9" r="2.4" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M6 19c0-3 3-5 6-5s6 2 6 5" fill="none" stroke="currentColor" stroke-width="1.6"/>',
    biometric: '<path d="M12 4a7 7 0 0 1 7 7c0 3 -1 5 -1 7M6 17c1-2 1-4 1-6a5 5 0 0 1 10 0c0 1 0 2-.3 3M9 20c1-2 1-4 1-6.2a2 2 0 0 1 4 0" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>',
    screaders: '<rect x="4" y="7" width="16" height="10" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.6"/><rect x="7" y="10" width="4" height="3" fill="currentColor"/>',
    usb: '<circle cx="12" cy="6" r="1.6"/><path d="M12 8v8M12 12h4a2 2 0 0 0 2-2V9M8 12v3a2 2 0 0 0 2 2h2" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="18" cy="9" r="1.4" fill="none" stroke="currentColor" stroke-width="1.4"/>',
    image: '<rect x="4" y="8" width="16" height="10" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="12" cy="13" r="3" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M9 8l1.5-2h3L15 8" fill="none" stroke="currentColor" stroke-width="1.6"/>',
    audioprocessingobject: '<path d="M4 12h2l1.5-5 2 10 2-14 2 14 1.5-9 2 4h2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>',
    softwarecomponent: '<rect x="5" y="5" width="7" height="7" rx="1" fill="none" stroke="currentColor" stroke-width="1.6"/><rect x="12" y="12" width="7" height="7" rx="1" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M12 8.5h4M8.5 12v4" stroke="currentColor" stroke-width="1.4"/>',
  };
  for (const key in icons) {
    if (n.includes(key)) {
      return `<svg viewBox="0 0 24 24" width="16" height="16">${icons[key]}</svg>`;
    }
  }
  return `<svg viewBox="0 0 24 24" width="16" height="16"><rect x="5" y="5" width="14" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>`;
}

function hexSvg(spin) {
  return `<div class="hex ${spin ? "spin" : ""}"><svg viewBox="0 0 80 80">
    <polygon class="track" points="40,4 72,22 72,58 40,76 8,58 8,22"/>
    <polygon class="fill" points="40,4 72,22 72,58 40,76 8,58 8,22"/>
  </svg></div>`;
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

// ============================================================================
//  Проверка обновлений (не блокирует основной поток)
// ============================================================================
function compareVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

async function checkForUpdate() {
  if (VERSION_CHECK_URL.includes("ЗАМЕНИТЕ")) return; // ссылка ещё не настроена
  try {
    const info = await invoke("fetch_public_json", { publicUrl: VERSION_CHECK_URL });
    if (info && info.latest_version && compareVersions(info.latest_version, APP_VERSION) > 0) {
      showUpdateBanner(info);
    }
  } catch (e) {
    // Тихо игнорируем — проверка обновлений не должна мешать основному сценарию
  }
}

/**
 * Баннер обновления. Временное решение, пока нет отдельной страницы
 * загрузки на сайте: если в version.json указан yandex_public_key —
 * новая версия скачивается напрямую с того же Yandex Disk (тем же
 * механизмом, что и драйверы) прямо в папку "Загрузки", с прогресс-баром.
 * Если yandex_public_key не указан — используется старое поведение:
 * просто открыть download_url в браузере.
 */
function showUpdateBanner(info) {
  const banner = document.getElementById("update-banner");
  const useDirectDownload = !!info.yandex_public_key;

  banner.innerHTML = `
    <span id="update-banner-text">Доступна новая версия ${escapeHtml(info.latest_version)}</span>
    <div style="display:flex; gap:10px; align-items:center;">
      <button class="btn-link" id="update-download-link">Скачать</button>
      <button class="btn-link" id="update-dismiss-link">×</button>
    </div>`;
  banner.style.display = "flex";

  document.getElementById("update-dismiss-link").onclick = () => { banner.style.display = "none"; };

  document.getElementById("update-download-link").onclick = async () => {
    if (!useDirectDownload) {
      open(info.download_url);
      return;
    }

    const textEl = document.getElementById("update-banner-text");
    const btnEl = document.getElementById("update-download-link");
    btnEl.style.pointerEvents = "none";

    const unlisten = await listen("update-progress", (event) => {
      const p = event.payload;
      if (p.total > 0) {
        const mbDone = (p.downloaded / (1024 * 1024)).toFixed(1);
        const mbTotal = (p.total / (1024 * 1024)).toFixed(1);
        textEl.textContent = `Загрузка обновления... ${mbDone} / ${mbTotal} МБ`;
      }
    });

    try {
      const fileName = info.file_name || "EchipsDriverAssistant.exe";
      const savedPath = await invoke("download_update", {
        yandexPublicKey: info.yandex_public_key,
        path: info.path || null,
        fileName,
      });
      unlisten();
      textEl.textContent = "Скачано — открываю папку...";
      await invoke("reveal_in_explorer", { path: savedPath });
      setTimeout(() => { banner.style.display = "none"; }, 1500);
    } catch (e) {
      unlisten();
      textEl.textContent = "Не удалось скачать обновление";
      btnEl.style.pointerEvents = "";
    }
  };
}

// ============================================================================
//  Уведомления
// ============================================================================
async function notifyCompletion(title, body) {
  try {
    let granted = await notification.isPermissionGranted();
    if (!granted) {
      const permission = await notification.requestPermission();
      granted = permission === "granted";
    }
    if (granted) {
      notification.sendNotification({ title, body });
    }
  } catch (e) {
    // Уведомления необязательны — тихо игнорируем при отсутствии поддержки
  }
}

// ============================================================================
//  Экраны
// ============================================================================

function showLoading(text) {
  screen.innerHTML = `
    <div class="hexwrap">
      ${hexSvg(true)}
      <div class="statusline">${text}<span class="cursor"></span></div>
    </div>`;
}

function showError(text, backAction) {
  screen.innerHTML = `
    <div class="resultwrap is-error">
      <div style="font-size:28px; color:var(--err);">⚠</div>
      <div class="resulttext">${escapeHtml(text)}</div>
      <div style="display:flex; gap:16px; margin-top:4px;">
        ${backAction ? '<button class="btn-link" id="back-link">Назад</button>' : ""}
        <button class="btn-link" id="support-link">Написать в поддержку</button>
      </div>
    </div>`;
  document.getElementById("support-link").onclick = () => open(SUPPORT_URL);
  if (backAction) {
    document.getElementById("back-link").onclick = backAction;
  }
}

function showModelSelection(autoDetectedKey = state.autoDetectedKey) {
  const groups = buildModelGroups(state.manifest, autoDetectedKey);

  const autoGroup = groups.find((g) => g.isAuto);
  const title = autoGroup ? autoGroup.combinedName : "Выберите модель из списка";
  const eyebrow = autoDetectedKey
    ? "Модель определена автоматически"
    : "Модель не определена автоматически";

  screen.innerHTML = `
    <div class="eyebrow">${eyebrow}</div>
    <div class="modelname" style="font-size:19px;">${escapeHtml(title)}</div>
    <input type="text" id="model-search" class="search-input" placeholder="Поиск модели...">
    <div class="modellist" id="model-list">
      ${groups.map((g, i) => `
        <label class="modelrow ${g.isAuto ? "rec" : ""}" data-search="${escapeHtml((g.combinedName + " " + g.keys.join(" ")).toLowerCase())}">
          <input type="radio" name="m" value="${i}" ${i === 0 ? "checked" : ""}>
          ${escapeHtml(g.combinedName)}
          ${g.isAuto ? '<span class="tag">★ ОПРЕДЕЛЕНО АВТОМАТИЧЕСКИ</span>' : ""}
        </label>`).join("")}
    </div>
    <div class="actions" style="justify-content:space-between; align-items:center;">
      <button class="btn-link" id="universal-link">Не нашли модель? Универсальный набор →</button>
      <button class="btn btn-primary" id="select-btn">Выбрать</button>
    </div>`;

  document.getElementById("model-search").addEventListener("input", (e) => {
    const query = e.target.value.trim().toLowerCase();
    document.querySelectorAll("#model-list .modelrow").forEach((row) => {
      const matches = !query || row.dataset.search.includes(query);
      row.style.display = matches ? "" : "none";
    });
  });

  document.getElementById("select-btn").onclick = () => {
    const checked = document.querySelector('input[name="m"]:checked');
    if (!checked) return;
    const group = groups[parseInt(checked.value, 10)];
    // Если автоопределённый код входит в эту группу — используем именно его
    // (для точности), иначе берём первый ключ группы — ссылка всё равно
    // одна и та же для всех кодов внутри группы.
    const key = group.keys.includes(autoDetectedKey) ? autoDetectedKey : group.keys[0];
    state.manifestEntry = { key, entry: state.manifest[key], combinedName: group.combinedName };
    state.mode = "model";
    showConfirmation();
  };
  document.getElementById("universal-link").onclick = openUniversalPicker;
}

/**
 * Группирует модели по ОДИНАКОВОЙ ссылке на драйверы (yandex_public_key) —
 * если несколько кодов физически используют один и тот же пакет драйверов,
 * они показываются одной строкой с комбинированным названием вида
 * "Taganay NB156D / NB156D-H", а не дублируются по списку.
 */
function buildModelGroups(manifest, autoDetectedKey) {
  const keys = Object.keys(manifest).filter((k) => !k.startsWith("_"));

  const linkToKeys = new Map();
  for (const key of keys) {
    const link = manifest[key].yandex_public_key;
    if (!linkToKeys.has(link)) linkToKeys.set(link, []);
    linkToKeys.get(link).push(key);
  }

  const groups = [];
  for (const groupKeys of linkToKeys.values()) {
    groups.push({
      keys: groupKeys,
      combinedName: combineDisplayNames(groupKeys, manifest),
      isAuto: autoDetectedKey ? groupKeys.includes(autoDetectedKey) : false,
    });
  }

  groups.sort((a, b) => {
    if (a.isAuto !== b.isAuto) return a.isAuto ? -1 : 1;
    return a.combinedName.localeCompare(b.combinedName);
  });
  return groups;
}

/**
 * Пытается объединить несколько display_name в одну строку, убирая
 * повторяющуюся часть (обычно название линейки) и оставляя только коды
 * через " / ": "Taganay NB156D" + "Taganay NB156D-H" -> "Taganay NB156D / NB156D-H".
 * Если общей части не нашлось — просто перечисляет полные названия через " / ".
 */
function combineDisplayNames(keys, manifest) {
  if (keys.length === 1) {
    return manifest[keys[0]].display_name || keys[0];
  }

  const lines = keys.map((k) => {
    const dn = manifest[k].display_name || k;
    return dn.endsWith(k) ? dn.slice(0, dn.length - k.length).trim() : null;
  });

  const commonLine = lines[0];
  const allSameLine = commonLine && lines.every((l) => l === commonLine);

  if (allSameLine) {
    return `${commonLine} ${keys.join(" / ")}`;
  }
  return keys.map((k) => manifest[k].display_name || k).join(" / ");
}

function showUniversalCategoryPicker() {
  const autoMatchedNames = new Set();
  const classes = new Set(state.systemInfo.problem_devices.map((d) => d.class).filter(Boolean));
  for (const cls of classes) {
    const found = state.universalFiles.find(([name]) => name.toLowerCase().includes(cls.toLowerCase()));
    if (found) autoMatchedNames.add(found[0]);
  }

  screen.innerHTML = `
    <div class="eyebrow">Универсальный набор драйверов</div>
    <div class="modelname" style="font-size:19px;">Выберите категории для установки</div>
    ${classes.size > 0
      ? `<div style="font-size:12px; color:var(--text-dim); margin-bottom:14px;">
           Отмечены категории, соответствующие найденным проблемным устройствам —
           при желании выберите другие вручную.</div>`
      : `<div style="font-size:12px; color:var(--text-dim); margin-bottom:14px;">
           Явных ошибок не найдено — можно установить любые категории вручную.</div>`}
    <div class="catlist" id="cat-list">
      ${state.universalFiles.map(([name, path], i) => `
        <label class="catrow">
          <input type="checkbox" name="cat" value="${i}" ${autoMatchedNames.has(name) ? "checked" : ""}>
          <span class="cat-icon">${categoryIcon(name)}</span>
          ${escapeHtml(name.replace(/\.zip$/i, ""))}
          ${autoMatchedNames.has(name) ? '<span class="badge">НАЙДЕНО СОВПАДЕНИЕ</span>' : ""}
        </label>`).join("")}
    </div>
    <div class="actions" style="justify-content:space-between; align-items:center;">
      <button class="btn-link" id="back-link">← Назад</button>
      <button class="btn btn-primary" id="confirm-cats-btn">Далее</button>
    </div>`;

  document.getElementById("back-link").onclick = () => showModelSelection();
  document.getElementById("confirm-cats-btn").onclick = () => {
    const checked = [...document.querySelectorAll('input[name="cat"]:checked')];
    if (checked.length === 0) return;
    state.filesToDownload = checked.map((el) => state.universalFiles[parseInt(el.value, 10)]);
    state.mode = "universal";
    showConfirmation();
  };
}

function showConfirmation() {
  const devices = state.systemInfo.problem_devices;
  let modelBlock;
  if (state.mode === "model") {
    const displayName = state.manifestEntry.combinedName || state.manifestEntry.entry.display_name || state.manifestEntry.key;
    modelBlock = `
      <div class="eyebrow">Модель</div>
      <div class="modelname">${escapeHtml(displayName)}</div>`;
  } else {
    modelBlock = `
      <div class="eyebrow">Универсальный набор</div>
      <div class="modelname" style="font-size:19px;">Выбранные категории драйверов</div>`;
  }

  let devicesBlock;
  if (devices.length > 0) {
    devicesBlock = `
      <div style="font-size:13px; color:var(--text); margin-bottom:8px;">
        Найдено устройств без драйверов: ${devices.length}
      </div>
      <div class="devlist">
        ${devices.map((d) => `
          <div class="devrow"><span class="dot"></span>${escapeHtml(d.friendly_name)}
          <span class="cls">${escapeHtml(d.class)}</span></div>`).join("")}
      </div>`;
  } else if (state.mode === "model") {
    devicesBlock = `
      <div class="empty">Явных ошибок с драйверами не найдено — но вы всё равно можете
      установить полный пакет драйверов для этой модели.</div>`;
  } else {
    devicesBlock = "";
  }

  let filesBlock = "";
  if (state.mode === "universal" && state.filesToDownload.length > 0) {
    const names = state.filesToDownload.map(([name]) => name).join(", ");
    filesBlock = `
      <div style="font-size:12px; color:var(--text-dim); margin-bottom:2px;">Будут установлены пакеты:</div>
      <div style="font-size:13px; color:var(--text); margin-bottom:10px;">${escapeHtml(names)}</div>`;
  }

  screen.innerHTML = `
    ${modelBlock}
    ${devicesBlock}
    ${filesBlock}
    <label class="restore-toggle">
      <input type="checkbox" id="restore-checkbox" ${state.createRestorePoint ? "checked" : ""}>
      Создать точку восстановления системы перед установкой
    </label>
    <div class="actions" style="justify-content:space-between;">
      <button class="btn-link" id="back-link">← Назад</button>
      <button class="btn btn-primary" id="install-btn">Скачать и установить</button>
    </div>`;

  document.getElementById("restore-checkbox").addEventListener("change", (e) => {
    state.createRestorePoint = e.target.checked;
  });
  document.getElementById("install-btn").onclick = startInstall;
  document.getElementById("back-link").onclick = () => {
    if (state.mode === "universal") {
      showUniversalCategoryPicker();
    } else {
      showModelSelection();
    }
  };
}

function showProgress() {
  const items = state.mode === "model"
    ? [state.manifestEntry.combinedName || state.manifestEntry.entry.display_name || state.manifestEntry.key]
    : state.filesToDownload.map(([name]) => name);
  state.installQueueLabels = items;
  state.doneIndices = new Set();

  screen.innerHTML = `
    <div class="progwrap">
      ${hexSvg(false)}
      <div style="width:100%;">
        <div class="stage" id="stage-label" style="margin-bottom:10px;">Подготовка...</div>
        <div class="bar"><div class="fill" id="progress-bar"></div></div>
        <div class="mbtext" id="progress-mb" style="margin-top:8px;"></div>
        ${items.length > 1 ? `<div class="filecheck-list" id="filecheck-list">
          ${items.map((name, i) => `
            <div class="filecheck-row" id="filecheck-${i}">
              <span class="filecheck-icon">○</span> ${escapeHtml(name)}
            </div>`).join("")}
        </div>` : ""}
      </div>
    </div>`;
}

function markFileDone(index) {
  state.doneIndices.add(index);
  const row = document.getElementById(`filecheck-${index}`);
  if (row) {
    row.classList.add("done");
    row.querySelector(".filecheck-icon").textContent = "✓";
  }
}

function showResult(success, message, installedDrivers = [], logPath = "") {
  const icon = success
    ? `<svg class="resulticon" viewBox="0 0 80 80">
        <polygon points="40,4 72,22 72,58 40,76 8,58 8,22" fill="none" stroke="#4CAF7D" stroke-width="3"/>
        <path d="M26 41 L36 51 L56 29" fill="none" stroke="#4CAF7D" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>`
    : `<svg class="resulticon" viewBox="0 0 80 80">
        <polygon points="40,4 72,22 72,58 40,76 8,58 8,22" fill="none" stroke="#E2574C" stroke-width="3"/>
        <line x1="40" y1="26" x2="40" y2="46" stroke="#E2574C" stroke-width="4" stroke-linecap="round"/>
        <circle cx="40" cy="56" r="2.5" fill="#E2574C"/>
      </svg>`;

  const detailsBlock = (success && installedDrivers.length > 0)
    ? `<button class="btn-link" id="details-toggle" style="margin-top:2px;">Показать детали установки (${installedDrivers.length})</button>
       <div class="installed-list" id="installed-list" style="display:none;">
         ${installedDrivers.map((d) => `<div>${escapeHtml(d)}</div>`).join("")}
       </div>`
    : "";

  const logBlock = logPath
    ? `<button class="btn-link" id="log-link" style="margin-top:6px;">Открыть папку с логом</button>`
    : "";

  const actions = success
    ? `<div style="display:flex; gap:10px; margin-top:10px;">
        <button class="btn btn-ghost" id="later-btn">Позже</button>
        <button class="btn btn-primary" id="restart-btn">Перезагрузить сейчас</button>
      </div>`
    : `<button class="btn-link" id="support-link" style="margin-top:4px;">Написать в поддержку</button>`;

  screen.innerHTML = `
    <div class="resultwrap">
      ${icon}
      <div class="resulttext">${escapeHtml(message)}</div>
      ${detailsBlock}
      ${logBlock}
      ${actions}
    </div>`;

  if (success) {
    document.getElementById("later-btn").onclick = () => resetAndRestart();
    document.getElementById("restart-btn").onclick = () => invoke("restart_system");
    const toggle = document.getElementById("details-toggle");
    if (toggle) {
      toggle.onclick = () => {
        const list = document.getElementById("installed-list");
        list.style.display = list.style.display === "none" ? "block" : "none";
      };
    }
    notifyCompletion("Echips Driver Assistant", message);
  } else {
    document.getElementById("support-link").onclick = () => open(SUPPORT_URL);
  }

  const logLink = document.getElementById("log-link");
  if (logLink) {
    logLink.onclick = () => {
      invoke("open_log_folder").catch((err) => {
        logLink.textContent = "Не удалось открыть папку с логом";
        logLink.style.color = "var(--err)";
        logLink.style.textDecoration = "none";
        logLink.onclick = null;
        console.error(err);
      });
    };
  }
}

function resetAndRestart() {
  state.manifestEntry = null;
  state.universalEntry = null;
  state.universalFiles = [];
  state.filesToDownload = [];
  state.mode = null;
  detectAndLoad();
}

// ============================================================================
//  Основной поток
// ============================================================================

async function detectAndLoad() {
  checkForUpdate(); // не блокирует основной сценарий

  showLoading("СКАНИРОВАНИЕ ОБОРУДОВАНИЯ");
  state.systemInfo = await invoke("detect_system_info");

  showLoading("ПРОВЕРКА БАЗЫ ДРАЙВЕРОВ");
  try {
    state.manifest = await invoke("fetch_public_json", { publicUrl: MANIFEST_PUBLIC_URL });
    invoke("cache_manifest", { manifest: state.manifest }).catch(() => {});
  } catch (e) {
    try {
      state.manifest = await invoke("load_cached_manifest");
    } catch (e2) {
      showError("Не удалось загрузить каталог драйверов, а сохранённой копии тоже нет. Проверьте подключение к интернету.");
      return;
    }
  }

  let match = await invoke("find_by_name", {
    manifest: state.manifest,
    manufacturer: state.systemInfo.manufacturer,
    model: state.systemInfo.model,
  });

  if (!match) {
    match = await invoke("find_by_serial_prefix", {
      manifest: state.manifest,
      serial: state.systemInfo.serial,
    });
  }

  const autoDetectedKey = match ? match[0] : null;
  state.autoDetectedKey = autoDetectedKey;
  showModelSelection(autoDetectedKey);
}

async function openUniversalPicker() {
  showLoading("ЗАГРУЗКА СПИСКА КАТЕГОРИЙ");

  state.universalEntry = state.manifest["_universal"];
  if (!state.universalEntry) {
    showError("Универсальный набор драйверов недоступен.", () => showModelSelection());
    return;
  }

  try {
    state.universalFiles = await invoke("yandex_list_folder", {
      publicKey: state.universalEntry.yandex_public_key,
    });
  } catch (e) {
    showError("Не удалось получить список универсальных пакетов драйверов.", () => showModelSelection());
    return;
  }

  if (state.universalFiles.length === 0) {
    showError("В универсальном наборе пока нет ни одного пакета драйверов.", () => showModelSelection());
    return;
  }

  showUniversalCategoryPicker();
}

async function startInstall() {
  showProgress();

  let unlistenProgress = await listen("install-progress", (event) => {
    const p = event.payload;
    if (p.stage === "restore_point") {
      document.getElementById("stage-label").textContent = p.file_label;
    } else if (p.stage === "downloading" && p.total > 0) {
      const ratio = p.downloaded / p.total;
      document.getElementById("progress-bar").style.width = `${ratio * 100}%`;
      const mbDone = (p.downloaded / (1024 * 1024)).toFixed(1);
      const mbTotal = (p.total / (1024 * 1024)).toFixed(1);
      document.getElementById("stage-label").textContent = `Загрузка ${p.file_label}...`;
      document.getElementById("progress-mb").textContent = `${mbDone} / ${mbTotal} МБ`;
    } else if (p.stage === "installing") {
      document.getElementById("stage-label").textContent = p.file_label;
      document.getElementById("progress-bar").style.width = "100%";
    }
  });

  let unlistenFile = await listen("file-progress", (event) => {
    const p = event.payload;
    if (p.status === "done") {
      markFileDone(p.index);
    }
  });

  let files;
  if (state.mode === "model") {
    files = [[
      state.manifestEntry.entry.yandex_public_key,
      state.manifestEntry.entry.path || null,
      state.manifestEntry.combinedName || state.manifestEntry.entry.display_name || state.manifestEntry.key,
    ]];
  } else {
    files = state.filesToDownload.map(([name, path]) => [
      state.universalEntry.yandex_public_key,
      path,
      name,
    ]);
  }

  try {
    const result = await invoke("download_and_install", {
      files,
      createRestore: state.createRestorePoint,
    });
    unlistenProgress();
    unlistenFile();
    showResult(true, result.message, result.installed_drivers, result.log_path);
  } catch (e) {
    unlistenProgress();
    unlistenFile();
    showResult(false, typeof e === "string" ? e : "Установка завершилась с ошибками. Обратитесь в поддержку Echips.");
  }
}

document.getElementById("version-label").textContent = `v${APP_VERSION}`;
document.getElementById("site-link").addEventListener("click", () => open("https://echips.ru"));

detectAndLoad();
