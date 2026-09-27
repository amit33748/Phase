# PHASE: PSInSAR LOS deformation explorer

Interactive web map for **2,617,185 Sentinel-1 persistent scatterers** (StaMPS, ascending pass, 34 epochs from 2016-03-18 to 2024-12-25) over Delhi NCR, Haryana and the Chandigarh tricity. It turns the source CSV into GeoParquet and draws every point on the GPU. Click any point to see its animated displacement time series.

Design rationale: [docs/DESIGN.md](docs/DESIGN.md).

## Quick start

Requirements: Python 3.9+ with `duckdb`, `numpy`, `pyarrow`; Node 20+; internet access (DuckDB extensions, Esri basemaps, Google Fonts).

```bash
python -m etl.build
```

Writes `data/` in about 45 s. Then:

```bash
cd backend && npm install && npm start
```

```bash
cd frontend && npm install && npm run dev
```

- Dev UI: http://localhost:5174 (proxies `/api` to the backend)
- API: http://localhost:3002/api
- Production: `npm --prefix frontend run build`, then the backend serves the app at http://localhost:3002/

Tests (backend running): `cd backend && npm test`

## What the ETL produces

| File | Size | Purpose |
|---|---|---|
| `data/processed/los_points.parquet` | 438 MB (CSV was 914 MB) | GeoParquet 1.1, Point WKB, CRS84, bbox covering, Hilbert-sorted, 100k-row groups, ZSTD-9 + byte-stream-split. `pid` = row index. Raw series as `d_YYYYMMDD` columns plus fitted model parameters |
| `data/web/base.arrow(.gz)` | 37 MB → 16 MB gz | Resident GPU buffer: delta-encoded lon/lat, velocity, acceleration, seasonal amplitude, quality |
| `data/web/disp_i16.bin` | 170 MB | Point-major int16 displacement (mm × 4), sliced by pid range for measured playback |
| `data/web/hex_r{6,7,8}.arrow(.gz)` | 0.1 / 0.9 / 4.1 MB gz | H3 aggregates with mean displacement series |
| `data/web/ref_candidates.json` | | 20 ranked stable-area reference candidates (no GNSS) |
| `data/web/meta.json` | | Dates, colour-scale percentiles, histogram, geometry |
| `data/metadata/stac_item.json`, `validation.json` | | STAC item; round-trip validation (passes) |

Per-point model, fitted for all points at once with one pseudo-inverse: `d(t) = c0 + v·(t−tc) + ½a·(t−tc)² + s·sin 2πt + c·cos 2πt`. Also stored: σ(v), rmse, r², velocity over the last 2 years, largest jump, outlier count, and quality (rmse percentile minus an outlier penalty). The fitted velocity agrees with StaMPS `Average LOS` at r = 0.999.

## Using it

| | |
|---|---|
| Modes `1`–`6` | Velocity · Displacement · Acceleration · Seasonal · Wrapped phase (λ/2 fringes) · Quality |
| Click a point | Opens the time series: draw-in animation, trend, seasonal model, ±rmse band, neighbour p10–p90 band, outlier epochs shown hollow |
| Shift-click / `C` | Compare up to 6 series |
| `Space`, `←` `→` | Play or step through the timeline. Zoomed in (≥ 10.5), measured series are interpolated on the GPU; zoomed out, a linear model is shown |
| `R` / Reference panel | Re-reference to a point or a stable-area candidate. Subtracted on the GPU |
| `L` / `P` | Region lasso (stats, histogram, median series, CSV export) / cross-section profile |
| `V` | ≈ vertical (LOS ÷ cos θ, θ adjustable) |
| `/` | Search: place name, `lat, lon`, or `#pid` |

The URL hash keeps the mode, selected point, epoch and view, so a link reopens the same view.

## Architecture

- **ETL:** Python, DuckDB (spatial + h3) and NumPy, in `etl/`.
- **API:** Node, Express and `@duckdb/node-api`, in `backend/src/`. A LIFO connection pool queries the GeoParquet: point lookup ≈ 60 ms cold / 2 ms cached, region ≈ 100 ms, profile ≈ 20 ms. `/ts` slices the int16 file (300k points in ≈ 20 ms).
- **Frontend:** Vite, React 19, MapLibre GL 5 and deck.gl 9.4 (interleaved), in `frontend/src/`. `ValueColorExtension` is a custom deck.gl shader module. It computes `(mix(A, B, t) − ref) · scale` for each point and maps it through scientific colour maps (Crameri berlin / vik / batlow / lajolla / romaO). Colour range, reference, vertical scaling and playback are uniform updates only. Charts use d3 scales + Motion.

## Known limits

- **No tiled delivery mode.** Every device streams the full 16 MB point buffer. Fine on desktop; heavy on phones over mobile data.
- **Large JS bundle:** ≈ 750 KB gzip (deck.gl geo-layers + h3-js). The design budget was 450 KB.
- **Assumed geometry:** incidence angle is a single editable value (default 39°), not per point. The StaMPS master date (≈ 2019-12-04) is estimated from the data.
- **Relative values:** everything is relative to the scene mean (StaMPS default) unless you set a reference.
