"""PHASE ETL: StaMPS PSInSAR CSV → GeoParquet 1.1 + browser buffers.

Run from the project root:

    python -m etl.build [--csv merged_final_with_dates.csv]

Outputs
  data/processed/los_points.parquet     GeoParquet 1.1, Hilbert-sorted, pid = row index
  data/web/base.arrow(.gz)              resident GPU buffer (Arrow IPC stream)
  data/web/disp_i16.bin                 point-major int16 displacement (mm × 4), E per point
  data/web/hex_r{6..9}.arrow(.gz)       H3 aggregates + mean displacement series
  data/web/ref_candidates.json          ranked stable-area reference candidates
  data/web/meta.json                    dates, extents, colour-scale percentiles, histograms
  data/metadata/stac_item.json          STAC 1.0 item
  data/metadata/validation.json         round-trip checks
"""

from __future__ import annotations

import argparse
import datetime as dt
import gzip
import json
import os
import shutil
import time

import duckdb
import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq

from .model import fit_all, decimal_year

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT_PROCESSED = os.path.join(ROOT, "data", "processed")
OUT_WEB = os.path.join(ROOT, "data", "web")
OUT_META = os.path.join(ROOT, "data", "metadata")

ROW_GROUP = 100_000
BATCH = 262_144
DISP_SCALE = 4          # int16 = round(mm × 4) → 0.25 mm resolution, ±8191 mm range
HEX_RES = (6, 7, 8)
WAVELENGTH_MM = 55.465763

PROJJSON_CRS84 = {
    "$schema": "https://proj.org/schemas/v0.7/projjson.schema.json",
    "type": "GeographicCRS",
    "name": "WGS 84 (CRS84)",
    "datum": {"type": "GeodeticReferenceFrame", "name": "World Geodetic System 1984",
              "ellipsoid": {"name": "WGS 84", "semi_major_axis": 6378137, "inverse_flattening": 298.257223563}},
    "coordinate_system": {"subtype": "ellipsoidal", "axis": [
        {"name": "Geodetic longitude", "abbreviation": "Lon", "direction": "east", "unit": "degree"},
        {"name": "Geodetic latitude", "abbreviation": "Lat", "direction": "north", "unit": "degree"}]},
    "id": {"authority": "OGC", "code": "CRS84"},
}


def log(msg: str, t0: float) -> None:
    print(f"[{time.time() - t0:7.1f}s] {msg}", flush=True)


def point_wkb(lon: np.ndarray, lat: np.ndarray) -> pa.Array:
    """Little-endian WKB Point (21 bytes each), built without a Python loop."""
    n = len(lon)
    buf = np.empty((n, 21), np.uint8)
    buf[:, 0] = 1
    buf[:, 1:5] = np.frombuffer(np.uint32(1).tobytes(), np.uint8)
    buf[:, 5:13] = lon.astype("<f8").view(np.uint8).reshape(n, 8)
    buf[:, 13:21] = lat.astype("<f8").view(np.uint8).reshape(n, 8)
    offsets = np.arange(0, 21 * (n + 1), 21, dtype=np.int32)
    return pa.Array.from_buffers(pa.binary(), n, [None, pa.py_buffer(offsets), pa.py_buffer(buf.tobytes())])


