# Contributing

Danke für dein Interesse, zu Notenkompass beizutragen!

## Projektphilosophie

- **Keine Server-Abhängigkeit**: Die App muss ohne Backend funktionieren, alle Daten bleiben lokal im Browser.
- **Neutral & konfigurierbar**: Keine fest eingebauten Annahmen über ein bestimmtes Bundesland, Schulsystem oder eine bestimmte Fächerliste. Spezialfälle (wie das Hessen-Abitur-Modell) gehören als optionales, abschaltbares Modul umgesetzt, nicht in den Kernpfad.
- **Keine Build-Pipeline**: reines HTML/CSS/JS. Wenn das für eine Änderung zu einschränkend wird, bitte vorher ein Issue aufmachen und diskutieren.
- **Keine Tracking-/Analytics-Skripte, kein externer Aufruf ohne Zustimmung.**

## Lokal entwickeln

Es gibt keinen Build-Schritt. Einfach `index.html` im Browser öffnen, oder z.B. mit `npx serve .` lokal servieren (für manche Browser-Features wie `fetch` auf lokale Dateien empfehlenswert).

## Lokales Testen (vor dem PR)

Bevor du einen Pull Request öffnest, prüfe deine Änderungen bitte lokal:

1. **Syntax-Check:** Führe `node --check js/app.js` aus, um sicherzustellen, dass es keine Syntaxfehler gibt.
2. **Manuelles Testen:** Öffne `index.html` im Browser und klicke die App manuell durch (Ersteinrichtung, Noten eintragen, PDF-Export testen).
3. **Zukünftige Tests:** Wir planen, Playwright-Tests hinzuzufügen (siehe #15). Bis dahin ist manuelles Testen der Standard.

## Pull Requests

1. Fork + Branch von `main`
2. Änderung möglichst klein und fokussiert halten
3. Vor dem PR: `node --check js/app.js` ausführen und die App manuell testen (siehe oben)
4. PR-Beschreibung: was wurde geändert und warum

## Issues

Bugs, Feature-Wünsche und Fragen gerne als GitHub Issue. Bitte bei Bugs möglichst Browser + Schritte zur Reproduktion angeben.

## Neue Module/Berechnungsmodelle für andere Bundesländer/Schulformen

Sehr willkommen! Bitte nach dem Vorbild des bestehenden Abitur/Fachabi-Moduls (Hessen) als eigenes, standardmäßig deaktiviertes Modul umsetzen, das den Rest der App nicht beeinflusst, wenn es ausgeschaltet ist.
