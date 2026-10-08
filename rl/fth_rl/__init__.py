"""Prop-challenge policy training for the futures trading harness.

The env is the harness's own backtester (Node), stepped over a line protocol
(scripts/rl-env-server.js); this package trains MaskablePPO on it and exports
the policy to the JSON bundle the harness runs (scripts/lib/rl/policy-net.js).
"""

from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
