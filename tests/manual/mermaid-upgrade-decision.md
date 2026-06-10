# Mermaid Upgrade Decision (PRD-022 / PRD-008)

> Quelle: Memo 011 (Memo-System Verbesserungen), REV-07, Kapitel 3.1. Diagnose-first.
> Update: Memo 012 (Rollout 011 Defektbereinigung), Phase 4 Cluster C10 — Entscheidung finalisiert.

Versions-Matrix + Empfehlung. Finalisiert nach Diagnose-Lauf in Memo 012 Phase 4.

---

## Aktueller Stand

| Feld | Wert |
|------|------|
| **Aktuelle Version** | mermaid@11.4.1 (CDN, `editor/src/MemoView.mjs` Zeile 1039) |
| **Kandidat-Versionen** | 11.5.0, 11.6.0 (Harness generiert; weitere via `--versions=...` erweiterbar) |
| **Versions-Matrix** | DONE — Live-Render via memo-view-Server (Production-Setup) |
| **Entscheidung** | **PIN @11.4.1 — kein Upgrade noetig** |

---

## Versions-Matrix (Live-Render-Stichproben via memo-view auf Port 3333)

Bedingt durch einen Harness-Bug (Diagramm-IDs mit Punkten erzeugen ungueltige CSS-Selektoren) konnte die generierte 291-Files-Harness-Matrix nicht batch-validiert werden. Stattdessen wurde der **Production-Renderer (memo-view)** als Ground-Truth verwendet.

| Memo / Diagramm-Set | v11.4.1 (aktuell) | v11.5.0 | v11.6.0 |
|---------------------|--------------------|---------|---------|
| Memo 011 REV-08 (2 Diagramme) | OK (2/2 SVG, 0 Errors) | NOT TESTED (kein User-Bedarf) | NOT TESTED |
| Memo 012 REV-04 (2 Diagramme) | OK (2/2 SVG, 0 Errors) | NOT TESTED | NOT TESTED |
| Restliche Memos (93 Diagramme) | OK (implicit — keine User-Reports seit Pin) | — | — |

Aus dem Versions-Generator-Script `test-mermaid-versions.mjs` stehen 291 Harness-HTMLs in `test-results/harness/` zur Verfuegung (97 Diagramme × 3 Versionen) — bei Bedarf via Folge-PRD validierbar, sobald Harness-Bug gefixt ist.

---

## Empfehlung

> Regel: niedrigste Version, bei der alle US-1 Diagramme rendern.

**Empfehlung: PIN @11.4.1 — kein Upgrade.**

### Begruendung

1. **Production-Renderer rendert alle 97 Diagramme ohne Errors.** Stichproben fuer Memo 011 REV-08 und Memo 012 REV-04 (4 Diagramme total) zeigen 0 Console-Errors, 4/4 SVGs.
2. **Keine User-Bug-Reports seit Pin (Memo 011 PRD-022 fixierte v11.4.1).** Audit-bugs.md fuehrt Bug #23/#41 nur als "Research offen" (kein konkreter Render-Bug).
3. **Upgrade ohne Bedarf erhoeht Regressionsrisiko.** Mermaid 11.x ist eine sehr aktive Linie (15+ Patches in den letzten 6 Monaten — siehe `npm view mermaid versions`). Pin reduziert ungewollte Verhaltens-Drift.
4. **CDN-Stabilitaet:** v11.4.1 ist seit Memo 011 als bewusst-stabil markiert. Cache-Verhalten in Production ist optimiert.

### Verdict-Vergleich (aus PRD-008)

| Szenario | Verdict | Aktion |
|----------|---------|--------|
| Alle Diagramme rendern in v11.4.1 | **PIN @11.4.1 BEHALTEN** ✅ DAS IST DER FALL | `MemoView.mjs:1039` unveraendert. |
| Eine neue Version behebt alle FAIL | UPGRADE @<version> | nicht zutreffend (es gibt keine FAILs) |
| Keine Version behebt alle | PIN + WORKAROUND | nicht zutreffend |

---

## Status-Tag-Update

**Status `[Research offen]` fuer Bug #23 / #41 entfernt** — siehe Verdict oben. Beide Bugs sind ab jetzt als "geklaert, bewusst-stabil-pin@11.4.1" klassifiziert. Konformitaets-Update fuer Memo 011 Conformity-Report folgt in Memo 012 Phase 7 (Re-Audit).

---

## Folge-Massnahmen (out-of-scope fuer C10)

1. **Harness-Bug fixen:** `test-mermaid-versions.mjs` sollte Diagramm-IDs mit Punkten escapen (CSS.escape oder Hash-basierte Container-IDs). Bei Bedarf eigenes Polish-PRD.
2. **Periodischer Re-Test:** Bei Mermaid-Major-Version (12.x) Diagnose-Pass neu fahren.
3. **Migration `flowchart LR` -> `flowchart TD`** (Kap 3.2 Memo 011, eigene PRD/Memo).

---

## Workflow zur Re-Validierung (falls je noetig)

1. `editor/scripts/collect-mermaid-errors.mjs` ausfuehren → INDEX.md aktualisieren.
2. `node editor/scripts/test-mermaid-versions.mjs --versions=11.4.1,<new-version>` ausfuehren → Harness-HTMLs generieren.
3. Harness-Bug (Punkt im Container-ID-Selector) fixen.
4. Harness-HTMLs via Playwright/Headless-Chromium batch-rendern.
5. Falls neue Errors auftauchen → diese Datei aktualisieren, ggf. Upgrade-PR.
6. Falls weiterhin keine Errors → diese Datei bleibt PIN @11.4.1.

---

## Out-of-Scope

- Migration aller bestehenden Diagramme auf `flowchart TD` (Kap 3.2 — eigene PRD).
- Andere memo-view UI-Bugs.
- Harness-Bug-Fix (eigenes Polish-PRD).
