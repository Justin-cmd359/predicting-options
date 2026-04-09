"""
csv_to_parquet.py
-----------------
Converts fixed_output.csv to fixed_output.parquet for use with the SPX dashboard.

Usage:
    python csv_to_parquet.py
    python csv_to_parquet.py --input my_file.csv --output my_file.parquet

Requirements:
    pip install pandas
"""

import pandas as pd

import argparse
import pandas as pd
from pathlib import Path

def csv_to_parquet(input_path: str, output_path: str) -> None:
    df = pd.read_csv(input_path)
    df.to_parquet(output_path, index=False)
    print(f"Converted '{input_path}' -> '{output_path}' ({len(df):,} rows)")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Convert a CSV file to Parquet format.")
    parser.add_argument("--input",  default="data/fixed_output.csv",     help="Path to the input CSV file  (default: fixed_output.csv)")
    parser.add_argument("--output", default="test_output/fixed_output.parquet",  help="Path to the output Parquet file (default: fixed_output.parquet)")
    args = parser.parse_args()

    if not Path(args.input).exists():
        raise FileNotFoundError(f"Input file not found: {args.input}")

    csv_to_parquet(args.input, args.output)
