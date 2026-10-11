"""The label dataset (scripts/rl-dataset.js, scripts/lib/rl/label-dataset.js) as arrays.

A dataset is JSONL: a header line {"header": {...}}, then one row per line:
{"obs": [...], "kind": ..., "action": k, "targets": {...}, "weight": w, ...}.
The observation is the harness's (scripts/lib/rl/observation.js); a dataset
built with another observation version is refused, so the student never
trains on inputs live trading doesn't build. Targets (the outcome, the
counterfactual) are returned apart from the observation, never in it.
"""

import json
from dataclasses import dataclass, field

import numpy as np

FORMAT = "fth-label-dataset"
VERSION = 1


class DatasetError(ValueError):
    """The file is not a label dataset this trainer can use."""


@dataclass
class LabelDataset:
    header: dict
    obs: np.ndarray  # (n, obsDim) float64, as the harness computed it
    actions: np.ndarray  # (n,) int64 action ids
    kinds: list  # each row's decision kind (a key of header["masks"])
    masks: np.ndarray  # (n, actionN) bool: the actions allowed for that kind
    weights: np.ndarray  # (n,) float64
    targets: list = field(default_factory=list)  # each row's outcome fields: never inputs
    keys: list = field(default_factory=list)  # each row's label key

    def __len__(self):
        return len(self.actions)


def load(path, obs_version, obs_fields=None, mode=None):
    """Read a dataset. obs_version: the observation version the trainer builds
    (the env server's info "obsVersion"); a dataset built with another one is
    refused. obs_fields and mode, when given, must match too."""
    if not isinstance(obs_version, str) or not obs_version:
        raise DatasetError("obs_version: the observation version the trainer builds (env server info obsVersion)")
    with open(path, encoding="utf8") as fh:
        lines = [x for x in fh.read().split("\n") if x.strip()]
    if not lines:
        raise DatasetError(f"{path}: empty")
    try:
        first = json.loads(lines[0])
    except json.JSONDecodeError as err:
        raise DatasetError(f"{path}: the header line is not JSON") from err
    header = first.get("header") if isinstance(first, dict) else None
    if not isinstance(header, dict) or header.get("format") != FORMAT:
        raise DatasetError(f"{path}: not a label dataset (no {FORMAT} header)")
    if header.get("version") != VERSION:
        raise DatasetError(f"{path}: dataset version {header.get('version')}; this reads {VERSION} (rebuild it)")
    if header.get("obsVersion") != obs_version:
        raise DatasetError(
            f"{path}: built with observation version {header.get('obsVersion')}, not this trainer's {obs_version}: "
            "rebuild it with node scripts/rl-dataset.js build"
        )
    if obs_fields is not None and list(header.get("obsFields") or []) != list(obs_fields):
        raise DatasetError(f"{path}: built for other observation fields")
    if mode is not None and header.get("mode") != mode:
        raise DatasetError(f"{path}: a {header.get('mode')} dataset, not {mode}")
    dim = header.get("obsDim")
    n_actions = header.get("actionN")
    masks_by_kind = header.get("masks") or {}
    if not isinstance(dim, int) or dim != len(header.get("obsFields") or []):
        raise DatasetError(f"{path}: obsDim {dim} for {len(header.get('obsFields') or [])} fields")
    if not isinstance(n_actions, int) or n_actions < 1:
        raise DatasetError(f"{path}: actionN {n_actions}")
    for kind, m in masks_by_kind.items():
        if len(m) != n_actions:
            raise DatasetError(f"{path}: the {kind} mask has {len(m)} entries for {n_actions} actions")
    rows = []
    for i, line in enumerate(lines[1:], start=2):
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError as err:
            raise DatasetError(f"{path}:{i}: not JSON") from err
    if header.get("rows") != len(rows):
        raise DatasetError(f"{path}: {len(rows)} rows, the header says {header.get('rows')} (a torn file?)")
    obs = np.zeros((len(rows), dim), dtype=np.float64)
    actions = np.zeros(len(rows), dtype=np.int64)
    masks = np.zeros((len(rows), n_actions), dtype=bool)
    weights = np.zeros(len(rows), dtype=np.float64)
    kinds, targets, keys = [], [], []
    for i, r in enumerate(rows):
        where = f"{path}: row {i + 1}"
        x = r.get("obs")
        if not isinstance(x, list) or len(x) != dim:
            raise DatasetError(f"{where}: {len(x) if isinstance(x, list) else 'no'} observation fields, not {dim}")
        a = r.get("action")
        kind = r.get("kind")
        if kind not in masks_by_kind:
            raise DatasetError(f"{where}: unknown kind {kind!r}")
        if not isinstance(a, int) or isinstance(a, bool) or not 0 <= a < n_actions or not masks_by_kind[kind][a]:
            raise DatasetError(f"{where}: action {a!r} is not allowed for a {kind} decision")
        values = np.asarray(x, dtype=np.float64)
        if not np.all(np.isfinite(values)):
            raise DatasetError(f"{where}: a non-finite observation value")
        w = r.get("weight", 1)
        if not isinstance(w, (int, float)) or isinstance(w, bool) or not np.isfinite(w) or w < 0:
            raise DatasetError(f"{where}: weight {w!r}")
        obs[i] = values
        actions[i] = a
        masks[i] = np.asarray(masks_by_kind[kind], dtype=bool)
        weights[i] = float(w)
        kinds.append(kind)
        targets.append(r.get("targets") or {})
        keys.append(r.get("key"))
    return LabelDataset(header=header, obs=obs, actions=actions, kinds=kinds, masks=masks, weights=weights, targets=targets, keys=keys)
