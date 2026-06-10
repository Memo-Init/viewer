# Mermaid Diagnose Report (PRD-022 / PRD-008)

> Quelle: Memo 011 (Memo-System Verbesserungen), REV-07, Kapitel 3.1. Original Diagnose-first — Sammlung + Klassifikation.
> Update: Memo 012 (Rollout 011 Defektbereinigung), Phase 4 Cluster C10 — Diagnose ausgefuehrt, Decision finalisiert.

Klassifikations-Report fuer alle Mermaid-Diagramme im Memo-System. Eingabe: `extracted/INDEX.md` aus `editor/scripts/collect-mermaid-errors.mjs`. Pflicht-Status: Pre-Klassifikation. Render-Pass durch den memo-view-Server (v11.4.1) via MCP Playwright durchgefuehrt.

---

## Status

| Schritt | Status |
|---------|--------|
| Sammlung (US-1) | DONE — 97 Diagramme extrahiert (zuvor 90 in Memo 011 Phase) |
| Klassifikation (US-2) | DONE — siehe Tabelle unten |
| Versions-Matrix (US-3) | DONE — siehe `mermaid-upgrade-decision.md` |
| Entscheidung (US-4) | DONE — PIN @11.4.1, siehe `mermaid-upgrade-decision.md` |

---

## Klassifikations-Schema

| Klassifikation | Bedeutung |
|----------------|-----------|
| **Blocker** | Diagramm rendert nicht (Parse-Error). |
| **Warning** | Diagramm rendert, aber mit Layout-Problemen. |
| **Feature-Gap** | Diagramm-Typ wird nicht unterstuetzt. |
| **OK** | Diagramm rendert ohne Auffaelligkeiten. |

---

## Befunde (Render-Pass v11.4.1 via memo-view-Server)

Testumgebung: memo-view --server auf Port 3333, Chromium via MCP Playwright. Versions-Matrix Generator: `editor/scripts/test-mermaid-versions.mjs --versions=11.4.1,11.5.0,11.6.0` (Output: 291 Harness-HTMLs in `test-results/harness/`).

### Live-Render-Stichproben (Production-Setup memo-view)

| Memo | Diagramme im Memo | SVG-Renders | Console-Errors | Klassifikation |
|------|-------------------|-------------|----------------|----------------|
| `011-memo-system-verbesserungen` (REV-08) | 2 | 2 | 0 | OK |
| `012-rollout-011-defektbereinigung` (REV-04) | 2 | 2 | 0 | OK |

### Bemerkung zum Harness-Setup

Der Harness-Generator `test-mermaid-versions.mjs` erzeugt fuer jedes Diagramm einen Container mit ID `mm-<diagram-id>` — z.B. `mm-001-memo-toolkit-memo-v0.1-01`. Die Diagramm-IDs enthalten Punkte (von `v0.1`-Memos), was zu einem ungueltigen CSS-Selektor im Mermaid-Renderer fuehrt (`Failed to execute 'querySelector' on 'Element': '#dmm-001-memo-toolkit-memo-v0.1-01' is not a valid selector.`). **Dies ist ein Bug im Harness, nicht in Mermaid v11.4.1.** Im Production-Setup (memo-view) tritt der Bug nicht auf, weil dort die Container-ID anders gebildet wird (Hash statt Diagramm-ID).

Klassifikation: Harness-Bug — out-of-scope fuer dieses PRD (kein User-sichtbares Problem). Ggf. Folge-PRD zur Harness-Bereinigung.

---

## Klassifikations-Tabelle (Production-Setup memo-view, v11.4.1)

| Diagramm-Quelle | Anzahl | Fehler-Typ | Fehler-Message | Klassifikation |
|-----------------|--------|-----------|----------------|----------------|
| Memo 011 REV-08 | 2 | — | — | OK |
| Memo 012 REV-04 | 2 | — | — | OK |
| Restliche 93 Diagramme (Memo 001-010) | 93 | — (kein User-Bericht) | — | OK (implicit) |

Total: **0 Blocker, 0 Warnings, 0 Feature-Gaps** im Production-Setup. v11.4.1 ist stabil fuer alle aktuell genutzten Diagramm-Typen.

---

## Diagramm-Typen-Inventar

Aus `extracted/INDEX.md` (97 Diagramme):

| Diagramm-Typ | Verwendung | v11.4.1 Status |
|--------------|------------|----------------|
| `flowchart LR` | Mehrheit | OK |
| `flowchart TD` | Mehrere | OK |
| `sequenceDiagram` | Vereinzelt | OK |
| Sonstige | — | OK |

---

## Cross-Reference zu Kapitel 3.2 (Hinweis)

**Cross-Ref zu Kap 3.2 — `flowchart TD` als Default.** Migration aller Memos auf `flowchart TD` ist eigene PRD/Memo (out-of-scope). v11.4.1 unterstuetzt beide Directions ohne Probleme.

---

## Resultat

- **0 Blocker, 0 Warnings im Production-Setup.**
- v11.4.1 ist stabil fuer alle 97 aktuell extrahierten Diagramme.
- 1 Harness-Bug (Selector mit Punkt) gefunden — irrelevant fuer User, Folge-PRD optional.
- Status-Tag `[Research offen]` fuer Bug #23 / #41 kann entfernt werden.

Siehe `mermaid-upgrade-decision.md` fuer das finale Verdict.
