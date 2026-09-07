// Echips Driver Assistant — Rust-бэкенд (Tauri command handlers).
//
// Каскад определения модели:
//   1. По имени модели (Win32_ComputerSystem.Model)
//   2. По серийному номеру, точное совпадение из "_serials" в manifest.json
//   3. По ПРЕФИКСУ серийного номера
//   4. Ручной выбор пользователем
//   5. Запасной вариант — универсальный набор по категориям устройств
//
// Дополнительно реализовано: точка восстановления системы (по согласию
// пользователя), полный лог установки в файл, кэш последнего успешного
// manifest.json на случай отсутствия сети, проверка свободного места
// перед загрузкой, и переиспользуемая загрузка публичного JSON с Yandex
// Disk (используется и для manifest.json, и для проверки версии).

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::io::Write;
use std::process::Command;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use tauri::{Emitter, Window};

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

// ============================================================================
//  Структуры данных
// ============================================================================

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct DeviceInfo {
    pub friendly_name: String,
    pub class: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SystemInfo {
    pub manufacturer: String,
    pub model: String,
    pub serial: String,
    pub diagonal: Option<f64>,
    pub problem_devices: Vec<DeviceInfo>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ManifestEntry {
    pub yandex_public_key: String,
    pub path: Option<String>,
    pub diagonal: Option<f64>,
    pub display_name: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct DownloadProgress {
    pub stage: String,
    pub downloaded: u64,
    pub total: u64,
    pub file_label: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct InstallResult {
    pub success: bool,
    pub message: String,
    pub installed_drivers: Vec<String>,
    pub log_path: String,
}

const MIN_FREE_MB: u64 = 500;

// ============================================================================
//  PowerShell — базовые обёртки
// ============================================================================

fn run_powershell(command: &str) -> String {
    // Принудительно переключаем кодировку консоли на UTF-8 — иначе кириллица
    // в выводе превращается в "ромбики с вопросом" на русской Windows.
    let full_command = format!(
        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; {}",
        command
    );
    let mut cmd = Command::new("powershell");
    cmd.args(["-NoProfile", "-NonInteractive", "-Command", &full_command]);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let output = cmd.output();
    match output {
        Ok(out) => String::from_utf8_lossy(&out.stdout).trim().to_string(),
        Err(_) => String::new(),
    }
}

/// Как run_powershell, но также возвращает, завершилась ли команда успешно
/// (код возврата 0) — нужно там, где важен не только вывод, но и сам факт
/// успеха (точка восстановления, установка драйверов).
fn run_powershell_with_status(command: &str) -> (String, bool) {
    let full_command = format!(
        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; {}; exit $LASTEXITCODE",
        command
    );
    let mut cmd = Command::new("powershell");
    cmd.args(["-NoProfile", "-NonInteractive", "-Command", &full_command]);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let output = cmd.output();
    match output {
        Ok(out) => (
            String::from_utf8_lossy(&out.stdout).trim().to_string(),
            out.status.success(),
        ),
        Err(_) => (String::new(), false),
    }
}

// ============================================================================
//  Определение оборудования
// ============================================================================

#[tauri::command]
fn detect_system_info() -> SystemInfo {
    let manufacturer = run_powershell("(Get-CimInstance -ClassName Win32_ComputerSystem).Manufacturer");
    let model = run_powershell("(Get-CimInstance -ClassName Win32_ComputerSystem).Model");
    let serial = run_powershell("(Get-CimInstance -ClassName Win32_BIOS).SerialNumber");

    let devices_json = run_powershell(
        "Get-PnpDevice | Where-Object { $_.Status -eq 'Error' } | \
         Select-Object FriendlyName, Class | ConvertTo-Json -Compress",
    );
    let problem_devices = parse_devices_json(&devices_json);

    let diagonal_json = run_powershell(
        "Get-CimInstance -Namespace root\\wmi -ClassName WmiMonitorBasicDisplayParams | \
         Select-Object MaxHorizontalImageSize, MaxVerticalImageSize | ConvertTo-Json -Compress",
    );
    let diagonal = parse_diagonal_json(&diagonal_json);

    SystemInfo { manufacturer, model, serial, diagonal, problem_devices }
}

fn parse_devices_json(raw: &str) -> Vec<DeviceInfo> {
    if raw.is_empty() {
        return vec![];
    }
    let value: serde_json::Value = match serde_json::from_str(raw) {
        Ok(v) => v,
        Err(_) => return vec![],
    };
    let items: Vec<serde_json::Value> = match value {
        serde_json::Value::Array(arr) => arr,
        obj @ serde_json::Value::Object(_) => vec![obj],
        _ => vec![],
    };
    items
        .into_iter()
        .map(|item| DeviceInfo {
            friendly_name: item.get("FriendlyName").and_then(|v| v.as_str())
                .unwrap_or("Неизвестное устройство").to_string(),
            class: item.get("Class").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        })
        .collect()
}

fn parse_diagonal_json(raw: &str) -> Option<f64> {
    if raw.is_empty() {
        return None;
    }
    let value: serde_json::Value = serde_json::from_str(raw).ok()?;
    let items: Vec<serde_json::Value> = match value {
        serde_json::Value::Array(arr) => arr,
        obj @ serde_json::Value::Object(_) => vec![obj],
        _ => vec![],
    };
    let mut diagonals: Vec<f64> = vec![];
    for item in items {
        let width = item.get("MaxHorizontalImageSize").and_then(|v| v.as_f64());
        let height = item.get("MaxVerticalImageSize").and_then(|v| v.as_f64());
        if let (Some(w), Some(h)) = (width, height) {
            let diagonal_cm = (w * w + h * h).sqrt();
            diagonals.push((diagonal_cm / 2.54 * 10.0).round() / 10.0);
        }
    }
    diagonals.into_iter().fold(None, |acc, d| match acc {
        None => Some(d),
        Some(prev) => Some(prev.min(d)),
    })
}

// ============================================================================
//  Сопоставление модели с manifest.json
// ============================================================================

fn normalize_code(value: &str) -> String {
    value.chars().filter(|c| c.is_ascii_alphanumeric()).collect::<String>().to_uppercase()
}

#[tauri::command]
fn find_by_name(manifest: serde_json::Value, manufacturer: String, model: String) -> Option<(String, ManifestEntry)> {
    let haystack = format!("{} {}", manufacturer, model).to_lowercase();
    let obj = manifest.as_object()?;
    for (key, value) in obj {
        if key.starts_with('_') { continue; }
        let key_lower = key.to_lowercase();
        if haystack.contains(&key_lower) || key_lower.contains(&haystack) {
            if let Ok(entry) = serde_json::from_value::<ManifestEntry>(value.clone()) {
                return Some((key.clone(), entry));
            }
        }
    }
    None
}

#[tauri::command]
fn find_by_serial_prefix(manifest: serde_json::Value, serial: String) -> Option<(String, ManifestEntry)> {
    let norm_serial = normalize_code(&serial);
    if norm_serial.is_empty() { return None; }
    let obj = manifest.as_object()?;
    let mut best: Option<(String, ManifestEntry, usize)> = None;
    for (key, value) in obj {
        if key.starts_with('_') { continue; }
        let norm_key = normalize_code(key);
        if !norm_key.is_empty()
            && norm_serial.starts_with(&norm_key)
            && norm_key.len() > best.as_ref().map(|b| b.2).unwrap_or(0)
        {
            if let Ok(entry) = serde_json::from_value::<ManifestEntry>(value.clone()) {
                best = Some((key.clone(), entry, norm_key.len()));
            }
        }
    }
    best.map(|(k, e, _)| (k, e))
}

// ============================================================================
//  Yandex Disk (публичные ссылки, без токенов)
// ============================================================================

/// Универсальная загрузка JSON по публичной ссылке Yandex Disk — используется
/// и для manifest.json, и для проверки версии (version.json), поэтому названа
/// обобщённо, а не "fetch_manifest".
#[tauri::command]
async fn fetch_public_json(public_url: String) -> Result<serde_json::Value, String> {
    let href = yandex_get_download_href(&public_url, None).await.map_err(|e| e.to_string())?;
    let resp = reqwest::get(&href).await.map_err(|e| e.to_string())?;
    resp.json::<serde_json::Value>().await.map_err(|e| e.to_string())
}

async fn yandex_get_download_href(public_key: &str, path: Option<&str>) -> Result<String, reqwest::Error> {
    let mut url = format!(
        "https://cloud-api.yandex.net/v1/disk/public/resources/download?public_key={}",
        urlencoding::encode(public_key)
    );
    if let Some(p) = path {
        url.push_str(&format!("&path={}", urlencoding::encode(p)));
    }
    let resp = reqwest::get(&url).await?;
    let json: serde_json::Value = resp.json().await?;
    Ok(json["href"].as_str().unwrap_or_default().to_string())
}

#[tauri::command]
async fn yandex_list_folder(public_key: String) -> Result<Vec<(String, String)>, String> {
    let url = format!(
        "https://cloud-api.yandex.net/v1/disk/public/resources?public_key={}&path=/&limit=200",
        urlencoding::encode(&public_key)
    );
    let resp = reqwest::get(&url).await.map_err(|e| e.to_string())?;
    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let items = json["_embedded"]["items"].as_array().cloned().unwrap_or_default();
    let mut result = vec![];
    for item in items {
        if item["type"].as_str() == Some("file") {
            let name = item["name"].as_str().unwrap_or_default().to_string();
            let path = item["path"].as_str().unwrap_or_default().to_string();
            result.push((name, path));
        }
    }
    Ok(result)
}

// ============================================================================
//  Кэш последнего успешного manifest.json (на случай отсутствия сети)
// ============================================================================

fn app_data_dir() -> std::path::PathBuf {
    let base = std::env::var("LOCALAPPDATA").unwrap_or_else(|_| ".".into());
    std::path::PathBuf::from(base).join("Echips")
}

fn manifest_cache_path() -> std::path::PathBuf {
    app_data_dir().join("manifest_cache.json")
}

#[tauri::command]
fn cache_manifest(manifest: serde_json::Value) -> Result<(), String> {
    let path = manifest_cache_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::write(&path, manifest.to_string()).map_err(|e| e.to_string())
}

#[tauri::command]
fn load_cached_manifest() -> Result<serde_json::Value, String> {
    let path = manifest_cache_path();
    let content = std::fs::read_to_string(&path)
        .map_err(|_| "Сохранённая копия каталога драйверов не найдена.".to_string())?;
    serde_json::from_str(&content).map_err(|e| e.to_string())
}

// ============================================================================
//  Точка восстановления системы
// ============================================================================

#[tauri::command]
fn create_restore_point() -> Result<(), String> {
    // Примечание: Windows по умолчанию не позволяет создавать точки
    // восстановления чаще одного раза в 24 часа (если явно не изменена
    // системная политика) — в этом случае Checkpoint-Computer тоже вернёт
    // ошибку, это не баг программы.
    let (stdout, ok) = run_powershell_with_status(
        "Checkpoint-Computer -Description 'Echips Driver Assistant' -RestorePointType 'DEVICE_DRIVER_INSTALL'",
    );
    if ok {
        Ok(())
    } else {
        Err(format!(
            "Не удалось создать точку восстановления (возможно, защита системы отключена \
            или точка уже создавалась в последние 24 часа). {}",
            stdout
        ))
    }
}

// ============================================================================
//  Проверка свободного места на диске
// ============================================================================

fn free_space_mb() -> u64 {
    let out = run_powershell("(Get-PSDrive -Name ((Get-Item $env:TEMP).PSDrive.Name)).Free");
    out.trim().parse::<u64>().map(|b| b / (1024 * 1024)).unwrap_or(u64::MAX)
}

// ============================================================================
//  Логирование установки
// ============================================================================

fn log_dir() -> std::path::PathBuf {
    app_data_dir().join("logs")
}

fn unix_time() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn write_log(lines: &[String]) -> String {
    let dir = log_dir();
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join(format!("install_{}.log", unix_time()));
    let _ = std::fs::write(&path, lines.join("\n"));
    path.to_string_lossy().to_string()
}

/// Вытаскивает имена пакетов драйверов (oemNN.inf) из вывода pnputil —
/// работает независимо от локали Windows, так как схема именования
/// oemNN.inf в самой Windows не переводится.
fn parse_installed_drivers(stdout: &str) -> Vec<String> {
    let mut result = vec![];
    for line in stdout.lines() {
        let lower = line.to_lowercase();
        if let Some(pos) = lower.find("oem") {
            let tail = &line[pos..];
            if let Some(end) = tail.to_lowercase().find(".inf") {
                let token = tail[..end + 4].to_string();
                if !result.contains(&token) {
                    result.push(token);
                }
            }
        }
    }
    result
}

// ============================================================================
//  Скачивание и установка
// ============================================================================

/// Скачивает и устанавливает драйверы. files — список (публичная_ссылка, путь_внутри, подпись_для_прогресса).
#[tauri::command]
async fn download_and_install(
    window: Window,
    files: Vec<(String, Option<String>, String)>,
    create_restore: bool,
) -> Result<InstallResult, String> {
    let mut log_lines: Vec<String> = vec![];
    log_lines.push(format!("[{}] Начало установки. Файлов к загрузке: {}", unix_time(), files.len()));

    // --- Проверка свободного места ---
    let free_mb = free_space_mb();
    log_lines.push(format!("[{}] Свободно места на диске: {} МБ", unix_time(), free_mb));
    if free_mb < MIN_FREE_MB {
        log_lines.push("Недостаточно места — установка прервана до начала загрузки.".into());
        let log_path = write_log(&log_lines);
        return Err(format!(
            "Недостаточно свободного места на диске (доступно {} МБ, требуется не менее {} МБ).\n\nЛог: {}",
            free_mb, MIN_FREE_MB, log_path
        ));
    }

    // --- Точка восстановления (только если пользователь согласился) ---
    if create_restore {
        let _ = window.emit(
            "install-progress",
            DownloadProgress {
                stage: "restore_point".into(),
                downloaded: 0,
                total: 0,
                file_label: "Создание точки восстановления...".into(),
            },
        );
        match create_restore_point() {
            Ok(()) => log_lines.push(format!("[{}] Точка восстановления создана успешно.", unix_time())),
            Err(e) => log_lines.push(format!("[{}] Точка восстановления НЕ создана: {}", unix_time(), e)),
        }
    }

    let tmp_dir = std::env::temp_dir().join(format!("echips_drivers_{}", std::process::id()));
    let extract_dir = tmp_dir.join("extracted");
    std::fs::create_dir_all(&extract_dir).map_err(|e| e.to_string())?;

    let total_files = files.len();
    for (i, (public_key, path, label)) in files.iter().enumerate() {
        log_lines.push(format!("[{}] Скачивание: {}", unix_time(), label));
        let href = yandex_get_download_href(public_key, path.as_deref()).await.map_err(|e| e.to_string())?;

        let zip_path = tmp_dir.join(format!("part_{}.zip", i));
        download_file(&window, &href, &zip_path, label, i + 1, total_files).await.map_err(|e| e.to_string())?;

        extract_zip(&zip_path, &extract_dir).map_err(|e| e.to_string())?;
        log_lines.push(format!("[{}] Распаковано: {}", unix_time(), label));
    }

    let _ = window.emit(
        "install-progress",
        DownloadProgress {
            stage: "installing".into(),
            downloaded: 0,
            total: 0,
            file_label: "Установка драйверов...".into(),
        },
    );

    let inf_glob = extract_dir.join("*.inf");
    let inf_glob_str = inf_glob.to_string_lossy().replace('\'', "''");
    let pnputil_command = format!(
        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; \
         pnputil /add-driver '{}' /subdirs /install; exit $LASTEXITCODE",
        inf_glob_str
    );

    let mut pnputil_cmd = Command::new("powershell");
    pnputil_cmd.args(["-NoProfile", "-NonInteractive", "-Command", &pnputil_command]);
    #[cfg(target_os = "windows")]
    pnputil_cmd.creation_flags(CREATE_NO_WINDOW);
    let output = pnputil_cmd.output().map_err(|e| e.to_string())?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let _ = std::fs::remove_dir_all(&tmp_dir);

    let installed_drivers = parse_installed_drivers(&stdout);
    log_lines.push(format!("[{}] ---- Вывод pnputil ----", unix_time()));
    log_lines.push(stdout.clone());
    log_lines.push(format!("[{}] Установлено пакетов: {}", unix_time(), installed_drivers.len()));

    let log_path = write_log(&log_lines);

    let processed_something = stdout.contains("Опубликовано")
        || stdout.contains("Published")
        || stdout.contains("уже присутствует")
        || stdout.contains("already present")
        || stdout.contains("успешно добавлен")
        || stdout.contains("was successfully");

    if output.status.success() {
        Ok(InstallResult {
            success: true,
            message: "Драйверы успешно установлены. Рекомендуется перезагрузить компьютер.".into(),
            installed_drivers,
            log_path,
        })
    } else if processed_something {
        Ok(InstallResult {
            success: true,
            message: "Часть драйверов установлена успешно. Некоторые пакеты могли быть пропущены \
                (например, неподписанные или несовместимые с этой моделью) — рекомендуем \
                перезагрузить компьютер и проверить Диспетчер устройств.".into(),
            installed_drivers,
            log_path,
        })
    } else {
        Err(format!(
            "Установка завершилась с ошибками. Обратитесь в поддержку Echips.\n\nЛог: {}",
            log_path
        ))
    }
}

async fn download_file(
    window: &Window,
    url: &str,
    dest: &std::path::Path,
    label: &str,
    file_index: usize,
    total_files: usize,
) -> Result<(), Box<dyn std::error::Error>> {
    use futures_util::StreamExt;

    let resp = reqwest::get(url).await?;
    let total = resp.content_length().unwrap_or(0);
    let mut file = std::fs::File::create(dest)?;
    let mut downloaded: u64 = 0;
    let mut stream = resp.bytes_stream();

    let display_label = if total_files > 1 {
        format!("{} ({}/{})", label, file_index, total_files)
    } else {
        label.to_string()
    };

    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        file.write_all(&chunk)?;
        downloaded += chunk.len() as u64;
        let _ = window.emit(
            "install-progress",
            DownloadProgress {
                stage: "downloading".into(),
                downloaded,
                total,
                file_label: display_label.clone(),
            },
        );
    }
    let _ = window.emit(
        "file-progress",
        serde_json::json!({ "index": file_index - 1, "status": "done" }),
    );
    Ok(())
}

fn extract_zip(zip_path: &std::path::Path, extract_to: &std::path::Path) -> Result<(), Box<dyn std::error::Error>> {
    let file = std::fs::File::open(zip_path)?;
    let mut archive = zip::ZipArchive::new(file)?;
    archive.extract(extract_to)?;
    Ok(())
}

#[tauri::command]
fn restart_system() {
    let mut cmd = Command::new("shutdown");
    cmd.args(["/r", "/t", "5"]);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let _ = cmd.spawn();
}

#[tauri::command]
fn open_log_folder() -> Result<(), String> {
    let dir = log_dir();
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Не удалось создать папку с логами ({}): {}", dir.display(), e))?;
    Command::new("explorer")
        .arg(dir.to_string_lossy().to_string())
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ============================================================================
//  Скачивание обновления самого приложения (временное решение — пока нет
//  отдельной страницы загрузки на сайте, новую версию .exe раздаём через
//  тот же Yandex Disk, тем же механизмом, что и драйверы).
// ============================================================================

fn downloads_dir() -> std::path::PathBuf {
    let base = std::env::var("USERPROFILE").unwrap_or_else(|_| ".".into());
    std::path::PathBuf::from(base).join("Downloads")
}

async fn download_update_file(
    window: &Window,
    url: &str,
    dest: &std::path::Path,
) -> Result<(), Box<dyn std::error::Error>> {
    use futures_util::StreamExt;

    let resp = reqwest::get(url).await?;
    let total = resp.content_length().unwrap_or(0);
    let mut file = std::fs::File::create(dest)?;
    let mut downloaded: u64 = 0;
    let mut stream = resp.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        file.write_all(&chunk)?;
        downloaded += chunk.len() as u64;
        // Отдельное событие "update-progress" — не пересекается с
        // "install-progress" от установки драйверов, чтобы два процесса
        // не путали друг другу интерфейс, если вдруг совпадут по времени.
        let _ = window.emit(
            "update-progress",
            DownloadProgress {
                stage: "downloading".into(),
                downloaded,
                total,
                file_label: "Обновление".into(),
            },
        );
    }
    Ok(())
}

#[tauri::command]
async fn download_update(
    window: Window,
    yandex_public_key: String,
    path: Option<String>,
    file_name: String,
) -> Result<String, String> {
    let href = yandex_get_download_href(&yandex_public_key, path.as_deref())
        .await
        .map_err(|e| e.to_string())?;

    let dest_dir = downloads_dir();
    std::fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;
    let dest_path = dest_dir.join(&file_name);

    download_update_file(&window, &href, &dest_path)
        .await
        .map_err(|e| e.to_string())?;

    Ok(dest_path.to_string_lossy().to_string())
}

#[tauri::command]
fn reveal_in_explorer(path: String) -> Result<(), String> {
    // /select, — стандартный флаг проводника Windows: открывает папку
    // и сразу подсвечивает указанный файл, а не просто открывает папку.
    Command::new("explorer")
        .args(["/select,", &path])
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ============================================================================
//  Точка входа
// ============================================================================

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            detect_system_info,
            find_by_name,
            find_by_serial_prefix,
            fetch_public_json,
            yandex_list_folder,
            download_and_install,
            restart_system,
            cache_manifest,
            load_cached_manifest,
            create_restore_point,
            open_log_folder,
            download_update,
            reveal_in_explorer,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
