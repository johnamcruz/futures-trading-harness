'use strict';

/**
 * Inference for a trained policy network, as stored in a policy bundle
 * (trained in Python by rl/fth_rl, exported by rl/fth_rl/export.py):
 *
 *   { obsDim, actionN, hidden,
 *     actor: { sizes: [obsDim, ...hidden, actionN], layers: [{ W, b }] },
 *     normalizer: { mean, var, clip } }
 *
 * W is row-major (out x in). Hidden layers are tanh, the last is linear.
 * Observations are normalized as (x - mean) / sqrt(var + 1e-8), clipped to
 * +/- clip, the same as stable-baselines3's VecNormalize. Actions are the
 * argmax of the masked softmax.
 */

const NORM_EPS = 1e-8;

function fromJSON(json) {
  const sizes = json && json.sizes;
  if (!Array.isArray(sizes) || sizes.length < 2 || !Array.isArray(json.layers) || json.layers.length !== sizes.length - 1) {
    throw new Error('invalid network: sizes and layers disagree');
  }
  const layers = json.layers.map((L, l) => {
    const nIn = sizes[l];
    const nOut = sizes[l + 1];
    if (!Array.isArray(L.W) || L.W.length !== nIn * nOut || !Array.isArray(L.b) || L.b.length !== nOut || ![...L.W, ...L.b].every(Number.isFinite)) {
      throw new Error(`invalid network: layer ${l} has the wrong shape or non-finite weights`);
    }
    return { nIn, nOut, W: Float64Array.from(L.W), b: Float64Array.from(L.b) };
  });
  return { sizes: [...sizes], layers };
}

function forward(net, x) {
  let h = Float64Array.from(x);
  net.layers.forEach((L, l) => {
    const y = new Float64Array(L.nOut);
    for (let o = 0; o < L.nOut; o += 1) {
      let s = L.b[o];
      const row = o * L.nIn;
      for (let k = 0; k < L.nIn; k += 1) s += L.W[row + k] * h[k];
      y[o] = l < net.layers.length - 1 ? Math.tanh(s) : s;
    }
    h = y;
  });
  return h;
}

/** Masked softmax: masked actions get probability 0. */
function maskedSoftmax(logits, mask) {
  let max = -Infinity;
  for (let k = 0; k < logits.length; k += 1) if (mask[k] && logits[k] > max) max = logits[k];
  const p = new Float64Array(logits.length);
  let sum = 0;
  for (let k = 0; k < logits.length; k += 1) {
    if (!mask[k]) continue;
    p[k] = Math.exp(logits[k] - max);
    sum += p[k];
  }
  for (let k = 0; k < p.length; k += 1) p[k] /= sum;
  return p;
}

function argmax(p) {
  let best = -1;
  for (let k = 0; k < p.length; k += 1) if (best < 0 || p[k] > p[best]) best = k;
  return best;
}

/** Inference-only policy from a bundle's network (deterministic: argmax). */
function loadPolicy(json) {
  if (!json || !Number.isInteger(json.obsDim) || !Number.isInteger(json.actionN)) throw new Error('invalid policy: obsDim and actionN');
  const actor = fromJSON(json.actor);
  const n = json.normalizer;
  if (!n || !Array.isArray(n.mean) || n.mean.length !== json.obsDim || !Array.isArray(n.var) || n.var.length !== json.obsDim
    || ![...n.mean, ...n.var].every(Number.isFinite) || n.var.some(v => v < 0) || !(n.clip > 0)) {
    throw new Error('invalid policy: normalizer shape');
  }
  if (actor.sizes[0] !== json.obsDim || actor.sizes[actor.sizes.length - 1] !== json.actionN) throw new Error('invalid policy: network shape');
  const normalize = x => Float64Array.from(x, (v, k) => Math.max(-n.clip, Math.min(n.clip, (v - n.mean[k]) / Math.sqrt(n.var[k] + NORM_EPS))));
  return {
    obsDim: json.obsDim,
    actionN: json.actionN,
    probs(obs, mask) {
      if (obs.length !== json.obsDim) throw new Error(`observation has ${obs.length} fields; the policy expects ${json.obsDim}`);
      return maskedSoftmax(forward(actor, normalize(obs)), mask);
    },
    act(obs, mask) {
      return argmax(this.probs(obs, mask));
    },
  };
}

module.exports = { NORM_EPS, fromJSON, forward, maskedSoftmax, loadPolicy };
