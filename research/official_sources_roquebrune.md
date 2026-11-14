# Official flood-map source audit — Roquebrune-sur-Argens

Research date: 2026-11-15. **Research-only. No live alert thresholds or UI modified.**

## Verified sources

1. Préfecture du Var, commune Roquebrune-sur-Argens:
   https://www.var.gouv.fr/Actions-de-l-Etat/Risques-naturels-et-technologiques/Quels-risques-dans-ma-commune/Communes-de-O-a-R/Roquebrune-sur-Argens
   Official PPRI for Argens, Blavet and Fournel approved **2013-12-20**. The page links explanatory notes, regulatory zoning maps, and the flood zone atlas. **PPRI is a regulatory hazard/planning map, not a gauge-triggered ZIP.**

2. DDTM Var PPRI regulatory zoning dataset on data.gouv.fr:
   https://www.data.gouv.fr/datasets/zonage-reglementaire-du-plan-de-prevention-du-risque-inondation-ppri-sur-la-commune-de-roquebrune-sur-argens-var-1
   Published with Open Licence 2.0; metadata describes red/blue regulatory zones, low hydrographic zones and exceptional hazard. Dataset resource files, geospatial formats, boundaries and coordinate reference systems **not yet downloaded or checked**.

3. Vigicrues detailed ZIP/ZICH explanation:
   https://www.vigicrues.gouv.fr/ftp/Notice_detaillee_ZIP_et_ZICH.pdf
   ZIP = modelled potential inundation extent for specified reference gauge levels; ZICH = modelled depth classes. Neither describes actual current inundation or first overflow. The assumptions and uncertainties must accompany any future display.

4. Vigicrues station portal: https://www.vigicrues.gouv.fr/
   Station-specific ZIP/ZICH availability and corresponding modelled heights for **Y531201001** have **not been verified**. HydroPortail station/site code and Vigicrues reference station identifiers must be explicitly matched before associating any scenario.

5. HydroPortail historical site: https://www.hydro.eaufrance.fr/sitehydro/Y5312010/seuils
   Historical peaks are not first-overflow heights. Local March 2024 impacts remain eyewitness reports, not official thresholds.

## Evidence matrix

| Question | Current status |
|---|---|
| Is there an official local flood-risk map? | YES: PPRI 2013 |
| Is there an official PPRI dataset record? | YES: data.gouv.fr |
| Is there a verified ZIP/ZICH scenario for gauge Y531201001? | NOT VERIFIED |
| Is a ZIP/ZICH scenario height matched to this gauge and datum? | NO |
| Is first overflow height officially validated? | NO |
| Can PPRI zoning be used as an automated gauge alert threshold? | NO |

## Next technical checks

1. Inspect data.gouv.fr resource links, file formats, license and CRS; import PPRI as **static contextual layer only**, if appropriate.
2. Identify exact Vigicrues reference station corresponding to HydroPortail Y531201001; verify whether downloadable ZIP/ZICH scenarios exist, their height units and gauge zero.
3. Obtain scenario-specific PDF/documentation and capture source, version, model assumptions, mapped extent, uncertainty and station relation.
4. Repeat on selected major-river stations only after verifying river identity and operational relevance.
5. No automatic alert threshold should be derived from PPRI colors or a lowest ZIP/ZICH scenario. Obtain expert validation first.


## Follow-up: direct station cross-check (2026-11-15)

- Official HydroPortail station identity: https://hydro.eaufrance.fr/stationhydro/Y531201001/fiche — code Y531201001, L'Argens à Roquebrune-sur-Argens, station standard, surveillée; gauge-zero altitude listed as **5.82 m**, reference updated 2022-09-01. This is the gauge zero altitude, **not** a flood-warning threshold. Check altimetric reference system and historical changes before converting gauge height to absolute elevation.
- Official Sandre flood vigilance station listing: https://www.sandre.eaufrance.fr/Rechercher-une-donnee-d-un-jeu?ss_lbref_sandre=Station+de+vigilance+crues — Roquebrune-sur-Argens Y531201001 appears as validated vigilance station.
- Direct Vigicrues station page: https://www.vigicrues.gouv.fr/station/Y531201001 — generic ZIP/ZICH section and 'Télécharger les PDF des cartes ZIP/ZICH à la station' heading present, **but no specific scenario PDF, gauge height, scenario identifier or download URL exposed in publicly retrieved HTML**. This does **not** prove that no scenarios exist; JavaScript-driven station content may require further inspection.
- SPC Méditerranée-Est RIC: https://www.vigicrues.gouv.fr/uploads/RIC/RIC_SPC_ME.pdf — Roquebrune Y531201001 listed for Argens Aval. This is station context, not evidence of ZIP/ZICH availability.

**Next verification:** inspect the Vigicrues station interface or authoritative API for actual downloadable scenario records, capture their provenance, model version, reference gauge, height and geographic coverage; if none can be verified, request confirmation from SPC Méditerranée-Est. No automated threshold changes.


## Additional evidence: source limitations and station history (2026-11-15)

- DREAL Grand Est official explanation: https://www.grand-est.developpement-durable.gouv.fr/zone-d-inondation-potentielle-zip-a19620.html — ZIP is a **hypothetical scenario** tied to a reference gauge level, not a regulatory map or guaranteed actual flood extent. VIGInond national ZIP database is stated to be accessible to government services; some station ZIP PDFs are publicly exposed on Vigicrues. No Roquebrune-specific ZIP scenario has yet been independently retrieved.
- Official HydroPortail station history: https://hydro.eaufrance.fr/stationhydro/Y531201001/impression-fiche — the downstream **Iscles weir was modified in September 2020**, altering the local stage/discharge relation, especially at low to moderate flows. Historical stage comparisons and height-to-flow translations need to account for station changes. Also notes algae affecting the stage/discharge curve during 2023.
- The official Vigicrues v1.1 public API documentation (https://www.vigicrues.gouv.fr/services/v1.1) describes observations and forecasts; it does not establish a public endpoint for retrieving all ZIP/ZICH scenario polygons. Do not assume an undocumented ZIP API.
- User-provided property reference case: house entrance point 43.455547, 6.637652 (WGS84); IGN RGE ALTI point response z=10.66 m (user-reported from official query, not independently checked); survey plan labels a 'Seuil 11.03' m, **not yet verified as the entrance door or as NGF-IGN69**. March 2024 flood reportedly reached entrance but **did not enter the house**. Treat as local observation; cannot infer flood arrival threshold from equal-elevation arithmetic at a different river location.
- Research next action: ask SPC Méditerranée-Est whether ZIP/ZICH for station Y531201001 are published, and if so obtain scenario PDF, station reference datum, model year and georeferenced source; separately establish survey datum and entrance threshold. No production alerts changed.
