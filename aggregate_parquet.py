"""
aggregate_parquet.py
--------------------
Aggregates fixed_output.parquet to 1-second OHLC-style buckets.

Greeks         → mean  (continuous sensitivities)
MBO levels     → sum   (net order flow)
MBO pull/stack → sum   (net directional signal)
Prices / t     → last  (end-of-second snapshot)

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
    "call_delta", "put_delta", "call_gamma", "call_vega",
    "call_theta", "put_theta", "call_vanna", "call_charm",
    "call_vomma", "call_rho",  "put_rho",
]

MBO_COLS = [f"MBO_{i}" for i in range(1, 15)]

PRICE_COLS = ["current_es_price", "spx_price", "t"]


def aggregate(input_path: str, output_path: str) -> None:
    input_file  = Path(input_path)
    output_file = Path(output_path)

    if not input_file.exists():
        raise FileNotFoundError(f"Input file not found: {input_file}")

    # ── 1. Load ───────────────────────────────────────────────────────────────
    print(f"Reading {input_file} ...")
    df = pd.read_parquet(input_file)
    print(f"  Rows loaded:  {len(df):,}")
    print(f"  Columns:      {list(df.columns)}")

    # ── 2. Parse & floor timestamp to nearest second ──────────────────────────
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

    for col in PRICE_COLS:
        if col in df.columns:
            agg_spec[col] = "last"

    # Preserve spx_strike and Side as grouping dimensions
    group_cols = ["timestamp_sec", "spx_strike", "Side"]
    group_cols = [c for c in group_cols if c in df.columns]

    # ── 4. Aggregate ──────────────────────────────────────────────────────────
    print(f"Aggregating to 1-second buckets by {group_cols} ...")
    agg = (
        df.groupby(group_cols, observed=True)
          .agg(agg_spec)
          .reset_index()
    )

    # Rename timestamp_sec back to timestamp for dashboard compatibility
    agg = agg.rename(columns={"timestamp_sec": "timestamp"})

    # Round Greeks to 8 decimal places to avoid float noise
    for col in GREEK_COLS:
        if col in agg.columns:
            agg[col] = agg[col].round(8)

    print(f"  Rows after aggregation: {len(agg):,}")
    print(f"  Compression ratio:      {len(df) / len(agg):.1f}x")

    # ── 5. Downcast for smaller file size ─────────────────────────────────────
    float_cols = agg.select_dtypes(include=["float64"]).columns
    agg[float_cols] = agg[float_cols].astype("float32")

    int_cols = agg.select_dtypes(include=["int64"]).columns
    agg[int_cols] = agg[int_cols].astype("int32")

    # ── 6. Write output ───────────────────────────────────────────────────────
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
    print(f"  Input size:   {size_in:.1f} MB")
    print(f"  Output size:  {size_out:.1f} MB  ({100 * size_out / size_in:.0f}% of input)")
    print(f"  Rows out:     {len(agg):,}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Aggregate Parquet to 1-second buckets.")
    parser.add_argument("--input",  default="output.parquet",     help="Input Parquet file")
    parser.add_argument("--output", default="output_agg.parquet", help="Output Parquet file")
    args = parser.parse_args()

    aggregate(args.input, args.output)
