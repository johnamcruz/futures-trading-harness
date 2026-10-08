#!/usr/bin/env python3
"""The retrain stage of the policy pipeline (fth_rl/pipeline.py):

    python rl/retrain.py --config rl/configs/retrain/<family>.json [--dry-run]
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from fth_rl.cli import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main("retrain"))
