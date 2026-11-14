# France-wide station and flood-impact data pilot

This research workflow **does not alter the live app**, alerts, or user settings.

## What it currently does
- Downloads Hub'Eau's hydrometric station reference via its public API.
- Picks 30 stations across metropolitan France using deterministic spatial spread, plus the fixed Roquebrune-sur-Argens reference station.
- Produces `stations.csv`, `source_review.csv`, `flood_river_candidates.csv`, `missing_target_rivers.txt`, and `summary.json` as a GitHub Actions artifact.
- The second cohort selects at most one additional station on each of 15 named rivers (Seine, Loire, Garonne, Rhône, Saône, Meuse, Moselle, Somme, Oise, Marne, Dordogne, Adour, Aude, Vilaine, Argens). Exact river-name matching is only a reproducible starting point, **not** an official flood-risk classification or suitability assessment.
- Both cohorts appear in `source_review.csv`, with empty official-evidence fields and `threshold_usable=no`.
- `source_review.csv` is an auditable manual verification queue with station-specific HydroPortail links, empty evidence fields and `threshold_usable=no`. A portal link is **not** proof that ZIP/ZICH data exist for the station.
- Marks ZIP/ZICH coverage and local flood impact **unverified** until independently checked.

## How to run
GitHub → Actions → **France station data pilot** → Run workflow.
Download the artifact `france-station-pilot` from the run. The workflow also runs automatically when the pilot script changes.

## Sources to check for each station
- Hub'Eau hydrometric API: https://hubeau.eaufrance.fr/api/v2/hydrometrie
- Vigicrues station and ZIP/ZICH scenarios: https://www.vigicrues.gouv.fr/
- Vigicrues API: https://www.vigicrues.gouv.fr/services/v1.1
- National flood-impact maps / VIGInond: scenario documentation and geodata from official producers
- HydroPortail for station reference levels and historical events: https://www.hydro.eaufrance.fr/

## Next validation stage (official ZIP/ZICH retrieval and verification not yet implemented)
1. Obtain documented machine-readable ZIP/ZICH dataset endpoints, licenses and schema.
2. Map station identifiers to scenarios; verify local gauge datum and scenario height units.
3. Inspect scenario footprint and documentation; distinguish a mapped scenario from the **first overflow**.
4. Cross-check against historical observations and local official hazard documentation.
5. Review candidate thresholds with a qualified hydrology/flood-risk expert before publication.

**Do not infer orange/red thresholds from the lowest ZIP/ZICH scenario, nor assume absence of a mapped scenario means safety.**
