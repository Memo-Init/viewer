# Mermaid Diagnose — Aktueller Stand (PRD-022)

> Quelle: Memo 011 (Memo-System Verbesserungen), REV-07, Kap 3.1. Diagnose-first — keine Upgrade-Ausfuehrung.
> Generiert: 2026-05-24

Dieser Report dokumentiert den aktuellen Stand der Mermaid-Diagnose. **Kein Upgrade ohne explizite User-Entscheidung** — die Diagnose endet hier mit den vorbereiteten Werkzeugen und dem Reproduktions-Set.

---

## Zusammenfassung

| Feld | Wert |
|------|------|
| **Aktuelle Mermaid-Version** | 11.4.1 (CDN in `editor/src/MemoView.mjs` Zeile 837) |
| **Diagramme im Reproduktions-Set** | 90 |
| **Quellen** | Alle `.md` aus `.memo/**/revisions/` |
| **Status** | Diagnose-Werkzeuge bereitgestellt, kein Upgrade ausgefuehrt |

---

## Geleistete Arbeit (US-1 + US-3 Werkzeuge)

### US-1 — Sammlung

`editor/scripts/collect-mermaid-errors.mjs` ist implementiert und ausgefuehrt.

- Liest rekursiv alle `.md`-Dateien aus `.memo/**/revisions/`.
- Extrahiert ```mermaid Code-Bloecke via Regex.
- Schreibt pro Diagramm eine `.mmd`-Datei + Source-Header.
- Erzeugt `extracted/INDEX.md` mit ID, Memo, Revision, Heading, Source-Pfad, Zeile, Datei.

**Live-Ergebnis (zuletzt):** 90 Diagramme.

### US-3 — Versions-Test-Werkzeug

`editor/scripts/test-mermaid-versions.mjs` ist implementiert (dry-run-fest, live-Modus nur fuer Patch-Backup-Restore).

- Akzeptiert `--versions=v1,v2,...` (via Helper-Parser, kein direktes `process.argv`-Slicing in Business-Logik).
- Parst `INDEX.md` und baut pro Diagramm + Version eine standalone HTML-Harness mit Mermaid-CDN-Inject.
- Patch + Backup-und-Restore von `MemoView.mjs` (Live-Modus laesst Working Tree unveraendert).
- Schreibt `test-results/mermaid-version-matrix.json` mit Status pro Diagramm + Version (Initial-Status: `PENDING`).

**Verifiziert:** dry-run mit `--versions=11.4.1,11.5.0` erzeugt 90×2 = 180 Harness-HTMLs + Matrix-JSON.

---

## Nicht ausgefuehrte Schritte (bewusst, Diagnose-first)

### US-2 — Klassifikation

`mermaid-diagnose-report.md` ist als leeres Template angelegt. Die Render-Pass-Klassifikation pro Diagramm braucht den memo-view-Server + Playwright/Browser-Console und ist ein manueller Schritt.

### US-3 — Live-Render

Die Render-Phase (Harness-HTML im Browser oeffnen, SVG/Fehler einsammeln, Matrix von `PENDING` auf `OK/WARN/FAIL` aktualisieren) ist NICHT automatisch ausgefuehrt. Sie braucht Playwright-CLI/MCP — das ist die naechste manuelle Phase.

### US-4 — Entscheidung

`mermaid-upgrade-decision.md` ist als Template angelegt. Die Entscheidung "Upgrade ja/nein + welche Version" gehoert dem User nach Review der Matrix.

### US-5 — Patch in Main

KEIN Patch an `editor/src/MemoView.mjs` Zeile 837 — die CDN-URL bleibt unveraendert.

---

## Naechste Schritte (manuell, durch User auszuloesen)

1. memo-view-Server starten: `memo-view --server &`
2. Render-Pass durchfuehren, `mermaid-diagnose-report.md` Tabelle ausfuellen
3. `node editor/scripts/test-mermaid-versions.mjs --versions=<liste> --dry-run` (oder live) ausfuehren
4. Harness-HTMLs rendern (Playwright CLI), Status sammeln
5. `mermaid-upgrade-decision.md` schreiben
6. Falls Upgrade entschieden: regulaerer git-commit-Flow mit Issue #22 oder Folge-Issue

---

## Code-Pfade

| Datei | Zweck |
|-------|-------|
| `editor/src/MemoView.mjs` Zeile 837 | Mermaid CDN-URL (nicht geaendert) |
| `editor/scripts/collect-mermaid-errors.mjs` | Sammler (US-1) |
| `editor/scripts/test-mermaid-versions.mjs` | Versions-Test (US-3) |
| `editor/tests/manual/mermaid-error-collection.md` | Sammlungs-Doku (US-1) |
| `editor/tests/manual/mermaid-diagnose-report.md` | Klassifikations-Report (US-2) |
| `editor/tests/manual/mermaid-upgrade-decision.md` | Versions-Matrix + Entscheidung (US-4) |
| `editor/tests/manual/mermaid-error-collection/extracted/` | Extrahierte `.mmd` + `INDEX.md` (gitignored) |
| `editor/tests/manual/test-results/` | Matrix-Output (gitignored) |

---

## Cross-References

- Memo 011, REV-07, Kap 3.1 — Mermaid Syntax-Errors v11.4.1 (Quelle).
- Memo 011, REV-07, Kap 3.2 — `flowchart TD` als Default (NICHT Teil dieses PRDs).
- PRD-022 — vollstaendiger PRD-Text.
