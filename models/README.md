# Policy bundles

Trained prop-challenge policies (`<name>.json`), promoted here by the ship
stage (`python rl/ship.py --config rl/configs/ship/<family>.json`, or
`rl/train_policy.py --promote`) only when they pass the gate: zero blows in
every out-of-sample month and a pass rate of at least 40%. A policy strategy
(`signal: policy`) names one with `policy: { bundle: <name> }`. Live trading
refuses a bundle that fails the gate, was trained on a different observation,
or was trained for another policy strategy, its strategies, account, index,
timeframe, sizing, or contract mode. More folders: `FTH_MODELS_DIRS`. See
`docs/RL-DESIGN.md`.
