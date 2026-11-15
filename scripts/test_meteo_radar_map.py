#!/usr/bin/env python3
"""Offline georeferencing and PNG smoke test. No API key or network needed."""
import io
import unittest

import h5py
import numpy as np
from PIL import Image
from pyproj import CRS, Transformer

from sync_meteo_radar_map import raw_to_image, geographic_grid


class RadarGeoTests(unittest.TestCase):
    def make_mosaic(self, h5):
        shape = (300, 400)
        crs = CRS.from_proj4("+proj=stere +lat_0=45 +lon_0=0 +datum=WGS84 +units=m +no_defs")
        forward = Transformer.from_crs("EPSG:4326", crs, always_xy=True)
        inverse = Transformer.from_crs(crs, "EPSG:4326", always_xy=True)
        cx, cy = forward.transform(6.35, 43.5)
        ll = inverse.transform(cx - 100000, cy - 75000)
        ur = inverse.transform(cx + 100000, cy + 75000)
        where = h5.create_group("where")
        for name, value in [
            ("projdef", crs.to_proj4()), ("LL_lon", ll[0]), ("LL_lat", ll[1]),
            ("UR_lon", ur[0]), ("UR_lat", ur[1]),
        ]:
            where.attrs[name] = value
        data = np.zeros(shape, dtype=np.uint16)
        data[130:170, 180:220] = 120  # 1.2 mm per 5 min at one patch
        h5.create_dataset("dataset1/data1/data", data=data)
        h5.create_group("dataset1/data1/what").attrs["gain"] = 0.01

    def test_mosaic_generates_valid_mercator_overlay(self):
        with h5py.File("synthetic.h5", "w", driver="core", backing_store=False) as h5:
            self.make_mosaic(h5)
            row, col, inside, source = geographic_grid(h5, (300, 400))
            self.assertEqual(source, "odim_where")
            self.assertGreater(inside.mean(), 0.97)
            png, coverage, wet, source = raw_to_image(h5)
            self.assertGreater(coverage, 95)
            self.assertGreater(wet, 0)
            image = Image.open(io.BytesIO(png))
            self.assertEqual(image.size, (720, 500))
            self.assertEqual(image.mode, "RGBA")
            self.assertGreater(np.asarray(image)[:, :, 3].max(), 0)

    def test_missing_georeferencing_does_not_make_unverified_map(self):
        with h5py.File("synthetic.h5", "w", driver="core", backing_store=False) as h5:
            h5.create_dataset("dataset1/data1/data", data=np.zeros((200, 200), dtype=np.uint16))
            with self.assertRaisesRegex(ValueError, "Missing source georeferencing"):
                raw_to_image(h5)


if __name__ == "__main__":
    unittest.main()
