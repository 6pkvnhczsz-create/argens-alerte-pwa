# Roquebrune: Erste historische Regen–Pegel-Auswertung
Stand: 17.11.2026 · **Forschung, NICHT zur Live-Warnung freigegeben**

## Reproduzierbarer Datenlauf

- Code: [argens_rain_levels.py](./argens_rain_levels.py)
- Erfolgreiche erste Auswertung: [GitHub Actions 44067709192](https://github.com/6pkvnhczsz-create/argens-alerte-pwa/actions/runs/44067709192)
- Erweiterte Auswertung 2010–2024: [GitHub Actions 44068182009](https://github.com/6pkvnhczsz-create/argens-alerte-pwa/actions/runs/44068182009)
- Pegel Roquebrune: `Y531201001`; Quelle: Hub'Eau `obs_elab`, Größe `HIXnJ` (amtliche Tageshöchststände).
- Wetter: Météo-France `Données climatologiques de base - horaires`, Var (83), `RR1` stündlich UTC. Verwendete Archive: 2010–2019 und 2020–2024.
- Umfang: 6.159 Tage mit Pegeltagesmaxima von 2010 bis 16.11.2026; rund 3,89 Millionen gültige stündliche Regenbeobachtungen aus den beiden Archiven.

## Beobachtete Hochwasserfälle

| Datum UTC | Höchster Pegel des Tages | Vorheriges Tagesmaximum | Differenz Tagesmaxima | Regen in 2 Kalendertagen an ausgewählter Wetterstation |
| --- | ---: | ---: | ---: | --- |
| 15.06.2010 | 7,709 m | 1,540 m | +6,169 m | Les Arcs: 374,0 mm |
| 06.11.2011 | 6,641 m | 5,949 m | +0,692 m | Seillans: 297,9 mm |
| 19.01.2014 | 6,467 m | 5,329 m | +1,138 m | Entrecasteaux: 147,2 mm |
| 23.11.2019 | 7,124 m | 3,934 m | +3,190 m | Entrecasteaux: 252,0 mm; Les Mayons: 239,0 mm |
| 02.12.2019 | 6,155 m | 6,099 m | +0,056 m | Vidauban: 154,7 mm (150,2 mm am Vortag) |
| 10.03.2024 | 6,220 m | 2,988 m | +3,232 m | Seillans: 145,0 mm; Fréjus Mont Vinaigre: 135,0 mm |
| 27.10.2024 | 6,182 m | 5,772 m | +0,410 m | Les Mayons: 141,1 mm |

**Wichtige Definition:** Die Differenz zweier Tagesmaxima ist NICHT der wahre Anstieg des Pegels binnen 24 Stunden. Die höchsten Werte können zu unterschiedlichen Zeiten auftreten. Ebenso ist der hier genannte Regen das Zweitagesergebnis einer einzelnen Wetterstation, kein flächengewichtetes Einzugsgebietsmittel. Schon deshalb ist aus diesen Paaren keine direkte mm→cm-Prognose ableitbar.

## Explorative historische Häufigkeiten (keine Vorhersagewahrscheinlichkeiten)

Für jeden Tag wurde das Maximum der Regenmengen an fünf Stationen
(Entrecasteaux, Les Arcs, Draguignan, Vidauban, Les Mayons)
**in den zwei vollständigen Tagen D-1 und D-2 vor dem Pegeltag D**
bestimmt (mindestens drei vollständige Stationsmessreihen).
Verglichen mit dem Pegeltagesmaximum D:

| Höchster 48-h-Regenwert (mm), vor dem Pegeltag | Auswertbare Tage | Davon Tagespegel ≥ 5,40 m |
|---|---:|---:|
| 0–25 | 4.966 | 3 |
| 25–50 | 286 | 1 |
| 50–100 | 147 | 6 |
| 100–150 | 29 | 6 |
| 150–250 | 10 | 6 |
| ≥ 250 | 4 | 3 |

**Nicht kalibriert und nicht einsatzbereit:** Bei Regenbeginn am Pegeltag (z. B. dem katastrophalen Hochwasser 15.06.2010) kann die *vorherige* Zweitagesmenge 0 sein, obwohl tagsüber hunderte mm fallen. Die Tabelle weist dann zwangsläufig einen scheinbaren „Fehlfall“ aus. Sich überschneidende Ereignistage sind außerdem nicht statistisch unabhängig. Die Stichproben ab 100 mm sind klein. Die Werte dürfen nicht als Warnwahrscheinlichkeiten oder Auslöseschwellen veröffentlicht werden.

## Nächster nötiger Schritt

1. Hochaufgelöste historische Pegelkurven aus dem **HydroPortail-Archiv** beschaffen (nicht die Hub'Eau-Echtzeit-API, die nur ~30 Tage hält).
2. Den Regen *stundenweise*, für mehrere tatsächlich oberhalb liegende Einzugsgebiete, mit Wasserstandsanstieg und Zeitversatz korrelieren.
3. Den bereits hohen Ausgangspegel, vorangegangenen Regen und Oberliegerstationen einbeziehen.
4. Ereignisweise bzw. jahresweise blind testen und Fehlwarnungen / Vorlaufzeiten dokumentieren.
5. Nur als separat gekennzeichnete experimentelle Vorhersage starten; bestehende Warnlogik und Push vollständig unverändert lassen.

## Referenzen

- [Hub'Eau Hydrometrie](https://hubeau.eaufrance.fr/page/api-hydrometrie)
- [Météo-France Stundenarchiv](https://www.data.gouv.fr/datasets/donnees-climatologiques-de-base-horaires)
- [Historisches HydroPortail-Archiv](https://www.data.gouv.fr/datasets/donnees-aux-stations-hydrometriques)
- [HydroPortail historische Pegelschwellen Roquebrune](https://www.hydro.eaufrance.fr/sitehydro/Y5312010/seuils)

**Produktive Warnmeldungen, Push und individuelle Schwellen wurden nicht verändert.**
