"""The sweep -> retrain -> ship pipeline: one config
family is three JSON files.

  rl/configs/sweep/<family>.json    the training config (env, windows, PPO,
                                    reward, sizing) plus `study` and
                                    `search_space` {searched, anchored}
  rl/configs/retrain/<family>.json  {"sweep": <path>, "trial": "best", "seeds": [...], ...}
  rl/configs/ship/<family>.json     {"retrain": <path>, "bundle": <name>, "min_pass_rate": 0.4}

Sweep: Optuna (TPE) over search_space.searched; anchored keys are fixed.
Each trial trains on the training window and is scored on the selection
window: a trial with any blow is infeasible and always ranks below every
feasible one; feasible trials rank by pass rate + win_rate_weight x win rate
(a high pass rate and a high win rate).

Retrain: the best feasible trial's exact config, more seeds and steps, each
seed scored on the selection window. Resumable.

Ship: the seed with the fewest selection blows, then the highest pass rate,
evaluated once out of sample, month by month, next to the rules-only
baseline. The gate: zero blows in every month and a pass rate of at least
40%. Only a bundle that passes is promoted to models/<bundle>.json.

The out-of-sample window is never seen before ship; every ship evaluation
is logged (oos_log.jsonl) so repeated looks are visible.
"""

import copy
import datetime as dt
import hashlib
import json
import time
import traceback
from pathlib import Path

from . import REPO_ROOT, runlog
from .bridge import EnvServer
from .config import MIN_PASS_RATE, NAME, gate_failures, load_config
from .train import build_bundle, evaluate_oos, harness_home, log, log_oos_look, pct, promote, rank, results_line, server_info, train_seed, write_bundle

# What a sweep may search or anchor: training and reward levers only. Never
# the account, data, windows, strategies, or the gate.
TUNABLE_ROOTS = ("ppo", "reward", "sizing", "contracts", "hidden", "total_timesteps", "normalize_reward", "clip_obs")
NESTED_ROOTS = ("ppo", "reward", "sizing")  # maps: searched as root.key; the others are whole values
# What a study is bound to: changing any of these makes old trials incomparable.
FINGERPRINT_KEYS = ("strategy", "symbol", "data", "windows", "eval_every", "sessions", "eodAt", "slippageTicks", "closedDates", "earlyCloseDates")
SPEC_TYPES = ("float", "int", "categorical")
STUDY_DEFAULTS = {
    "n_trials": 24,
    "n_jobs": 1,
    "sampler": "tpe",
    "seed": 0,
    "pruner": "median",
    "checkpoints": 4,
    "warmup_checkpoints": 1,
    "min_trades_per_attempt": 0,
    "win_rate_weight": 0.5,  # feasible score = pass rate + this x win rate
}


# --- config files ---------------------------------------------------------

def read_json(path):
    path = Path(path).resolve()
    try:
        return json.loads(path.read_text()), path
    except (OSError, json.JSONDecodeError) as err:
        raise ValueError(f"{path}: {err}") from err


def ref(path, base):
    """A path in a config, relative to that config's folder."""
    p = Path(path)
    return (p if p.is_absolute() else Path(base).parent / p).resolve()


def get_path(d, dotted):
    for k in dotted.split("."):
        d = d[k]
    return d


def set_path(d, dotted, value):
    keys = dotted.split(".")
    for k in keys[:-1]:
        d = d.setdefault(k, {})
    d[keys[-1]] = value


def absolute_data(raw, base_dir):
    """data entries resolved against the config's folder (trial configs live elsewhere)."""
    out = copy.deepcopy(raw)
    for sym, d in (out.get("data") or {}).items():
        if isinstance(d, str):
            out["data"][sym] = str(ref(d, base_dir / "x"))
        elif isinstance(d, dict) and isinstance(d.get("file"), str):
            d["file"] = str(ref(d["file"], base_dir / "x"))
    return out


def family_out(sweep_raw, sweep_path):
    if sweep_raw.get("out_dir"):
        return ref(sweep_raw["out_dir"], sweep_path)
    return harness_home() / "rl" / sweep_raw["name"]


