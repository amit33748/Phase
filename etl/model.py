"""Vectorised least-squares time-series model for every scatterer at once.

Model per point (t in decimal years, tc = centre of the observation window):

    d(t) = c0 + v·(t - tc) + ½a·(t - tc)² + s·sin(2πt) + c·cos(2πt)

Solved for all N points with a single pseudo-inverse of the 34×5 design matrix.
"""

from __future__ import annotations

import numpy as np

CHUNK = 400_000


def decimal_year(dates) -> np.ndarray:
    out = []
    for d in dates:
        start = np.datetime64(f"{d.year}-01-01")
        end = np.datetime64(f"{d.year + 1}-01-01")
        frac = (np.datetime64(d.isoformat()) - start) / (end - start)
        out.append(d.year + float(frac))
    return np.asarray(out, dtype=np.float64)


def design_matrix(t: np.ndarray, tc: float) -> np.ndarray:
    dt = t - tc
    return np.column_stack([
        np.ones_like(t),
        dt,
        0.5 * dt * dt,
        np.sin(2 * np.pi * t),
        np.cos(2 * np.pi * t),
    ])


def fit_all(D: np.ndarray, t: np.ndarray) -> dict[str, np.ndarray]:
    """D: (N, E) float32 displacement in mm. t: (E,) decimal years."""
    n, e = D.shape
    tc = float((t[0] + t[-1]) / 2)
    A = design_matrix(t, tc)
    P = np.linalg.pinv(A)                       # (5, E)
    cov_unit = np.linalg.inv(A.T @ A)           # parameter covariance / σ²
    dof = e - A.shape[1]

    # Linear-only fit on the last two years: recent velocity (trend change)
    recent = t >= t[-1] - 2.0
    Ar = np.column_stack([np.ones(recent.sum()), t[recent] - t[recent].mean()])
    Pr = np.linalg.pinv(Ar)

    out = {k: np.empty(n, np.float32) for k in (
        "c0", "vel", "accel", "seas_sin", "seas_cos", "vel_sigma", "rmse", "r2",
        "vel_recent", "jump_max", "disp_total",
    )}
    out["n_outliers"] = np.empty(n, np.uint8)

    for s in range(0, n, CHUNK):
        Dc = D[s:s + CHUNK].astype(np.float64)
        X = Dc @ P.T                            # (m, 5)
        R = Dc - X @ A.T
        ss_res = np.einsum("ij,ij->i", R, R)
        dev = Dc - Dc.mean(axis=1, keepdims=True)
        ss_tot = np.einsum("ij,ij->i", dev, dev)
        rmse = np.sqrt(ss_res / e)
        sigma2 = ss_res / dof

        sl = slice(s, s + len(Dc))
        out["c0"][sl] = X[:, 0]
        out["vel"][sl] = X[:, 1]
        out["accel"][sl] = X[:, 2]
        out["seas_sin"][sl] = X[:, 3]
        out["seas_cos"][sl] = X[:, 4]
        out["vel_sigma"][sl] = np.sqrt(sigma2 * cov_unit[1, 1])
        out["rmse"][sl] = rmse
        out["r2"][sl] = np.where(ss_tot > 0, 1 - ss_res / np.maximum(ss_tot, 1e-9), 0)
        out["vel_recent"][sl] = (Dc[:, recent] @ Pr.T)[:, 1]
        out["jump_max"][sl] = np.abs(np.diff(Dc, axis=1)).max(axis=1)
        out["disp_total"][sl] = Dc[:, -1] - Dc[:, 0]
        out["n_outliers"][sl] = (np.abs(R) > 3 * rmse[:, None]).sum(axis=1)

    amp = np.hypot(out["seas_sin"], out["seas_cos"])
    # s·sin + c·cos = amp·cos(2πt − φ), φ = atan2(s, c) → peak at t = φ/2π
    phase = np.mod(np.arctan2(out["seas_sin"], out["seas_cos"]) / (2 * np.pi), 1.0)
    out["seas_amp"] = amp.astype(np.float32)
    out["seas_peak_doy"] = np.round(phase * 365.25).astype(np.int16)

    # Quality: percentile rank of rmse (255 = cleanest), minus a penalty per outlier epoch
    rank = np.empty(n, np.float64)
    rank[np.argsort(out["rmse"], kind="stable")] = np.arange(n) / max(n - 1, 1)
    q = 255 * (1 - rank) - 12 * out["n_outliers"]
    out["quality"] = np.clip(np.round(q), 0, 255).astype(np.uint8)

    out["_tc"] = tc
    return out
