# ============================================================================
#  diagnose.ps1 — диагностика Echips Driver Assistant без сборки приложения
#
#  Повторяет ТОЧНО ТУ ЖЕ логику, что и Tauri-приложение (определение модели,
#  серийника, диагонали, проблемных устройств, сопоставление с manifest.json,
#  проверку доступа к Yandex Disk) — но выводит всё текстом в консоль.
#
#  Запуск:
#    powershell -ExecutionPolicy Bypass -File diagnose.ps1
#  или просто открыть правой кнопкой -> "Запустить с помощью PowerShell"
#  (права администратора для диагностики НЕ нужны, только для реальной
#  установки драйверов через pnputil).
# ============================================================================

# Вставьте сюда ту же ссылку, что стоит в MANIFEST_PUBLIC_URL в src/app.js
$ManifestPublicUrl = "https://disk.360.yandex.ru/d/79yQHBN93UDZGg"

function Write-Section($title) {
    Write-Host ""
    Write-Host "===== $title =====" -ForegroundColor Cyan
}

function Write-KeyValue($key, $value, $color = "White") {
    Write-Host ("  {0,-28} " -f $key) -NoNewline -ForegroundColor Gray
    Write-Host $value -ForegroundColor $color
}

# ============================================================================
#  1. Определение модели ноутбука
# ============================================================================
Write-Section "1. МОДЕЛЬ НОУТБУКА"

$cs = Get-CimInstance -ClassName Win32_ComputerSystem
$manufacturer = $cs.Manufacturer
$model = $cs.Model

Write-KeyValue "Manufacturer" $manufacturer
Write-KeyValue "Model" $model

# ============================================================================
#  2. Серийный номер
# ============================================================================
Write-Section "2. СЕРИЙНЫЙ НОМЕР"

$serial = (Get-CimInstance -ClassName Win32_BIOS).SerialNumber
Write-KeyValue "SerialNumber" $serial

# ============================================================================
#  3. Проблемные устройства (без драйверов / с ошибками)
# ============================================================================
Write-Section "3. УСТРОЙСТВА С ОШИБКАМИ ДРАЙВЕРОВ"

$problemDevices = Get-PnpDevice | Where-Object { $_.Status -eq 'Error' } |
    Select-Object FriendlyName, Class

if ($problemDevices.Count -eq 0) {
    Write-Host "  Не найдено ни одного устройства с ошибкой." -ForegroundColor Yellow
    Write-Host "  (Это может означать, что все драйверы уже установлены —" -ForegroundColor Gray
    Write-Host "   проверьте вручную через Диспетчер устройств, если сомневаетесь.)" -ForegroundColor Gray
} else {
    foreach ($dev in $problemDevices) {
        Write-KeyValue $dev.Class $dev.FriendlyName "Red"
    }
}

# ============================================================================
#  4. Диагональ экрана
# ============================================================================
Write-Section "4. ДИАГОНАЛЬ ЭКРАНА"

$monitors = Get-CimInstance -Namespace root\wmi -ClassName WmiMonitorBasicDisplayParams |
    Select-Object MaxHorizontalImageSize, MaxVerticalImageSize

if (-not $monitors) {
    Write-Host "  Не удалось получить данные ни об одном мониторе." -ForegroundColor Yellow
} else {
    $diagonals = @()
    foreach ($m in $monitors) {
        $w = $m.MaxHorizontalImageSize
        $h = $m.MaxVerticalImageSize
        if ($w -and $h) {
            $diagCm = [math]::Sqrt(($w * $w) + ($h * $h))
            $diagInch = [math]::Round($diagCm / 2.54, 1)
            $diagonals += $diagInch
            Write-KeyValue "Монитор ($w x $h см)" "$diagInch`""
        }
    }
    if ($diagonals.Count -gt 0) {
        $chosen = ($diagonals | Measure-Object -Minimum).Minimum
        Write-Host ""
        Write-KeyValue "ВЫБРАНО (минимальная)" "$chosen`"" "Green"
        if ($diagonals.Count -gt 1) {
            Write-Host "  (Найдено несколько мониторов — берётся наименьшая диагональ," -ForegroundColor Gray
            Write-Host "   так как внешний монитор обычно крупнее встроенной панели.)" -ForegroundColor Gray
        }
    }
}

# ============================================================================
#  5. Загрузка manifest.json с Yandex Disk
# ============================================================================
Write-Section "5. ЗАГРУЗКА MANIFEST.JSON"

Write-KeyValue "Ссылка" $ManifestPublicUrl

$manifest = $null
try {
    $apiUrl = "https://cloud-api.yandex.net/v1/disk/public/resources/download?public_key=" +
        [System.Uri]::EscapeDataString($ManifestPublicUrl)
    $hrefResponse = Invoke-RestMethod -Uri $apiUrl -Method Get
    $downloadHref = $hrefResponse.href

    if (-not $downloadHref) {
        Write-Host "  ОШИБКА: сервер Yandex не вернул ссылку для скачивания." -ForegroundColor Red
        Write-Host "  Проверьте, что доступ к файлу настроен как 'Все, у кого есть ссылка'." -ForegroundColor Red
    } else {
        $manifest = Invoke-RestMethod -Uri $downloadHref -Method Get
        Write-Host "  Манифест успешно загружен." -ForegroundColor Green
        $modelKeys = $manifest.PSObject.Properties.Name | Where-Object { $_ -notlike "_*" }
        Write-KeyValue "Моделей в каталоге" $modelKeys.Count
        foreach ($k in $modelKeys) {
            Write-Host "    - $k" -ForegroundColor Gray
        }
    }
} catch {
    Write-Host "  ОШИБКА при загрузке манифеста: $($_.Exception.Message)" -ForegroundColor Red
}

