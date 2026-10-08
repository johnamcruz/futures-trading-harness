#!/usr/bin/env python3
"""Train a prop-challenge policy: python rl/train_policy.py --config rl/configs/<name>.json (see fth_rl/train.py)."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from fth_rl.train import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main())
