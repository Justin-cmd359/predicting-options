"""
aggregate_parquet.py
--------------------
Aggregates fixed_output.parquet to 1-second OHLC-style buckets.

Greeks              → mean  (continuous sensitivities)
MBO levels          → sum   (net order flow)
MBO pull/stack      → sum   (net directional signal)
Prices / strikes /t → last  (end-of-second snapshot)

Output preserves the exact column order of the input file.

Usage:
    python aggregate_parquet.py
    python aggregate_parquet.py --input my_file.parquet --output my_file_agg.parquet

Requirements:
    pip install pandas pyarrow
"""

import argparse
import pandas as pd
from pathlib import Path


GREEK_COLS = [
    "call_charm", "call_delta", "call_gamma", "call_rho",
    "call_theta", "call_vanna", "call_vega",  "call_vomma",
    "put_charm",  "put_delta",  "put_gamma",  "put_rho",
    "put_theta",  "put_vanna",  "put_vega",   "put_vomma",
]

MBO_COLS = [f"MBO_{i}" for i in range(1, 15)]

# Snapshot cols: take the last value in each second-bucket
LAST_COLS = ["future_strike", "current_es_price", "spx_strike", "t", "spx_price"]


def aggregate(input_path: str, output_path: str) -> None:
    input_file  = Path(input_path)
    output_file = Path(output_path)

    if not input_file.exists():
        raise FileNotFoundError(f"Input file not found: {input_file}")

    # ── 1. Load ───────────────────────────────────────────────────────────────
    print(f"Reading {input_file} ...")
    df = pd.read_parquet(input_file)
    original_columns = list(df.columns)          # preserve for final reorder
    print(f"  Rows loaded:  {len(df):,}")
    print(f"  Columns:      {original_columns}")

    # ── 2. Parse timestamp ────────────────────────────────────────────────────
    # Stored as a plain string e.g. "2025-04-22 15:47:00.237904-04:00".
    # utc=True normalises the tz-offset so .dt.floor() works correctly.
    df["timestamp"] = pd.to_datetime(df["timestamp"], utc=True, errors="coerce")
    df = df.dropna(subset=["timestamp"])
    df["timestamp_sec"] = df["timestamp"].dt.floor("1s")

    # ── 3. Build aggregation spec ─────────────────────────────────────────────
    agg_spec = {}

    for col in GREEK_COLS:
        if col in df.columns:
            agg_spec[col] = "mean"

    for col in MBO_COLS:
        if col in df.columns:
            agg_spec[col] = "sum"

    if "MBO_pulling_stacking" in df.columns:
        agg_spec["MBO_pulling_stacking"] = "sum"

    for col in LAST_COLS:
        if col in df.columns:
            agg_spec[col] = "last"

    # ── 4. Aggregate by (second, Side) ───────────────────────────────────────
    # Produces 60 seconds × 2 sides = 120 rows.
    # Greeks are averaged; MBOs are summed for net order flow per side.
    print("Aggregating to 1-second buckets by Side ...")
    agg = (
        df.groupby(["timestamp_sec", "Side"], observed=True)
          .agg(agg_spec)
          .reset_index()
    )

    # Rename groupby key back to match the original column name
    agg = agg.rename(columns={"timestamp_sec": "timestamp"})

    # ── 5. Restore original column order ─────────────────────────────────────
    agg = agg[original_columns]

    # Round Greeks to 8 decimal places to avoid float noise
    for col in GREEK_COLS:
        if col in agg.columns:
            agg[col] = agg[col].round(8)

    print(f"  Rows after aggregation: {len(agg):,}")
    print(f"  Compression ratio:      {len(df) / len(agg):.1f}x")

    # ── 6. Downcast for smaller file size ─────────────────────────────────────
    float_cols = agg.select_dtypes(include=["float64"]).columns
    agg[float_cols] = agg[float_cols].astype("float32")

    int_cols = agg.select_dtypes(include=["int64"]).columns
    agg[int_cols] = agg[int_cols].astype("int32")

    # ── 7. Write output ───────────────────────────────────────────────────────
    output_file.parent.mkdir(parents=True, exist_ok=True)
    print(f"Writing {output_file} ...")
    agg.to_parquet(
        output_file,
        engine="pyarrow",
        compression="snappy",
        index=False,
    )

    size_in  = input_file.stat().st_size  / (1024 * 1024)
    size_out = output_file.stat().st_size / (1024 * 1024)
    print(f"\nDone!")
    print(f"  Input size:   {size_in:.2f} MB")
    print(f"  Output size:  {size_out:.2f} MB  ({100 * size_out / size_in:.1f}% of input)")
    print(f"  Rows out:     {len(agg):,}")
    print(f"  Columns:      {list(agg.columns)}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Aggregate Parquet to 1-second buckets.")
    parser.add_argument("--input",  default="test_output/fixed_output.parquet",     help="Input Parquet file")
    parser.add_argument("--output", default="test_output/fixed_output_agg.parquet", help="Output Parquet file")
    args = parser.parse_args()

    aggregate(args.input, args.output)