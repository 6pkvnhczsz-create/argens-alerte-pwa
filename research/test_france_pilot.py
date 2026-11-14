#!/usr/bin/env python3
"""Offline safety and selection regression checks for the France station pilot."""
import importlib.util
import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("france_pilot", ROOT / "france_pilot.py")
pilot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pilot)

def station(code, river, lat=46.0, lon=2.0):
    return {
        "code_station": code,
        "libelle_station": "Research test station",
        "libelle_cours_eau": river,
        "latitude_station": lat,
        "longitude_station": lon,
    }

class PilotSafetyTests(unittest.TestCase):
    def test_french_articles_and_accents(self):
        for name in ("La Seine", "la seine", "SEINE"):
            self.assertEqual(pilot.normalize_name(name), "seine")
        self.assertEqual(pilot.normalize_name("Le Rhône"), "rhone")
        self.assertEqual(pilot.normalize_name("L’Argens"), "argens")

    def test_known_homonyms_never_selected(self):
        rows = [
            station("M036151501", "Le Rhône"),
            station("K163301001", "La Somme"),
            station("V123456701", "Le Rhône", 45.0, 4.5),
            station("E123456701", "La Somme", 49.0, 2.0),
        ]
        result = pilot.select_river_review_candidates(rows, set())
        by_river = {river: code for river, code, *_ in result}
        self.assertEqual(by_river["Rhone"], "V123456701")
        self.assertEqual(by_river["Somme"], "E123456701")
        self.assertFalse(set(by_river.values()) & set(pilot.AMBIGUOUS_RIVER_CODES))

    def test_excluded_and_outside_metropolitan_area(self):
        rows = [
            station("A000000001", "La Seine"),
            station("A000000002", "La Seine", 46, 2),
            station("A000000003", "La Seine", 10, 2),
        ]
        result = pilot.select_river_review_candidates(rows, {"A000000001"})
        self.assertEqual([code for _, code, *_ in result], ["A000000002"])

    def test_research_reference_is_not_validated_threshold(self):
        self.assertEqual(pilot.REFERENCE["zip_zich_status"], "not_checked")
        self.assertNotIn("officially_validated", pilot.REFERENCE["review_status"])
        self.assertEqual(pilot.REFERENCE["scenario_height_m"], "")

if __name__ == "__main__":
    unittest.main()
