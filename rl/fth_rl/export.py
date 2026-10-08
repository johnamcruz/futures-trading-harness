"""Export a MaskablePPO policy (with its VecNormalize statistics) to the
harness's bundle network, and run that network in numpy exactly as the
harness does (scripts/lib/rl/policy-net.js)."""

import numpy as np

NORM_EPS = 1e-8  # policy-net.js NORM_EPS; VecNormalize's default epsilon
NO_CLIP = 1e9


def _linears(seq):
    import torch.nn as nn

    out = []
    for m in seq:
        if isinstance(m, nn.Linear):
            out.append(m)
        elif not isinstance(m, nn.Tanh):
            raise ValueError(f"unsupported layer {type(m).__name__}: the harness runs tanh MLPs")
    return out


def export_network(model, vec_normalize=None):
    """The bundle's `network` from a trained MaskablePPO and its VecNormalize."""
    import torch.nn as nn
    from stable_baselines3.common.torch_layers import FlattenExtractor

    policy = model.policy
    if policy.activation_fn is not nn.Tanh:
        raise ValueError("train with activation_fn=nn.Tanh: the harness runs tanh MLPs")
    if not isinstance(policy.pi_features_extractor, FlattenExtractor):
        raise ValueError("the harness supports the default (flatten) features extractor only")
    layers = _linears(policy.mlp_extractor.policy_net) + [policy.action_net]
    obs_dim = layers[0].in_features
    sizes = [obs_dim] + [lin.out_features for lin in layers]
    actor = {
        "sizes": sizes,
        "layers": [
            {
                "W": lin.weight.detach().cpu().double().numpy().reshape(-1).tolist(),
                "b": lin.bias.detach().cpu().double().numpy().tolist(),
            }
            for lin in layers
        ],
    }
    if vec_normalize is not None and vec_normalize.norm_obs:
        if abs(vec_normalize.epsilon - NORM_EPS) > 1e-15:
            raise ValueError(f"VecNormalize epsilon must be {NORM_EPS} (the harness's)")
        normalizer = {
            "mean": vec_normalize.obs_rms.mean.astype(float).tolist(),
            "var": vec_normalize.obs_rms.var.astype(float).tolist(),
            "count": float(vec_normalize.obs_rms.count),
            "clip": float(vec_normalize.clip_obs),
        }
    else:
        normalizer = {"mean": [0.0] * obs_dim, "var": [1.0 - NORM_EPS] * obs_dim, "count": 0, "clip": NO_CLIP}
    return {
        "obsDim": obs_dim,
        "actionN": sizes[-1],
        "hidden": sizes[1:-1],
        "actor": actor,
        "normalizer": normalizer,
    }


def probs(network, obs, mask):
    """Masked action probabilities, as policy-net.js computes them."""
    n = network["normalizer"]
    x = np.asarray(obs, dtype=np.float64)
    x = np.clip((x - np.asarray(n["mean"])) / np.sqrt(np.asarray(n["var"]) + NORM_EPS), -n["clip"], n["clip"])
    layers = network["actor"]["layers"]
    sizes = network["actor"]["sizes"]
    for i, layer in enumerate(layers):
        w = np.asarray(layer["W"], dtype=np.float64).reshape(sizes[i + 1], sizes[i])
        x = w @ x + np.asarray(layer["b"], dtype=np.float64)
        if i < len(layers) - 1:
            x = np.tanh(x)
    mask = np.asarray(mask, dtype=bool)
    z = np.where(mask, x, -np.inf)
    z = np.exp(z - z[mask].max())
    return z / z.sum()


def act(network, obs, mask):
    return int(np.argmax(probs(network, obs, mask)))


def check_export(model, vec_normalize, network, observations, masks):
    """Count observations where the exported network and the trained model
    disagree on the deterministic action (should be 0, float32 ties aside)."""
    raw = np.asarray(observations, dtype=np.float32)
    x = vec_normalize.normalize_obs(raw) if vec_normalize is not None and vec_normalize.norm_obs else raw
    actions, _ = model.predict(x, deterministic=True, action_masks=np.asarray(masks, dtype=bool))
    ours = [act(network, o, m) for o, m in zip(raw, masks)]
    return int(sum(int(a) != b for a, b in zip(actions, ours)))
