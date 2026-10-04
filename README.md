# 🧭 Notenkompass

Ein freies, werbe- und trackingfreies Noten-Tracking-Tool, das komplett im Browser läuft. Keine Anmeldung, kein Server, keine Cloud — alle Daten bleiben lokal auf deinem Gerät.

Notenkompass wurde ursprünglich für die Hessen-Abitur-Oberstufe (Abendschule) gebaut, ist aber bewusst neutral gehalten: Fächer, Halbjahre/Perioden und sogar das Notensystem lassen sich frei konfigurieren. Das Abitur-Berechnungsmodell (Block I/II, Leistungskurs-Gewichtung) ist ein optionales Modul mit Voreinstellungen für alle 16 Bundesländer, das du ein- oder ausschalten kannst.

## Features

- **Frei konfigurierbar**: beliebig viele Halbjahre/Perioden, frei benennbar; beliebig viele Fächer
- **Noten erfassen**: Klausuren, mündliche Noten, sonstige Leistungen – mit Punkten (0–15), Datum und Notiz
- **Übersicht & Auswertung**: Durchschnitte je Fach und Halbjahr, Trends, Fortschrittsanzeigen
- **Statistik-Werkzeuge**: Standardabweichung, Klausur-vs-Mündlich-Vergleich, Trendprognose (lineare Regression), Monte-Carlo-Simulation, Bootstrap-Konfidenzintervall, Korrelationsanalyse
- **Optionales Abitur/Fachabi-Modul** mit Voreinstellungen für alle 16 Bundesländer: Block-I/II-Hochrechnung, LK-Gewichtung, Grenznutzen-Analyse, Einbringungs-Optimierer
- **PDF-Export**: wähle frei, was exportiert wird (automatisch generierter Analysebericht, Noten, Fächerübersicht, Statistik), gefiltert nach Halbjahr
- **Datenportabilität**: Export/Import als JSON-Datei – nimm deine Daten mit auf ein anderes Gerät oder sichere sie
- **Dark Mode**
- **100% lokal**: alle Daten liegen ausschließlich in deinem Browser (`localStorage`). Es gibt keinen Server und keine Übertragung an Dritte.

## Loslegen

Notenkompass ist eine einzelne statische Webseite ohne Build-Schritt und ohne Backend.

1. Repository klonen oder als ZIP herunterladen
2. `index.html` im Browser öffnen (oder über einen simplen lokalen Webserver, z.B. `npx serve .`)
3. Der Einrichtungsassistent führt dich durch die Ersteinrichtung (Anzahl Halbjahre, Fächer, optionales Abitur-Modul)

Du kannst die Seite auch per GitHub Pages hosten (Settings → Pages → Branch `main`, Ordner `/`) und sie dir als Lesezeichen/PWA auf dem Smartphone ablegen.

### Daten sichern / übertragen

Da alle Daten nur lokal im Browser gespeichert werden, gehen sie z.B. beim Löschen der Browserdaten verloren. Nutze dafür in den **Einstellungen**:

- **⬇ Alle Daten exportieren (JSON)** – lädt eine Datei mit allen Noten, Fächern und Einstellungen herunter
- **⬆ Daten importieren** – lädt eine zuvor exportierte Datei wieder in die App (überschreibt den aktuellen Stand)

## Das Abitur/Fachabi-Modul

Standardmäßig ist dieses Modul deaktiviert. Aktiviert bildet es das bundesweite KMK-Gesamtqualifikationsmodell nach (Block I aus der Qualifikationsphase, max. 600 Punkte; Block II aus den Abiturprüfungen, max. 300 Punkte; Gesamt max. 900 Punkte, Note 1,0 ab 823 Punkten). In den Einstellungen wählst du dein **Bundesland** aus einer Liste aller 16 – das stellt automatisch die Anzahl der Leistungskurse/-fächer und Abiturprüfungsfächer passend ein (z.B. 2 LK/5 Prüfungsfächer in Hessen, 3 Leistungsfächer in Baden-Württemberg und Rheinland-Pfalz, 4 Prüfungsfächer in NRW). Eine "Benutzerdefiniert"-Option erlaubt es, diese Zahlen auch manuell zu setzen.

**Wichtige Einschränkung:** Das Tool rechnet ein **vereinfachtes Modell** – es bildet nicht die exakte Einbringungspflicht jedes Bundeslands nach (also *welche* einzelnen Kurse eingebracht werden müssen/dürfen), sondern nutzt den Durchschnitt aller eingetragenen Noten mit doppelter LK-Gewichtung. Die Bundesland-Parameter wurden anhand öffentlich zugänglicher Quellen (Kultusministerien, Schul-Informationsblätter, Stand 2025/26) recherchiert; die Datenqualität ist nicht für jedes Bundesland gleich gut abgesichert (wird in der App als Hinweis angezeigt, z.B. "Datenqualität: niedrig" für Saarland). Das Modul ist als **Orientierung** gedacht und ersetzt in keinem Bundesland eine verbindliche Prüfung durch deine Schule bzw. Oberstufenberatung – gleiche die Ergebnisse unbedingt ab, bevor du dich darauf verlässt.

Wenn dich dieses Modell nicht betrifft (andere Schulform, oder du willst einfach nur Noten tracken), lass es einfach deaktiviert – der Rest der App funktioniert unabhängig davon.

## Technik

- Reines HTML/CSS/JavaScript, keine Frameworks, kein Build-Schritt
- `js/storage.js`: kleine Persistenz-Schicht auf Basis von `localStorage`. Wer die App an ein anderes Backend anbinden möchte (z.B. IndexedDB oder einen Sync-Server), muss nur diese eine Datei austauschen – der Rest der App spricht ausschließlich mit `window.storage.get/set`.
- `js/app.js`: die gesamte Anwendungslogik
- `css/style.css`: Styling

## Mitmachen

Contributions sind willkommen! Siehe [CONTRIBUTING.md](CONTRIBUTING.md).

## Lizenz

[MIT](LICENSE)
