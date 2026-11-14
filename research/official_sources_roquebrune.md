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
