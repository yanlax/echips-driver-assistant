"""
generate_model_archives.py — создаёт пустой zip-архив под каждую модель
из manifest.json, готовый к тому, чтобы просто закинуть туда файлы
драйверов и залить на Yandex Disk.

Запускать заново при каждом добавлении новых моделей в manifest.json —
скрипт сам создаст архивы только для новых записей, ничего не перезапишет.

Использование:
    python generate_model_archives.py
    python generate_model_archives.py --only-missing
    python generate_model_archives.py --manifest ../manifest/manifest.json --output ./ModelArchives

Флаги:
    --only-missing   Создавать архивы только для моделей, у которых в
                      manifest.json ещё стоит ссылка-плейсхолдер
                      ("ЗАМЕНИТЕ_НА_ССЫЛКУ..."), а не настоящая ссылка.
                      Удобно, когда часть моделей уже залита, и нужно
                      получить архивы только под оставшиеся.
    --manifest PATH  Путь к manifest.json (по умолчанию — рядом со
                      скриптом, в ../manifest/manifest.json).
    --output PATH    Куда класть архивы (по умолчанию — ./ModelArchives
                      рядом со скриптом).
"""

import argparse
import json
import os
import zipfile


def main():
    parser = argparse.ArgumentParser(description="Генератор пустых архивов под модели драйверов Echips")
    parser.add_argument(
        "--manifest",
        default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "manifest", "manifest.json"),
        help="Путь к manifest.json",
    )
    parser.add_argument(
        "--output",
        default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "ModelArchives"),
        help="Папка для готовых архивов",
    )
    parser.add_argument(
        "--only-missing",
        action="store_true",
        help="Создавать архивы только для моделей без реальной ссылки (с плейсхолдером)",
    )
    args = parser.parse_args()

    with open(args.manifest, "r", encoding="utf-8") as f:
        manifest = json.load(f)

    os.makedirs(args.output, exist_ok=True)

    model_keys = [k for k in manifest.keys() if not k.startswith("_")]

    created, skipped_existing, skipped_has_link = [], [], []

    for model in model_keys:
        entry = manifest[model]
        has_real_link = isinstance(entry.get("yandex_public_key"), str) and not entry["yandex_public_key"].startswith("ЗАМЕНИТЕ")

        if args.only_missing and has_real_link:
            skipped_has_link.append(model)
            continue

        filename = f"{model}_drivers.zip"
        path = os.path.join(args.output, filename)

        if os.path.exists(path):
            skipped_existing.append(filename)
            continue

        with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED):
            pass
        created.append(filename)

    print(f"Создано новых архивов: {len(created)}")
    for name in sorted(created):
        print(" ", name)

    if skipped_existing:
        print(f"\nПропущено (архив уже существует в папке): {len(skipped_existing)}")
    if skipped_has_link:
        print(f"Пропущено (в manifest.json уже есть реальная ссылка): {len(skipped_has_link)}")

    print(f"\nВсе архивы — в папке: {os.path.abspath(args.output)}")


if __name__ == "__main__":
    main()
