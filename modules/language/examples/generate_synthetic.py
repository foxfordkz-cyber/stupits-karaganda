"""Create 100 synthetic records and expected type labels, never read private inputs."""
import hashlib
import json
from pathlib import Path
import sys

CASES = [
    ("Игрок", "Ойнаушы", ["glossary_violation", "inconsistent_term"]),
    ("Игрок", "Ойыншы", ["inconsistent_term"]),
    ("Приветствие", "Сәлеметсізбе", ["orthography"]),
    ("Продолжить", "Continue", ["wrong_language"]),
    ("Отправить подарок {name}", "{name}-ға сыйлық жіберу", ["suffix_harmony"]),
    ("Вы сделали выбор.", "Сіз таңдауды жасадыңыз.", ["machine_translation_suspect"]),
    ("Добро пожаловать", "Қош келдіңіз", []),
    ("Сервер", "Сервер", []),
    ("DemoBrand", "DemoBrand", []),
    ("{count}", "{count}", []),
]


def build():
    records, labels = [], {}
    for n in range(100):
        source, target, expected = CASES[n % len(CASES)]
        key = f"synthetic_{n:03d}"
        version = hashlib.sha256(json.dumps([key, source, target], ensure_ascii=False).encode()).hexdigest()
        records.append({"key": key, "locale": "kk", "source": source, "target": target,
            "context": "Synthetic test UI", "category": "synthetic", "description": "Authored integration fixture",
            "occurrence": 1, "source_hash": version})
        labels[key] = expected
    return records, labels


if __name__ == "__main__":
    directory = Path(sys.argv[1])
    directory.mkdir(parents=True, exist_ok=True)
    records, labels = build()
    for name, data in (("records.json", records), ("expected.json", labels)):
        path = directory / name
        with path.open("x", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    print("Created 100 synthetic records")
