# build_release.ps1
# Собирает релизный .exe и сразу переименовывает его в красивое имя
# с пробелами — Cargo/Rust не позволяет так назвать сам бинарник напрямую,
# поэтому переименование делается отдельным шагом сразу после сборки.
#
# Запуск (из корня проекта echips-driver-assistant):
#   powershell -ExecutionPolicy Bypass -File build_release.ps1

$ErrorActionPreference = "Stop"

Write-Host "Сборка релизного .exe..." -ForegroundColor Cyan
cargo tauri build --no-bundle

$source = "src-tauri\target\release\echips-driver-assistant.exe"
$destination = "src-tauri\target\release\Echips Driver Assistant.exe"

if (Test-Path $source) {
    Copy-Item $source $destination -Force
    Write-Host "Готово: $destination" -ForegroundColor Green
} else {
    Write-Host "Не найден собранный файл: $source" -ForegroundColor Red
    exit 1
}
