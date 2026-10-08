"""Command lines for the pipeline stages (rl/sweep.py, rl/retrain.py, rl/ship.py)."""

import argparse
import sys

from . import pipeline


def main(stage, argv=None):
    p = argparse.ArgumentParser(prog=f"{stage}.py", description=f"The {stage} stage of the policy pipeline (see fth_rl/pipeline.py).")
    p.add_argument("--config", required=True, help=f"rl/configs/{stage}/<family>.json")
    p.add_argument("--dry-run", action="store_true",
                   help={"sweep": "validate, count attempt starts per window, write an example trial config; train nothing",
                         "retrain": "pick the trial and write its config; train nothing",
                         "ship": "pick the seed and write its config; the out-of-sample window is not evaluated"}[stage])
    if stage == "sweep":
        p.add_argument("--n-trials", type=int, help="override study.n_trials")
        p.add_argument("--n-jobs", type=int, help="override study.n_jobs (parallel trials)")
    if stage == "ship":
        p.add_argument("--models-dir", help="where a validated bundle is promoted (default: the config's models_dir, else models/)")
    args = p.parse_args(argv)
    try:
        if stage == "sweep":
            pipeline.run_sweep(args.config, n_trials=args.n_trials, n_jobs=args.n_jobs, dry_run=args.dry_run)
            return 0
        if stage == "retrain":
            pipeline.run_retrain(args.config, dry_run=args.dry_run)
            return 0
        bundle, _dest = pipeline.run_ship(args.config, dry_run=args.dry_run, models_dir=args.models_dir)
        return 0 if bundle is None or bundle["validated"] else 2
    except ValueError as err:
        print(f"[{stage}] {err}", file=sys.stderr)
        return 1
