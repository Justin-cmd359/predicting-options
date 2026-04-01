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

df = pd.read_csv('fixed_output.csv')
df.to_parquet('output.parquet')