def gz(path: str) -> int:
    with open(path, "rb") as src, gzip.open(path + ".gz", "wb", compresslevel=9) as dst:
        shutil.copyfileobj(src, dst, 1 << 22)
    return os.path.getsize(path + ".gz")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", default=os.path.join(ROOT, "merged_final_with_dates.csv"))
    args = ap.parse_args()
    t0 = time.time()
    for d in (OUT_PROCESSED, OUT_WEB, OUT_META):
        os.makedirs(d, exist_ok=True)

    con = duckdb.connect()
    con.execute("SET threads = 12")
    con.execute("LOAD spatial")

    # ── 1 · ingest ──────────────────────────────────────────────────────────
    con.execute(f"CREATE TABLE raw AS SELECT * FROM read_csv('{args.csv.replace(os.sep, '/')}', header = true)")
    cols = [r[0] for r in con.execute("DESCRIBE raw").fetchall()]
    date_cols = cols[3:]
    dates = [dt.datetime.strptime(c, "%d/%m/%Y").date() for c in date_cols]
    names = [f"d_{d:%Y%m%d}" for d in dates]
    t = decimal_year(dates)
    n_in = con.execute("SELECT count(*) FROM raw").fetchone()[0]
    log(f"ingested {n_in:,} rows, {len(dates)} epochs {dates[0]} → {dates[-1]}", t0)

    # ── 2 · Hilbert sort (pid = row index afterwards) ──────────────────────
    minx, miny, maxx, maxy = con.execute(
        "SELECT min(Longitude), min(Latitude), max(Longitude), max(Latitude) FROM raw").fetchone()
    sel = ", ".join(f'"{c}"::FLOAT AS {n}' for c, n in zip(date_cols, names))
    con.execute(f"""
        CREATE TABLE s AS
        SELECT Longitude AS lon, Latitude AS lat, "Average LOS"::FLOAT AS vel_avg, {sel}
        FROM raw
        ORDER BY ST_Hilbert(Longitude, Latitude,
                 {{'min_x': {minx}, 'min_y': {miny}, 'max_x': {maxx}, 'max_y': {maxy}}}::BOX_2D)
    """)
    con.execute("DROP TABLE raw")
    cols_np = con.execute("SELECT * FROM s").fetchnumpy()
    lon = np.asarray(cols_np["lon"], np.float64)
    lat = np.asarray(cols_np["lat"], np.float64)
    vel_avg = np.asarray(cols_np["vel_avg"], np.float32)
    D = np.column_stack([np.asarray(cols_np[n], np.float32) for n in names])
    del cols_np
    n = len(lon)
    log(f"hilbert-sorted {n:,} points", t0)

    # duplicate rounded coordinates
    key = (np.round(lon * 1e5).astype(np.int64) << 32) | np.round(lat * 1e5).astype(np.int64)
    _, inv, counts = np.unique(key, return_inverse=True, return_counts=True)
    dup_n = np.minimum(counts[inv], 255).astype(np.uint8)

    # ── 3 · model fit ─────────────────────────────────────────────────────
    m = fit_all(D, t)
    tc = m.pop("_tc")
    log(f"model fitted; corr(vel_avg, vel_fit) = {np.corrcoef(vel_avg, m['vel'])[0, 1]:.3f}", t0)

    # ── 4 · GeoParquet 1.1 ────────────────────────────────────────────────
    pid = np.arange(n, dtype=np.uint32)
    lon32, lat32 = lon.astype(np.float32), lat.astype(np.float32)
    bbox = pa.StructArray.from_arrays([pa.array(lon32), pa.array(lat32), pa.array(lon32), pa.array(lat32)],
                                      names=["xmin", "ymin", "xmax", "ymax"])
    fields = {
        "pid": pid, "lon": lon, "lat": lat, "vel_avg": vel_avg,
        "vel": m["vel"], "vel_sigma": m["vel_sigma"], "vel_recent": m["vel_recent"], "accel": m["accel"],
        "seas_amp": m["seas_amp"], "seas_peak_doy": m["seas_peak_doy"],
        "seas_sin": m["seas_sin"], "seas_cos": m["seas_cos"], "c0": m["c0"],
        "rmse": m["rmse"], "r2": m["r2"], "disp_total": m["disp_total"], "jump_max": m["jump_max"],
        "n_outliers": m["n_outliers"], "quality": m["quality"], "dup_n": dup_n,
    }
    table = pa.table({k: pa.array(v) for k, v in fields.items()})
    for j, name in enumerate(names):
        table = table.append_column(name, pa.array(D[:, j]))
    table = table.append_column("bbox", bbox).append_column("geometry", point_wkb(lon, lat))

    geo = {
        "version": "1.1.0",
        "primary_column": "geometry",
        "columns": {"geometry": {
            "encoding": "WKB", "geometry_types": ["Point"], "crs": PROJJSON_CRS84,
            "bbox": [float(minx), float(miny), float(maxx), float(maxy)],
            "covering": {"bbox": {"xmin": ["bbox", "xmin"], "ymin": ["bbox", "ymin"],
                                  "xmax": ["bbox", "xmax"], "ymax": ["bbox", "ymax"]}},
        }},
    }
    los_meta = {
        "sensor": "Sentinel-1 C-band SAR", "processor": "StaMPS PS", "orbit": "ascending",
        "units": "mm (displacement), mm/yr (velocity)", "reference": "scene mean (StaMPS default)",
        "sign": "negative = away from satellite", "dates": [d.isoformat() for d in dates],
        "t_decimal_years": t.tolist(), "model_tc": tc,
        "model": "d(t) = c0 + vel·(t−tc) + ½·accel·(t−tc)² + seas_sin·sin(2πt) + seas_cos·cos(2πt)",
    }
    table = table.replace_schema_metadata({b"geo": json.dumps(geo).encode(), b"los": json.dumps(los_meta).encode()})
    gpq_path = os.path.join(OUT_PROCESSED, "los_points.parquet")
    float_cols = [f.name for f in table.schema if pa.types.is_floating(f.type)]
    pq.write_table(table, gpq_path, row_group_size=ROW_GROUP, compression="zstd", compression_level=9,
                   write_statistics=True, use_dictionary=False, use_byte_stream_split=float_cols)
    log(f"GeoParquet written: {os.path.getsize(gpq_path) / 2**20:.1f} MB "
        f"({pq.ParquetFile(gpq_path).num_row_groups} row groups)", t0)
    del table

    # ── 5 · resident browser buffer ───────────────────────────────────────
    # lon/lat: source precision is 1e-5 deg, so integer 1e-5 units are exact. Delta-encoded in
    # Hilbert order they compress ~3x better; the browser worker restores them with a prefix sum.
    ilon = np.round(lon * 1e5).astype(np.int64)
    ilat = np.round(lat * 1e5).astype(np.int64)
    base = pa.table({
        "dlon": np.diff(ilon, prepend=0).astype(np.int32), "dlat": np.diff(ilat, prepend=0).astype(np.int32),
        "vel": np.clip(np.round(vel_avg * 100), -32767, 32767).astype(np.int16),
        "accel": np.clip(np.round(m["accel"] * 100), -32767, 32767).astype(np.int16),
        "seas": np.clip(np.round(m["seas_amp"] * 4), 0, 255).astype(np.uint8),
        "quality": m["quality"], "dup": dup_n,
    })
    base_path = os.path.join(OUT_WEB, "base.arrow")
    with pa.OSFile(base_path, "wb") as f, pa.ipc.new_stream(f, base.schema) as w:
        for b in base.to_batches(max_chunksize=BATCH):
            w.write_batch(b)
    log(f"base.arrow {os.path.getsize(base_path) / 2**20:.1f} MB → gz {gz(base_path) / 2**20:.1f} MB", t0)

    # ── 6 · point-major int16 displacement ───────────────────────────────
    disp_path = os.path.join(OUT_WEB, "disp_i16.bin")
    np.clip(np.round(D * DISP_SCALE), -32767, 32767).astype("<i2").tofile(disp_path)
    log(f"disp_i16.bin {os.path.getsize(disp_path) / 2**20:.1f} MB", t0)
    # StaMPS master estimate: epoch with the smallest spread across points
    spread = D[::7].std(axis=0)
    del D

    # ── 7 · H3 aggregates with mean series ───────────────────────────────
    con.execute("INSTALL h3 FROM community; LOAD h3")
    con.execute(f"CREATE VIEW p AS SELECT * FROM read_parquet('{gpq_path.replace(os.sep, '/')}')")
    series = ", ".join(f"round(avg({nm} - {names[0]}) * {DISP_SCALE})::SMALLINT" for nm in names)
    hex_counts = {}
    for res in HEX_RES:
        tbl = con.execute(f"""
            SELECT h3_h3_to_string(h) AS h3, n, vel_mean, vel_p10, vel_p90, vel_std, accel_mean,
                   seas_mean, rmse_mean, quality_mean, series
            FROM (
              SELECT h3_latlng_to_cell(lat, lon, {res}) AS h, count(*)::INT AS n,
                     avg(vel_avg)::FLOAT AS vel_mean,
                     quantile_cont(vel_avg, 0.1)::FLOAT AS vel_p10,
                     quantile_cont(vel_avg, 0.9)::FLOAT AS vel_p90,
                     coalesce(stddev_samp(vel_avg), 0)::FLOAT AS vel_std,
                     avg(accel)::FLOAT AS accel_mean, avg(seas_amp)::FLOAT AS seas_mean,
                     avg(rmse)::FLOAT AS rmse_mean, avg(quality)::FLOAT AS quality_mean,
                     [{series}] AS series
              FROM p GROUP BY 1)
            ORDER BY h
        """).fetch_arrow_table()
        idx = tbl.schema.get_field_index("series")
        flat = pa.array(np.asarray(tbl.column("series").combine_chunks().flatten(), np.int16))
        tbl = tbl.set_column(idx, "series", pa.FixedSizeListArray.from_arrays(flat, len(names)))
        path = os.path.join(OUT_WEB, f"hex_r{res}.arrow")
        with pa.OSFile(path, "wb") as f, pa.ipc.new_stream(f, tbl.schema) as w:
            w.write_table(tbl)
        hex_counts[res] = tbl.num_rows
        log(f"hex r{res}: {tbl.num_rows:,} cells, {os.path.getsize(path) / 2**20:.1f} MB → gz {gz(path) / 2**20:.2f} MB", t0)

    # ── 7b · stable-area reference candidates (no GNSS available) ────────
    rows = con.execute(f"""
        WITH c AS (
          SELECT h3_latlng_to_cell(lat, lon, 8) AS h, count(*) AS n,
                 avg(vel_avg) AS v, stddev_samp(vel_avg) AS vs, avg(rmse) AS r,
                 avg(seas_amp) AS sa, avg(abs(accel)) AS ac,
                 [{", ".join(f"avg({nm})" for nm in names)}] AS series
          FROM p GROUP BY 1 HAVING count(*) >= 50),
        z AS (
          SELECT *, abs(v) / nullif(stddev_pop(v) OVER (), 0)
                  + vs / nullif(avg(vs) OVER (), 0)
                  + r / nullif(avg(r) OVER (), 0)
                  + 0.5 * sa / nullif(avg(sa) OVER (), 0)
                  + 0.5 * ac / nullif(avg(ac) OVER (), 0) AS score
          FROM c)
        SELECT h3_h3_to_string(h), h3_cell_to_lng(h), h3_cell_to_lat(h), n, v, vs, r, sa, ac, score, series
        FROM z ORDER BY score LIMIT 60
    """).fetchall()
    cands, taken = [], []
    for r in rows:  # keep spatially spread candidates (≥ 5 km apart)
        if any(np.hypot((r[1] - a) * np.cos(np.radians(r[2])), r[2] - b) < 0.045 for a, b in taken):
            continue
        taken.append((r[1], r[2]))
        cands.append({"h3": r[0], "lon": r[1], "lat": r[2], "n": r[3], "vel_mean": r[4], "vel_std": r[5],
                      "rmse_mean": r[6], "seas_mean": r[7], "accel_abs_mean": r[8], "score": r[9],
                      "series": [round(x, 3) for x in r[10]]})
        if len(cands) == 20:
            break
    with open(os.path.join(OUT_WEB, "ref_candidates.json"), "w") as f:
        json.dump(cands, f)
    log(f"{len(cands)} reference candidates", t0)

    # ── 8 · meta.json ─────────────────────────────────────────────────────
    def pct(a):
        qs = [0.01, 0.02, 0.05, 0.25, 0.5, 0.75, 0.95, 0.98, 0.99]
        return dict(zip([f"p{int(q * 100):02d}" for q in qs], np.quantile(a, qs).round(3).tolist()))

    disp_rel_last = m["disp_total"]
    edges = np.arange(-60, 26, 1.0)
    hist, _ = np.histogram(np.clip(vel_avg, -59.99, 24.99), bins=edges)
    meta = {
        "name": "PHASE · PSInSAR LOS deformation",
        "count": int(n), "epochs": len(dates),
        "dates": [d.isoformat() for d in dates], "t": t.round(6).tolist(), "tc": tc,
        "bbox": [float(minx), float(miny), float(maxx), float(maxy)],
        "sensor": los_meta["sensor"], "processor": "StaMPS", "orbit": "ascending",
        "heading_deg": -10.0, "look_azimuth_deg": 80.0, "incidence_default_deg": 39.0,
        "wavelength_mm": WAVELENGTH_MM, "reference": "scene mean (StaMPS default)",
        "sign": "negative = away from satellite", "disp_scale": DISP_SCALE, "vel_scale": 100, "accel_scale": 100, "seas_scale": 4,
        "master_estimate": dates[int(np.argmin(spread))].isoformat(),
        "stats": {"vel": pct(vel_avg), "vfit": pct(m["vel"]), "accel": pct(m["accel"]),
                  "seas_amp": pct(m["seas_amp"]), "rmse": pct(m["rmse"]),
                  "disp_total": pct(disp_rel_last)},
        "vel_hist": {"edges": edges.tolist(), "counts": hist.tolist()},
        "hex": {str(k): v for k, v in hex_counts.items()},
        "duplicates": int((dup_n > 1).sum()),
        "files": {"base": "base.arrow", "disp": "disp_i16.bin",
                  "hex": {str(r): f"hex_r{r}.arrow" for r in HEX_RES}},
        "events": [{"date": "2021-12-23", "label": "Sentinel-1B lost"}],
    }
    with open(os.path.join(OUT_WEB, "meta.json"), "w") as f:
        json.dump(meta, f, indent=1)
    log(f"meta.json (master ≈ {meta['master_estimate']})", t0)

    # ── 9 · STAC item ─────────────────────────────────────────────────────
    stac = {
        "type": "Feature", "stac_version": "1.0.0", "id": "phase-los-points",
        "geometry": {"type": "Polygon", "coordinates": [[[minx, miny], [maxx, miny], [maxx, maxy], [minx, maxy], [minx, miny]]]},
        "bbox": [minx, miny, maxx, maxy],
        "properties": {"start_datetime": f"{dates[0]}T00:00:00Z", "end_datetime": f"{dates[-1]}T00:00:00Z",
                       "datetime": None, "platform": "sentinel-1", "instruments": ["c-sar"],
                       "sar:frequency_band": "C", "sat:orbit_state": "ascending",
                       "processing:software": {"StaMPS": "PS"}, "table:row_count": int(n)},
        "assets": {"data": {"href": "../processed/los_points.parquet",
                            "type": "application/vnd.apache.parquet", "roles": ["data"]}},
    }
    with open(os.path.join(OUT_META, "stac_item.json"), "w") as f:
        json.dump(stac, f, indent=1)

    # ── 10 · validation ───────────────────────────────────────────────────
    chk = duckdb.connect()
    chk.execute("LOAD spatial")
    g = gpq_path.replace(os.sep, "/")
    n_out = chk.execute(f"SELECT count(*) FROM read_parquet('{g}')").fetchone()[0]
    nan = chk.execute(f"SELECT count(*) FROM read_parquet('{g}') WHERE isnan(vel) OR isnan(rmse)").fetchone()[0]
    csvp = args.csv.replace(os.sep, "/")
    diff = chk.execute(f"""
        WITH s AS (SELECT * FROM read_parquet('{g}') USING SAMPLE 1000 ROWS),
        j AS (  -- duplicate coordinates join to several CSV rows: keep the best match per pid
          SELECT s.pid, min(abs(s.vel_avg - c."Average LOS") + abs(s.{names[-1]} - c."{date_cols[-1]}")) AS e,
                 arg_min(abs(s.vel_avg - c."Average LOS"), abs(s.vel_avg - c."Average LOS") + abs(s.{names[-1]} - c."{date_cols[-1]}")) AS ev,
                 arg_min(abs(s.{names[-1]} - c."{date_cols[-1]}"), abs(s.vel_avg - c."Average LOS") + abs(s.{names[-1]} - c."{date_cols[-1]}")) AS ed
          FROM s JOIN read_csv('{csvp}', header = true) c ON s.lon = c.Longitude AND s.lat = c.Latitude
          GROUP BY s.pid)
        SELECT max(ev), max(ed), count(*) FROM j
    """).fetchone()
    geo_ok = chk.execute(f"SELECT ST_GeometryType(geometry)::VARCHAR FROM read_parquet('{g}') LIMIT 1").fetchone()[0]
    report = {
        "rows_in": int(n_in), "rows_out": int(n_out), "nan_rows": int(nan),
        "sample_roundtrip_max_abs_diff": {"vel_avg": diff[0], "last_epoch": diff[1], "joined_rows": diff[2]},
        "corr_vel_avg_vs_fit": float(np.corrcoef(vel_avg, m["vel"])[0, 1]),
        "geometry_type": geo_ok,
        "passed": bool(n_in == n_out and nan == 0 and diff[0] < 1e-3 and diff[1] < 1e-3),
    }
    with open(os.path.join(OUT_META, "validation.json"), "w") as f:
        json.dump(report, f, indent=1)
    log(f"validation: {json.dumps(report)}", t0)


if __name__ == "__main__":
    main()
