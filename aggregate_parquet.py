"""
aggregate_parquet.py
--------------------
Aggregates parquet file(s) to 1-second OHLC-style buckets.

Greeks              → mean  (continuous sensitivities)
MBO levels          → sum   (net order flow)
MBO pull/stack      → sum   (net directional signal)
Prices / strikes /t → mean (per-second average)

Supports:
- a single input parquet file
- a directory containing many parquet files

Usage:
    python aggregate_parquet.py --input cleaned_data/some_file.parquet
    python aggregate_parquet.py --input cleaned_data
    python aggregate_parquet.py --input cleaned_data --output-dir aggregated_data

Requirements:
    pip install pandas pyarrow
"""

import argparse
from pathlib import Path
import pandas as pd


GREEK_COLS = [
    "call_charm", "call_delta", "call_gamma", "call_rho",
    "call_theta", "call_vanna", "call_vega", "call_vomma",
    "put_charm", "put_delta", "put_gamma", "put_rho",
    "put_theta", "put_vanna", "put_vega", "put_vomma",
]

MBO_COLS = [f"MBO_{i}" for i in range(1, 15)]
MEAN_PRICE_COLS = ["future_strike", "current_es_price", "spx_strike", "t", "spx_price"]


def build_agg_spec(df: pd.DataFrame) -> dict:
    agg_spec = {}

    for col in GREEK_COLS:
        if col in df.columns:
            agg_spec[col] = "mean"

    for col in MBO_COLS:
        if col in df.columns:
            agg_spec[col] = "sum"

    if "MBO_pulling_stacking" in df.columns:
        agg_spec["MBO_pulling_stacking"] = "sum"

    for col in MEAN_PRICE_COLS:
        if col in df.columns:
            agg_spec[col] = "mean"

    return agg_spec


def aggregate_one_file(input_file: Path, output_file: Path) -> None:
    if not input_file.exists():
        raise FileNotFoundError(f"Input file not found: {input_file}")

    print(f"\nReading {input_file} ...")
    df = pd.read_parquet(input_file)
    original_columns = list(df.columns)

    print(f"  Rows loaded: {len(df):,}")
    print(f"  Columns:     {original_columns}")

    if "timestamp" not in df.columns:
        raise ValueError(f"'timestamp' column missing in {input_file}")

    if "Side" not in df.columns:
        raise ValueError(f"'Side' column missing in {input_file}")

    df["timestamp"] = pd.to_datetime(df["timestamp"], utc=True, errors="coerce")
    df = df.dropna(subset=["timestamp"])
    df["timestamp_sec"] = df["timestamp"].dt.floor("1s")

    agg_spec = build_agg_spec(df)
    if not agg_spec:
        raise ValueError(f"No aggregatable columns found in {input_file}")

    print("Aggregating to 1-second buckets by Side ...")
    agg = (
        df.groupby(["timestamp_sec", "Side"], observed=True)
        .agg(agg_spec)
        .reset_index()
    )

    agg = agg.rename(columns={"timestamp_sec": "timestamp"})

    final_columns = [col for col in original_columns if col in agg.columns]
    agg = agg[final_columns]

    for col in GREEK_COLS:
        if col in agg.columns:
            agg[col] = agg[col].round(8)

    print(f"  Rows after aggregation: {len(agg):,}")
    if len(agg) > 0:
        print(f"  Compression ratio: {len(df) / len(agg):.1f}x")

    float_cols = agg.select_dtypes(include=["float64"]).columns
    if len(float_cols) > 0:
        agg[float_cols] = agg[float_cols].astype("float32")

    int_cols = agg.select_dtypes(include=["int64"]).columns
    if len(int_cols) > 0:
        agg[int_cols] = agg[int_cols].astype("int32")

    output_file.parent.mkdir(parents=True, exist_ok=True)
    print(f"Writing {output_file} ...")
    agg.to_parquet(
        output_file,
        engine="pyarrow",
        compression="snappy",
        index=False,
    )

    size_in = input_file.stat().st_size / (1024 * 1024)
    size_out = output_file.stat().st_size / (1024 * 1024)

    print("Done!")
    print(f"  Input size:  {size_in:.2f} MB")
    print(f"  Output size: {size_out:.2f} MB")
    print(f"  Rows out:    {len(agg):,}")
    print(f"  Columns:     {list(agg.columns)}")


def iter_input_files(input_path: Path) -> list[Path]:
    if input_path.is_file():
        if input_path.suffix != ".parquet":
            raise ValueError(f"Input file must be a .parquet file: {input_path}")
        return [input_path]

    if input_path.is_dir():
        files = sorted(input_path.glob("*.parquet"))
        if not files:
            raise ValueError(f"No .parquet files found in directory: {input_path}")
        return files

    raise FileNotFoundError(f"Input path not found: {input_path}")


def make_output_path(input_file: Path, input_root: Path, output_dir: Path | None) -> Path:
    if output_dir is None:
        return input_file.with_name(f"{input_file.stem}_agg.parquet")

    output_dir.mkdir(parents=True, exist_ok=True)
    return output_dir / f"{input_file.stem}_agg.parquet"


def main():
    parser = argparse.ArgumentParser(description="Aggregate parquet file(s) to 1-second buckets.")
    parser.add_argument(
        "--input",
        required=True,
        help="Input parquet file or directory containing parquet files",
    )
    parser.add_argument(
        "--output-dir",
        default=None,
        help="Optional output directory for aggregated parquet files",
    )

    args = parser.parse_args()

    input_path = Path(args.input)
    output_dir = Path(args.output_dir) if args.output_dir else None

    files = iter_input_files(input_path)

    print(f"Found {len(files)} parquet file(s) to aggregate.")

    success = 0
    failed = 0

    for file_path in files:
        try:
            output_path = make_output_path(file_path, input_path, output_dir)
            aggregate_one_file(file_path, output_path)
            success += 1
        except Exception as e:
            failed += 1
            print(f"FAILED: {file_path} -> {e}")

    print("\n=== Aggregation complete ===")
    print(f"Successes: {success}")
    print(f"Failures:  {failed}")


if __name__ == "__main__":
    main()