# ============================================================================
#  6. Сопоставление модели с каталогом (та же логика, что в app.js/main.rs)
# ============================================================================
Write-Section "6. СОПОСТАВЛЕНИЕ С КАТАЛОГОМ"

function Normalize-Code($value) {
    if (-not $value) { return "" }
    return ($value -replace '[^A-Za-z0-9]', '').ToUpper()
}

$matchedKey = $null
$matchMethod = $null

if ($manifest) {
    $modelKeys = $manifest.PSObject.Properties.Name | Where-Object { $_ -notlike "_*" }
    $haystack = "$manufacturer $model".ToLower()

    # Способ 1: по имени модели (вхождение строки)
    foreach ($key in $modelKeys) {
        if ($haystack.Contains($key.ToLower()) -or $key.ToLower().Contains($haystack)) {
            $matchedKey = $key
            $matchMethod = "по имени модели"
            break
        }
    }

    # Способ 2: по префиксу серийного номера
    if (-not $matchedKey) {
        $normSerial = Normalize-Code $serial
        $bestLength = 0
        foreach ($key in $modelKeys) {
            $normKey = Normalize-Code $key
            if ($normKey -and $normSerial.StartsWith($normKey) -and $normKey.Length -gt $bestLength) {
                $matchedKey = $key
                $bestLength = $normKey.Length
            }
        }
        if ($matchedKey) { $matchMethod = "по префиксу серийника" }
    }
}

if ($matchedKey) {
    Write-KeyValue "Результат" "НАЙДЕНО: $matchedKey" "Green"
    Write-KeyValue "Способ" $matchMethod
    Write-KeyValue "Ссылка на драйверы" $manifest.$matchedKey.yandex_public_key
} elseif ($manifest) {
    Write-Host "  Модель НЕ найдена автоматически — приложение покажет ручной выбор." -ForegroundColor Yellow

    $modelKeys = $manifest.PSObject.Properties.Name | Where-Object { $_ -notlike "_*" }
    if ($diagonals -and $diagonals.Count -gt 0) {
        $chosenDiag = ($diagonals | Measure-Object -Minimum).Minimum
        Write-Host ""
        Write-Host "  Рекомендации по диагонали ($chosenDiag`"):" -ForegroundColor Gray
        foreach ($key in $modelKeys) {
            $modelDiag = $manifest.$key.diagonal
            if ($modelDiag -and [math]::Abs($modelDiag - $chosenDiag) -le 0.5) {
                Write-Host "    ★ $key (рекомендовано, диагональ $modelDiag`")" -ForegroundColor Green
            } else {
                Write-Host "      $key" -ForegroundColor Gray
            }
        }
    }
} else {
    Write-Host "  Пропущено — манифест не загрузился (см. пункт 5)." -ForegroundColor Yellow
}

# ============================================================================
#  7. Проверка универсального набора (если модель не найдена)
# ============================================================================
Write-Section "7. УНИВЕРСАЛЬНЫЙ НАБОР (запасной вариант)"

if ($manifest -and $manifest.'_universal') {
    $universalKey = $manifest.'_universal'.yandex_public_key
    Write-KeyValue "Ссылка на папку" $universalKey

    try {
        $listApiUrl = "https://cloud-api.yandex.net/v1/disk/public/resources?public_key=" +
            [System.Uri]::EscapeDataString($universalKey) + "&path=/&limit=200"
        $listResponse = Invoke-RestMethod -Uri $listApiUrl -Method Get
        $files = $listResponse._embedded.items | Where-Object { $_.type -eq "file" }

        Write-Host ""
        Write-Host "  Файлы в папке Universal:" -ForegroundColor Gray
        foreach ($f in $files) {
            Write-Host "    - $($f.name)" -ForegroundColor Gray
        }

        Write-Host ""
        if ($problemDevices.Count -gt 0) {
            Write-Host "  Сопоставление по классам устройств:" -ForegroundColor Gray
            $classes = $problemDevices.Class | Select-Object -Unique
            foreach ($cls in $classes) {
                $found = $files | Where-Object { $_.name.ToLower().Contains($cls.ToLower()) } | Select-Object -First 1
                if ($found) {
                    Write-Host "    Класс '$cls' -> найден файл '$($found.name)'" -ForegroundColor Green
                } else {
                    Write-Host "    Класс '$cls' -> ФАЙЛ НЕ НАЙДЕН" -ForegroundColor Red
                }
            }
        } else {
            Write-Host "  Проблемных устройств нет — сопоставлять нечего." -ForegroundColor Gray
        }
    } catch {
        Write-Host "  ОШИБКА при получении списка файлов: $($_.Exception.Message)" -ForegroundColor Red
    }
} else {
    Write-Host "  В манифесте нет записи '_universal' или манифест не загрузился." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "===== ГОТОВО =====" -ForegroundColor Cyan
Write-Host ""
