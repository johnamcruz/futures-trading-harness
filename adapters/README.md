# Adapters

A LoRA adapter fine-tunes the local reasoning model on decisions the code
verified correct. This folder holds what is shared: this guide, the
model-neutral training spec (`spec.json`) and one training template per base
model (`<base>/train.example.sh`). Everything else stays on your machine and is
gitignored: weights, checkpoints, built datasets, adapter manifests, your
copies of the templates, and the runner config that selects an adapter.

`adapters/` is the one folder in the repository that may name a model (as
`accounts/` names firms). Nowhere else does: model specifics stay in your local
config (`tests/plugin/no-platform-specifics.test.js`).

Nothing in the harness needs an adapter. A run with none selected is a base
run, and the runner never reads the selection. Build one only after stage 2
is done (`docs/TRAINING.md`, "Fine-tuning on verified decisions (after stage 2)").

## 1. Build the dataset

The dataset is decisions the code verified correct, labelled by process and
never by outcome (`scripts/lib/learning/decision-label.js`):

- **A take** is correct only if:
  - every claimed read is verified true;
  - the scorecard grades it right;
  - its R:R is at least `min_rr` and its risk at most `max_risk_usd`
    (`trade_lifecycle`'s);
  - no gate or risk rule refused it;
  - in stage 2, the account state doesn't call for standing down.
- **A pass** is correct when no valid setup existed, or when the account
  state or the rules call for standing down.
- **A risk action** in a trade is correct when it fits the rules for that
  account state.

The definitions are the measurement's: a decision's reads are correct only
when every one is verified true (the exit test's correct-read rate, per
decision); a size under the ceiling is the model's own share, and only one over
it is wrong; an exit the runner made (its trail or time stop) is the policy's,
never the model's decision.

A losing trade made by the process is correct. A winning trade made against
it is not. Everything else is `incorrect` or `unverifiable`, each with its
reason, and neither is ever trained on.

1. **Sample.** Re-run each curated practice-train moment K times, with
   sampling on:

   ```bash
   node scripts/decision-dataset.js sample --config <stage replay config> --k 4 --sampling <local sampling file> --seed 1 --bars MNQ=<1m bars>
   ```

   - **The base run.** A curated practice-train replay, run with checkpoints.
     Each moment is re-run from its checkpoint
     (`scripts/lib/train/decision-points.js`).
   - **Seeds.** Every sample has its own seed. `samples.jsonl` records which
     sample (time, repeat, seed, sampling digest) produced which decisions.
   - **The sampling file** is yours and stays local, for example
     `{ "temperature": 0.8, "top_p": 0.95 }`. Each setting reaches the
     harness process as `FTH_SAMPLING_<NAME>`, beside `FTH_TRAIN_SEED`, for
     your harness CLI or model server config to read. A missing or zero
     temperature is refused.

2. **Build.**

   ```bash
   node scripts/decision-dataset.js build --train <samples.jsonl or run dir> ... --validate <practice-validate run dir> ... --out <new folder>
   ```

   - **Splits.** The train set comes from practice-train runs only, the
     validate set from practice-validate runs only. A run on test or final
     is refused.
   - **Prompts.** Each example is the exact prompts a role saw, then its
     response, as model-agnostic chat JSONL (`{"messages": [...]}`). They are
     byte-faithful where the run recorded them:
     - the head trader's cycle prompt and its text;
     - each subagent's task prompt and its reply;
     - the system prompt from the run's own `workspace/opencode.json`.

     A transcript the reader doesn't recognize gives no example.
   - **Duplicates** are dropped.
   - **The digest.** Each example records the skills and prompt digest its
     run was made under. Only examples under the harness's digest now (the
     one an adapter's manifest records) are kept: the others are dropped and
     counted (`show` prints how many), since decisions made under old wording
     teach rules that no longer exist. `--include-digest any` or
     `--include-digest <hex prefix>` keeps others by name, each marked
     `"current": false` in `meta.jsonl`.
   - **Balance.** The train decisions are balanced by `spec.json`: by skill,
     by take against pass, by account state (near the max loss limit well
     represented) and by year. A balance that can't be met refuses the build.
   - **Output.**
     - `step1/train.jsonl` and `step1/valid.jsonl`: stage 1, no account state.
     - `step2/train.jsonl`: stage 2, plus the spec's slice of stage 1 mixed
       back in.
     - `step2/valid.jsonl`: stage 2.
     - `meta.jsonl`: each example's source run, sample, decision and label.
     - `dataset.json`: the fingerprint and the source runs.
   - `show <folder>` checks the fingerprint against the files.

The scorecard grades each decision. A run whose months the scorecard's look
schedule refuses for a tuning look needs its scorecard written first, under a
look the ledger allows: `node scripts/replay.js scorecard <run dir> ...`. The
build reads a `scorecard.jsonl` written after the run's last step.

## 2. Train

The spec trains in two steps:

1. **Step 1:** stage-1 data only.
2. **Step 2:** stage-2 data plus the spec's slice of stage-1 data
   (`mixStage1`), starting from step 1's adapter.

Copy your base model's template (`<base>/train.example.sh`) to `train.sh`
beside it (gitignored), fill the placeholders with your own local paths, and
run it. Put the adapter under `adapters/<base>/<name>/`, which is gitignored.

## 3. Record the manifest

Every adapter has a manifest (`scripts/lib/learning/adapter.js
validateManifest`). It is local, beside the weights:

```bash
node scripts/adapter.js init --name <name> --base-model <base model> --folder <base> --dataset <dataset folder> \
  --step 1 --settings <the settings you trained with, a JSON file> [--seed N] [--parent <step 1 manifest>] --out <adapter folder>/manifest.json
node scripts/adapter.js check <manifest>
```

It records:

- the harness commit;
- the skills and prompt digests (the documents the cycles read);
- the dataset fingerprint;
- the base model;
- the training settings;
- the validation result.

A new manifest's validation is `pending`.

## 4. Judge it

Judge the adapter on practice-validate:

- **Step 1:** the stage-1 exit test (`EXIT_TEST` in
  `scripts/lib/replay/stage.js`).
- **Step 2:** the 30-day prop Monte Carlo keep rule (`docs/TRAINING.md`,
  section 6).

The evaluation is two replays of the same windows and seed:

- **Base:** the runner config names no adapter.
- **Adapted:** the same config with `"adapter": "<absolute or ~/ path to the
  manifest>"`, your model server running the base model with the adapter under
  the same model id.

The `adapter` field is a declaration. It enters both run hashes and the A/B
setup record by the manifest's digest. Compare the two runs with
`node scripts/ab-compare.js <base run> <adapted run> --field adapter`, and
apply the keep rule.

Record the result:

```bash
node scripts/adapter.js validated <manifest> --status passed|failed --runs <base runId>,<adapted runId> --result <result JSON file>
```

## 5. Use it

Name the manifest in your local runner config (`"adapter"`) and serve the
model with the adapter. The training preflight's `adapter` check:

- is N/A with no adapter selected;
- FAILs on a missing or invalid manifest;
- FAILs on a stale adapter (its skills or prompt digest isn't the harness's
  now: retrain it);
- FAILs on a missing validation result, or a failed one;
- FAILs on a pending validation anywhere but practice-validate, its own
  evaluation.

A skill change makes every adapter stale until it is retrained.