def check_key(name):
    parts = name.split(".")
    if parts[0] not in TUNABLE_ROOTS:
        return f"{name}: only {', '.join(TUNABLE_ROOTS)} may be searched or anchored (never the strategy, account, data, windows, or gate)"
    if parts[0] in NESTED_ROOTS and len(parts) != 2:
        return f"{name}: {parts[0]} is searched one key at a time ({parts[0]}.<key>)"
    if parts[0] not in NESTED_ROOTS and len(parts) != 1:
        return f"{name}: {parts[0]} is a whole value; search it as {parts[0]}"
    return None


def check_spec(name, spec):
    bad = check_key(name)
    if bad:
        return bad
    if not isinstance(spec, dict) or spec.get("type") not in SPEC_TYPES:
        return f"{name}: {{\"type\": float|int|categorical, ...}}"
    if spec["type"] == "categorical":
        if not (isinstance(spec.get("choices"), list) and spec["choices"]):
            return f"{name}: categorical needs choices"
    elif not (isinstance(spec.get("low"), (int, float)) and isinstance(spec.get("high"), (int, float)) and spec["low"] < spec["high"]):
        return f"{name}: low < high"
    elif spec.get("log") and spec["low"] <= 0:
        return f"{name}: a log scale needs low > 0"
    return None


def load_sweep(path):
    raw, path = read_json(path)
    study = {**STUDY_DEFAULTS, **(raw.get("study") or {})}
    space = raw.get("search_space") or {}
    searched = space.get("searched") or {}
    anchored = space.get("anchored") or {}
    errors = []
    if not NAME.match(str(raw.get("name", ""))):
        errors.append("name: the family name (lowercase letters, digits, _ . -)")
    if not searched:
        errors.append("search_space.searched: at least one parameter")
    for k, spec in searched.items():
        e = check_spec(k, spec)
        if e:
            errors.append(e)
    for k in anchored:
        bad = check_key(k)
        if bad:
            errors.append(bad)
        if any(k == x or k.startswith(x + ".") or x.startswith(k + ".") for x in searched):
            errors.append(f"{k}: overlaps a searched key")
    if study["sampler"] not in ("tpe", "random"):
        errors.append("study.sampler: tpe or random")
    if study["pruner"] not in ("median", "none"):
        errors.append("study.pruner: median or none")
    for k in ("n_trials", "n_jobs", "checkpoints"):
        if not (isinstance(study[k], int) and study[k] >= 1):
            errors.append(f"study.{k}: a positive whole number")
    if not (isinstance(study["win_rate_weight"], (int, float)) and 0 <= study["win_rate_weight"] <= 1):
        errors.append("study.win_rate_weight: 0 to 1 (how much win rate counts next to pass rate)")
    if errors:
        raise ValueError(f"invalid sweep config {path}:\n- " + "\n- ".join(errors))
    # The base config (anchored applied), and each end of every searched range,
    # must be a valid training config: a bad range fails here, not mid-sweep.
    probe = family_out(raw, path) / "sweep" / "_probe_config.json"
    probes = [{}]
    for k, spec in searched.items():
        values = spec["choices"] if spec["type"] == "categorical" else [spec["low"], spec["high"]]
        probes += [{k: v} for v in values]
    for params in probes:
        write_config(probe, trial_raw(raw, path, params))
        try:
            load_config(probe)
        except ValueError as err:
            raise ValueError(f"invalid sweep config {path} ({json.dumps(params) if params else 'base'}):\n{err}") from err
    probe.unlink(missing_ok=True)
    return {"raw": raw, "path": path, "study": study, "searched": searched, "anchored": anchored, "out": family_out(raw, path)}


