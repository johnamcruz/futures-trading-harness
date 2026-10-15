#!/bin/sh
# Training-run template: a LoRA adapter for the base model Qwen3.5-9B-4bit (MLX, 4-bit), the local model,
# trained with MLX LoRA (mlx_lm.lora) on the verified-decision dataset, in the two steps of adapters/spec.json.
# See adapters/README.md. Copy it to train.sh beside it (gitignored) or outside the repository, fill every
# <placeholder> with your own local paths, and run it. Never commit a machine path, weights or a dataset.
#
# The data (dataset format v2, adapters/spec.json dataset.version) is OpenAI-style chat JSONL, one { "messages": [...] }
# per line: system, user (the cycle's prompt), then the head trader's whole turn in order: assistant messages with
# "tool_calls" ({ id, type "function", function { name, arguments } }), each call's result as a "tool" message
# ({ tool_call_id, content }), and the final assistant text. Check that the base model's chat template renders
# tool_calls and tool messages (print one rendered example before training); a template that drops them trains on a
# turn the model never saw. With --mask-prompt only the final assistant message is trained on; the tool calls and
# results before it are context. Subagent turns are in the data only if the build named them (--roles).
#
# Every value below is a starting point, not a tuned setting: record the ones you train with in the adapter's
# manifest (node scripts/adapter.js init --settings <file>).
set -eu

BASE_MODEL="<the Qwen3.5-9B-4bit MLX weights: a local folder or a model id>"
DATASET="<the dataset folder: node scripts/decision-dataset.js build ... --out <folder>>"
ADAPTER="<the adapter folder, e.g. adapters/qwen3.5-9b-4bit/<name> (gitignored)>"
SEED=1
MAX_SEQ="<the longest example's tokens: the roles' prompts are long>"

# Step 1: stage-1 data only (learn to trade). Validated by the stage-1 exit test on practice-validate.
mlx_lm.lora --model "$BASE_MODEL" --train --data "$DATASET/step1" --adapter-path "$ADAPTER/step1" \
  --fine-tune-type lora --num-layers 16 --batch-size 1 --iters 600 --learning-rate 1e-5 \
  --max-seq-length "$MAX_SEQ" --mask-prompt --grad-checkpoint --steps-per-eval 100 --save-every 100 --seed "$SEED"

# Step 2: stage-2 data plus the spec's slice of stage-1 data (already mixed into step2/train.jsonl), starting from
# step 1's adapter. Validated by the 30-day prop Monte Carlo keep rule on practice-validate.
mlx_lm.lora --model "$BASE_MODEL" --train --data "$DATASET/step2" --adapter-path "$ADAPTER/step2" \
  --resume-adapter-file "$ADAPTER/step1/adapters.safetensors" \
  --fine-tune-type lora --num-layers 16 --batch-size 1 --iters 400 --learning-rate 5e-6 \
  --max-seq-length "$MAX_SEQ" --mask-prompt --grad-checkpoint --steps-per-eval 100 --save-every 100 --seed "$SEED"

# Serve the base model with the adapter under the model id your harness CLI config already names, so the two
# replays of the evaluation differ only in the adapter the runner config declares (adapters/README.md):
#   mlx_lm.server --model "$BASE_MODEL" --adapter-path "$ADAPTER/step2"
