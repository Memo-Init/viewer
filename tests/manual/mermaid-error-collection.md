# Mermaid Error Collection (PRD-022)

> Quelle: Memo 011 (Memo-System Verbesserungen), REV-07, Kapitel 3.1. Diagnose-first — keine Upgrade-Ausfuehrung in diesem Schritt.

Diese Datei dokumentiert die systematische Sammlung von Mermaid-Diagrammen aus allen `.memo/**/revisions/`-Dateien fuer den nachfolgenden Versions-Test. Die Sammlung wird vom Script `editor/scripts/collect-mermaid-errors.mjs` erzeugt.

---

## Sammlungs-Workflow

1. `editor/scripts/collect-mermaid-errors.mjs` ausfuehren
   - Liest alle `.md` aus `.memo/**/revisions/`
   - Extrahiert ```mermaid Code-Bloecke via Regex
   - Schreibt `<memo>-<rev>-<index>.mmd` pro Diagramm
   - Erzeugt `extracted/INDEX.md` mit Source-Pfaden

2. Live-Output (zuletzt ausgefuehrt 2026-05-24)
   - **Total collected:** 90 Diagramme
   - **Output:** `editor/tests/manual/mermaid-error-collection/extracted/` (gitignored)
   - **Index:** `editor/tests/manual/mermaid-error-collection/extracted/INDEX.md`

---

## Coverage

Per PRD-022 US-1 Acceptance Criterion: mindestens 5 reproduzierbare Diagramme aus REV-01..07.

| Memo | Revisions mit Diagrammen | Anzahl extrahiert |
|------|--------------------------|-------------------|
| 001-memo-toolkit | memo-v0.1..v0.5 | mehrere |
| 011-memo-system-verbesserungen | REV-01..REV-07 | mehrere |
| weitere Memos | diverse | mehrere |
| **Total** | | **90** |

Acceptance Criterion erfuellt (Schwelle 5, tatsaechlich 90).

---

## Naechster Schritt

`mermaid-diagnose-report.md` ausfuellen, dann `mermaid-upgrade-decision.md` schreiben — danach Entscheidung an User uebergeben. Kein Upgrade ohne Entscheidung.

Siehe `editor/tests/manual/DIAGNOSE.md` fuer den aktuellen Stand.