def file_sha(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def data_files(raw):
    for d in (raw.get("data") or {}).values():
        f = d if isinstance(d, str) else (d or {}).get("file")
        if f:
            yield f


def fingerprint(raw, base_path):
    """What a study is bound to: the non-tunable config and the data's contents."""
    absd = absolute_data(raw, Path(base_path).parent)
    key = {k: absd.get(k) for k in FINGERPRINT_KEYS}
    key["data_sha256"] = sorted(file_sha(f) for f in data_files(absd) if Path(f).exists())
    return hashlib.sha256(json.dumps(key, sort_keys=True).encode()).hexdigest()


def trial_raw(raw, path, params):
    """The full training config of a trial: the sweep config, anchored, then sampled values."""
    out = absolute_data({k: v for k, v in raw.items() if k not in ("study", "search_space", "out_dir")}, path.parent)
    for k, v in ((raw.get("search_space") or {}).get("anchored") or {}).items():
        set_path(out, k, v)
    for k, v in params.items():
        set_path(out, k, v)
    return out


def write_config(path, raw):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.parent / f".{path.name}.tmp"
    tmp.write_text(json.dumps(raw, indent=1) + "\n")
    tmp.replace(path)
    return path


# --- sweep ----------------------------------------------------------------

def sample(trial, searched):
    params = {}
    for k, spec in searched.items():
        if spec["type"] == "float":
            params[k] = trial.suggest_float(k, spec["low"], spec["high"], log=bool(spec.get("log")))
        elif spec["type"] == "int":
            params[k] = trial.suggest_int(k, int(spec["low"]), int(spec["high"]), log=bool(spec.get("log")))
        else:
            # Optuna stores choices that are lists (hidden sizes) as JSON strings.
            choices = [json.dumps(c) if isinstance(c, (list, dict)) else c for c in spec["choices"]]
            v = trial.suggest_categorical(k, choices)
            params[k] = json.loads(v) if isinstance(v, str) and v[:1] in "[{" else v
    return params


def score(sel, min_trades=0, win_weight=0.5):
    """Feasible (no blow, enough trades): pass rate + win_weight x win rate, in [0, 1 + win_weight].
    Infeasible: below -1, worse with more blows, so it never outranks a feasible trial."""
    pass_rate = sel.get("passRate") or 0
    blow_rate = sel.get("blowRate") or 0
    if sel.get("blown", 0) > 0 or (sel.get("tradesPerAttempt") or 0) < min_trades:
        return -1.0 - blow_rate + 0.01 * pass_rate
    return pass_rate + win_weight * (sel.get("winRate") or 0)


def merge(results):
    """Selection results of several seeds as one (attempt-weighted)."""
    n = sum(r["attempts"] for r in results) or 1
    passed = sum(r["passed"] for r in results)
    blown = sum(r["blown"] for r in results)
    trades = sum(r.get("trades") or 0 for r in results)
    wins = sum(r.get("wins") or 0 for r in results)
    losses = sum(r.get("losses") or 0 for r in results)

    def weighted(key, count):
        # Seeds' averages back to sums, then over all seeds' counts.
        num = sum((r.get(key) or 0) * (r.get(count) or 0) for r in results)
        den = sum(r.get(count) or 0 for r in results if r.get(key) is not None)
        return round(num / den, 3) if den else None

    return {
        "attempts": n, "passed": passed, "blown": blown, "trades": trades, "wins": wins, "losses": losses,
        "passRate": round(passed / n, 3), "blowRate": round(blown / n, 3), "winRate": round(wins / trades, 3) if trades else None,
        "avgWinR": weighted("avgWinR", "wins"), "avgLossR": weighted("avgLossR", "losses"), "expectancyR": weighted("expectancyR", "trades"),
        "avgProfit": round(sum(r["avgProfit"] * r["attempts"] for r in results) / n),
        "tradesPerAttempt": round(sum(r["tradesPerAttempt"] * r["attempts"] for r in results) / n, 1),
    }


def make_study(sw, create=True):
    import optuna

    st = sw["study"]
    storage = st.get("storage") or f"sqlite:///{sw['out'] / 'sweep' / 'study.db'}"
    if storage.startswith("sqlite:///") and not Path(storage[len("sqlite:///"):]).is_absolute():
        storage = f"sqlite:///{ref(storage[len('sqlite:///'):], sw['path'])}"  # relative to the config, not the shell
    sampler = optuna.samplers.TPESampler(seed=st["seed"]) if st["sampler"] == "tpe" else optuna.samplers.RandomSampler(seed=st["seed"])
    pruner = (optuna.pruners.MedianPruner(n_startup_trials=3, n_warmup_steps=st["warmup_checkpoints"])
              if st["pruner"] == "median" else optuna.pruners.NopPruner())
    (sw["out"] / "sweep").mkdir(parents=True, exist_ok=True)
    name = st.get("study_name") or sw["raw"]["name"]
    fp = fingerprint(sw["raw"], sw["path"])
    if create:
        study = optuna.create_study(study_name=name, storage=storage, sampler=sampler, pruner=pruner, direction="maximize", load_if_exists=True)
        if "fingerprint" not in study.user_attrs:
            study.set_user_attr("fingerprint", fp)
    else:
        study = optuna.load_study(study_name=name, storage=storage, sampler=sampler, pruner=pruner)
    if study.user_attrs.get("fingerprint") != fp:
        raise ValueError(f"study {name} was run on other data, windows, or strategy than {sw['path']} now holds; "
                         "start a new family (name or out_dir) rather than mix trials scored on different selection windows")
    return study


def objective(sw):
    import optuna

    st = sw["study"]

    def run(trial):
        params = sample(trial, sw["searched"])
        tdir = sw["out"] / "sweep" / f"trial_{trial.number:03d}"
        # The trial's lines also go to trial_NNN/train.log; its events carry trial=N.
        with runlog.scope(file=tdir / "train.log", trial=trial.number):
            return run_logged(trial, params, tdir)

    def run_logged(trial, params, tdir):
        t0 = time.time()
        runlog.event("trial_start", params=params)

        def record(state, **extra):
            out = {"number": trial.number, "state": state, "params": params, "minutes": round((time.time() - t0) / 60, 2), **extra}
            runlog.event("trial", **out)
            write_config(tdir / "summary.json", runlog._clean(out))

        try:
            value, sel, results = run_trial(trial, params, tdir)
        except optuna.TrialPruned as err:
            log(f"pruned after {(time.time() - t0) / 60:.1f} min ({err or 'below the median at a checkpoint'})")
            record("pruned", reason=str(err) or "below the median at a checkpoint", checkpoint=trial.user_attrs.get("last_checkpoint"))
            raise
        except Exception as err:
            log(f"failed after {(time.time() - t0) / 60:.1f} min: {type(err).__name__}: {err}", "ERROR")
            record("failed", error=f"{type(err).__name__}: {err}", traceback=traceback.format_exc())
            raise
        feasible = value >= 0
        reason = None if feasible else ("a blow on the selection window" if (sel.get("blown") or 0) > 0 else f"under {st['min_trades_per_attempt']} trades per attempt")
        record("complete" if feasible else "infeasible", value=value, feasible=feasible, reason=reason, selection=sel, seeds=results)
        return value

    def run_trial(trial, params, tdir):
        cfg_path = write_config(tdir / "config.json", trial_raw(sw["raw"], sw["path"], params))
        trial.set_user_attr("config", str(cfg_path))
        cfg = load_config(cfg_path)
        w = cfg["_windows"]
        log(f"trial {trial.number}: {json.dumps(params)}")
        with EnvServer(cfg_path) as server:
            starts = server.starts(w["select"], cfg["eval_every"])
            if not starts:
                raise ValueError("the selection window needs room for at least one attempt")

            def checkpoint(model, venv, k):
                from .export import export_network

                venv.training = False
                try:
                    sel = server.evaluate(starts, w["select"][1], export_network(model, venv))
                finally:
                    venv.training = True
                value = score(sel, st["min_trades_per_attempt"], st["win_rate_weight"])
                trial.report(value, k)
                trial.set_user_attr("last_checkpoint", k)
                log(f"trial {trial.number} checkpoint {k}/{st['checkpoints']}: {results_line(sel)} -> score {value:.3f}")
                runlog.event("checkpoint", k=k, of=st["checkpoints"], value=value, selection={x: v for x, v in sel.items() if x != "months"})
                if trial.should_prune():
                    raise optuna.TrialPruned()

            results = []
            for i, seed in enumerate(cfg["seeds"]):
                use_ck = st["pruner"] != "none" and i == 0
                network = train_seed(cfg, seed, tdir, checkpoint=checkpoint if use_ck else None, checkpoints=st["checkpoints"] if use_ck else 0)
                sel = server.evaluate(starts, w["select"][1], network)
                results.append({**{k: v for k, v in sel.items() if k != "months"}, "seed": seed})
        sel = merge(results)
        value = score(sel, st["min_trades_per_attempt"], st["win_rate_weight"])
        trial.set_user_attr("selection", sel)
        trial.set_user_attr("seeds", results)
        trial.set_user_attr("feasible", value >= 0)
        log(f"trial {trial.number} selection: {results_line(sel)} -> score {value:.3f}{'' if value >= 0 else ' (infeasible)'}")
        return value, sel, results

    return run


def run_sweep(path, n_trials=None, n_jobs=None, dry_run=False):
    sw = load_sweep(path)
    runlog.start(sw["out"] / "sweep", "sweep", sw["raw"], configFile=str(sw["path"]), searched=sw["searched"], anchored=sw["anchored"], dryRun=dry_run)
    try:
        study = _run_sweep(sw, n_trials, n_jobs, dry_run)
    except BaseException as err:
        runlog.failed(err)
        raise
    if study is None:
        runlog.finish("dry_run")
        return None
    states = {}
    for t in study.trials:
        states[t.state.name.lower()] = states.get(t.state.name.lower(), 0) + 1
    best = best_trial(study)
    runlog.finish("done", trials=len(study.trials), states=states, best=best.number if best else None,
                  bestSelection=best.user_attrs.get("selection") if best else None)
    return study


def _run_sweep(sw, n_trials, n_jobs, dry_run):
    st = sw["study"]
    log(f"sweep {sw['raw']['name']}: {len(sw['searched'])} searched ({', '.join(sw['searched'])}), "
        f"{len(sw['anchored'])} anchored; out {sw['out']}")
    if dry_run:
        import optuna

        probe = optuna.create_study(direction="maximize", sampler=optuna.samplers.RandomSampler(seed=st["seed"]))
        example = trial_raw(sw["raw"], sw["path"], sample(probe.ask(), sw["searched"]))
        cfg_path = write_config(sw["out"] / "sweep" / "_dry_run_config.json", example)
        cfg = load_config(cfg_path)
        with EnvServer(cfg_path) as server:
            server_info(server)
            for k in ("train", "select", "oos"):
                log(f"  {k}: {cfg['windows'][k][0]} .. {cfg['windows'][k][1]}: {len(server.starts(cfg['_windows'][k], cfg['eval_every']))} attempt starts")
        log(f"  example trial config: {cfg_path}")
        log(f"  {n_trials or st['n_trials']} trials x {len(cfg['seeds'])} seed(s) x {cfg['total_timesteps']} steps (dry run: nothing trained)")
        return None
    study = make_study(sw)
    study.optimize(objective(sw), n_trials=n_trials or st["n_trials"], n_jobs=n_jobs or st["n_jobs"], catch=(RuntimeError,))
    best = best_trial(study)
    log(f"done: {len(study.trials)} trials; best feasible: {('trial ' + str(best.number) + ', pass ' + pct(best.user_attrs['selection']['passRate'])) if best else 'none'}")
    return study


def best_trial(study, number=None):
    import optuna

    done = [t for t in study.trials if t.state == optuna.trial.TrialState.COMPLETE and t.user_attrs.get("feasible")]
    if number is not None:
        match = [t for t in study.trials if t.number == number]
        if not match or match[0] not in done:
            raise ValueError(f"trial {number} is not a complete, feasible trial")
        return match[0]
    return max(done, key=lambda t: (t.value, -t.number)) if done else None


# --- retrain --------------------------------------------------------------

def load_retrain(path):
    raw, path = read_json(path)
    errors = []
    if not isinstance(raw.get("sweep"), str):
        errors.append("sweep: the family's sweep config")
    trial = raw.get("trial", "best")
    if not (trial == "best" or (isinstance(trial, int) and trial >= 0)):
        errors.append('trial: "best" or a trial number')
    seeds = raw.get("seeds", [1, 2, 3, 4, 5, 6])
    if not (isinstance(seeds, list) and seeds and all(isinstance(s, int) and s >= 0 for s in seeds)):
        errors.append("seeds: a list of whole numbers")
    for k in ("total_timesteps", "n_envs"):
        if k in raw and not (isinstance(raw[k], int) and raw[k] > 0):
            errors.append(f"{k}: a positive whole number")
    if errors:
        raise ValueError(f"invalid retrain config {path}:\n- " + "\n- ".join(errors))
    sw = load_sweep(ref(raw["sweep"], path))
    return {"raw": raw, "path": path, "sweep": sw, "trial": trial, "seeds": seeds, "out": sw["out"] / "retrain"}


def run_retrain(path, dry_run=False):
    rt = load_retrain(path)
    runlog.start(rt["out"], "retrain", rt["raw"], configFile=str(path), dryRun=dry_run)
    try:
        out = _run_retrain(rt, dry_run)
    except BaseException as err:
        runlog.failed(err)
        raise
    runlog.finish("dry_run" if dry_run else "done", seeds=sorted((out or {}).get("seeds", {}).keys()) if out else None)
    return out


def _run_retrain(rt, dry_run):
    study = make_study(rt["sweep"], create=False)
    t = best_trial(study, None if rt["trial"] == "best" else rt["trial"])
    if t is None:
        raise ValueError("no feasible trial: every completed trial blew an account on the selection window (or none completed)")
    trial_cfg, _ = read_json(t.user_attrs["config"])
    raw = {**trial_cfg, "seeds": rt["seeds"], "name": f"{rt['sweep']['raw']['name']}_retrain"}
    for k in ("total_timesteps", "n_envs"):
        if k in rt["raw"]:
            raw[k] = rt["raw"][k]
    # Seeds already retrained must come from this exact config; check before writing anything.
    cand_file = rt["out"] / "candidates.json"
    candidates = json.loads(cand_file.read_text()) if cand_file.exists() else {"trial": t.number, "config": raw, "seeds": {}}
    if candidates.get("trial") != t.number or candidates.get("config") != raw:
        raise ValueError(f"{cand_file} holds seeds retrained from trial {candidates.get('trial')} with another config; "
                         f"move it aside (or point retrain at that trial) to retrain trial {t.number}")
    cfg_path = write_config(rt["out"] / "config.json", raw)
    cfg = load_config(cfg_path)
    log(f"retrain {rt['sweep']['raw']['name']}: trial {t.number} (selection pass {pct(t.user_attrs['selection']['passRate'])}), "
        f"seeds {rt['seeds']}, {cfg['total_timesteps']} steps each; out {rt['out']}")
    if dry_run:
        log(f"  config: {cfg_path} (dry run: nothing trained)")
        return None
    w = cfg["_windows"]
    with EnvServer(cfg_path) as server:
        starts = server.starts(w["select"], cfg["eval_every"])
        for seed in rt["seeds"]:
            if str(seed) in candidates["seeds"]:
                log(f"seed {seed}: already retrained")
                continue
            network = train_seed(cfg, seed, rt["out"])
            sel = server.evaluate(starts, w["select"][1], network)
            log(f"seed {seed} selection: {results_line(sel)}")
            runlog.event("evaluation", window="select", seed=seed, result=sel)
            candidates["seeds"][str(seed)] = {"network": str(rt["out"] / "seeds" / f"seed_{seed}_network.json"), "selection": sel}
            write_config(cand_file, candidates)
    return candidates


# --- ship -----------------------------------------------------------------

def load_ship(path):
    raw, path = read_json(path)
    errors = []
    if not isinstance(raw.get("retrain"), str):
        errors.append("retrain: the family's retrain config")
    if not NAME.match(str(raw.get("bundle", ""))):
        errors.append("bundle: the policy name strategies use (models/<bundle>.json)")
    mpr = raw.get("min_pass_rate", MIN_PASS_RATE)
    if not (isinstance(mpr, (int, float)) and MIN_PASS_RATE <= mpr <= 1):
        errors.append(f"min_pass_rate: {MIN_PASS_RATE} to 1 (the gate may be raised, never lowered)")
    mwr = raw.get("min_win_rate", 0)
    if not (isinstance(mwr, (int, float)) and 0 <= mwr <= 1):
        errors.append("min_win_rate: 0 to 1 (0 = no win-rate gate)")
    if "max_blows" in raw:
        errors.append("max_blows: not configurable; zero blows in every out-of-sample month is the rule")
    if errors:
        raise ValueError(f"invalid ship config {path}:\n- " + "\n- ".join(errors))
    rt = load_retrain(ref(raw["retrain"], path))
    models = ref(raw["models_dir"], path) if raw.get("models_dir") else REPO_ROOT / "models"
    return {"raw": raw, "path": path, "retrain": rt, "bundle": raw["bundle"], "min_pass_rate": mpr, "min_win_rate": mwr, "models": models,
            "out": rt["sweep"]["out"] / "ship"}


def run_ship(path, dry_run=False, models_dir=None):
    sh = load_ship(path)
    runlog.start(sh["out"], "ship", sh["raw"], configFile=str(path), dryRun=dry_run)
    try:
        bundle, dest = _run_ship(sh, dry_run, models_dir)
    except BaseException as err:
        runlog.failed(err)
        raise
    runlog.finish("dry_run" if bundle is None else "promoted" if dest else "not_validated",
                  **({"validated": bundle["validated"], "gateFailures": bundle["gateFailures"], "promotedTo": str(dest) if dest else None} if bundle else {}))
    return bundle, dest


def _run_ship(sh, dry_run, models_dir):
    rt = sh["retrain"]
    cand_file = rt["out"] / "candidates.json"
    if not cand_file.exists():
        raise ValueError(f"no retrained seeds ({cand_file}); run retrain first")
    candidates = json.loads(cand_file.read_text())
    seeds = [{"seed": int(k), **v} for k, v in candidates["seeds"].items()]
    # A recipe ships only if every seed is clean: robustness across initializations, not one lucky run.
    blew = [c["seed"] for c in seeds if c["selection"].get("blown", 0) > 0]
    if blew:
        raise ValueError(f"retrained seeds {blew} blew an account on the selection window; the recipe isn't robust, nothing to ship")
    if len(seeds) < len(sh["retrain"]["seeds"]):
        raise ValueError(f"only {len(seeds)} of {len(sh['retrain']['seeds'])} seeds are retrained; finish retrain first")
    clean = seeds
    best = min(clean, key=lambda c: (*rank(c["selection"]), c["seed"]))
    best["network"] = json.loads(Path(best["network"]).read_text())
    if "config" not in candidates:
        raise ValueError(f"{cand_file} records no config; retrain again")
    # The config the networks were trained with, as retrain recorded it.
    raw = dict(candidates["config"])
    raw["min_pass_rate"] = sh["min_pass_rate"]
    raw["min_win_rate"] = sh["min_win_rate"]
    cfg_path = write_config(sh["out"] / "config.json", raw)
    cfg = load_config(cfg_path)
    log(f"ship {sh['bundle']}: seed {best['seed']} of {len(seeds)} (selection pass {pct(best['selection']['passRate'])}, blow 0)")
    if dry_run:
        log(f"dry run: config {cfg_path}; the out-of-sample window ({cfg['windows']['oos'][0]} .. {cfg['windows']['oos'][1]}) is not evaluated. "
            "Run ship without --dry-run to evaluate it once and promote only if it passes the gate.")
        return None, None
    with EnvServer(cfg_path, hash_data=True) as server:
        info = server_info(server)
        oos, baseline, fails = evaluate_oos(server, cfg, best["network"])
        looks = log_oos_look(sh["out"], sh["retrain"]["sweep"]["raw"]["name"], best["seed"], oos, info, cfg)
        bundle = build_bundle(sh["bundle"], cfg, info, best, [{"seed": c["seed"], "selection": {k: v for k, v in c["selection"].items() if k != "months"}} for c in seeds],
                              oos, baseline, fails,
                              {"family": rt["sweep"]["raw"]["name"], "trial": candidates["trial"], "oosLooks": looks})
        errors = server.check_bundle(bundle)
        if bundle["validated"] and errors:
            raise RuntimeError(f"the harness refuses the bundle: {'; '.join(errors)}")
    write_bundle(sh["out"], sh["bundle"], bundle)
    log(f"wrote {sh['out'] / (sh['bundle'] + '.json')} and report.md (out-of-sample looks for this family: {looks})")
    if not bundle["validated"]:
        log("not promoted: the bundle failed the gate (zero blows in every month and the pass rate are not waivable)")
        return bundle, None
    dest = promote(sh["out"], sh["bundle"], models_dir or sh["models"])
    log(f"promoted to {dest}")
    log(f"to trade it, set strategies/{bundle['strategy']}/STRATEGY.md to what it was trained with: policy: {{ bundle: {sh['bundle']} }}, "
        f"sizing: {json.dumps(bundle['sizing'] or {})}, contracts: {bundle['contracts']} (keep status: paper until the user activates it)")
    return bundle, dest
