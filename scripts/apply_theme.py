#!/usr/bin/env python3
"""apply_theme.py – hängt den Design-Layer in alle Frontend-Seiten ein.

Fügt in jede frontend/*.html (außer login.html, die ihre Styles komplett
inline hat) ein:

    <link rel="stylesheet" href="theme.css" />   direkt nach styles.css
    <script src="theme.js"></script>              direkt vor </body>

Das Skript ist idempotent: Seiten, die beides schon enthalten, bleiben
unverändert. Es braucht nur die Python-Standardbibliothek.

Aufruf aus dem Repo-Root:
    python scripts/apply_theme.py            # schreibt
    python scripts/apply_theme.py --check    # prüft nur (Exit-Code 1 bei Lücken)
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FRONTEND = ROOT / "frontend"
SKIP = {"login.html"}

LINK_TAG = '<link rel="stylesheet" href="theme.css" />'
SCRIPT_TAG = '<script src="theme.js"></script>'

STYLES_LINK_RE = re.compile(r"""(<link[^>]+href=["']styles\.css["'][^>]*>)""", re.IGNORECASE)
BODY_CLOSE_RE = re.compile(r"</body\s*>", re.IGNORECASE)


def process(path: Path, check_only: bool) -> tuple[bool, str]:
    original = path.read_text(encoding="utf-8")
    text = original
    notes: list[str] = []

    if "theme.css" not in text:
        m = STYLES_LINK_RE.search(text)
        if not m:
            return False, "kein styles.css-Link gefunden – bitte manuell einfügen"
        indent_match = re.search(r"([ \t]*)" + re.escape(m.group(1)), text)
        indent = indent_match.group(1) if indent_match else ""
        text = text[: m.end()] + "\n" + indent + LINK_TAG + text[m.end() :]
        notes.append("theme.css")

    if "theme.js" not in text:
        m = BODY_CLOSE_RE.search(text)
        if not m:
            return False, "kein </body> gefunden – bitte manuell einfügen"
        text = text[: m.start()] + SCRIPT_TAG + "\n" + text[m.start() :]
        notes.append("theme.js")

    if text == original:
        return True, "bereits aktuell"

    if check_only:
        return False, "fehlt: " + ", ".join(notes)

    path.write_text(text, encoding="utf-8")
    return True, "eingefügt: " + ", ".join(notes)


def main(argv: list[str]) -> int:
    check_only = "--check" in argv
    if not FRONTEND.is_dir():
        print(f"Ordner nicht gefunden: {FRONTEND}", file=sys.stderr)
        return 2

    pages = sorted(p for p in FRONTEND.glob("*.html") if p.name not in SKIP)
    if not pages:
        print("Keine HTML-Seiten gefunden.", file=sys.stderr)
        return 2

    failures = 0
    for page in pages:
        ok, msg = process(page, check_only)
        status = "OK " if ok else "!! "
        print(f"{status} {page.relative_to(ROOT)}: {msg}")
        if not ok:
            failures += 1

    if check_only:
        print("\nPrüfung abgeschlossen –", "alles verdrahtet." if not failures else f"{failures} Seite(n) ohne Design-Layer.")
    else:
        print("\nFertig. Nächster Schritt: node --test tests  und dann committen.")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
