"""The prop challenge as a gymnasium env with action masks (sb3-contrib MaskablePPO).

An episode is one attempt from a random start in a window: the harness's
backtester runs the account until it passes, blows, or times out, pausing at
each decision. Actions: at a setup 0 skip, 1 half, 2 full; in a trade past the
ratchet 0 hold, 1 close (2 is masked).
"""

import gymnasium as gym
import numpy as np

from .bridge import EnvServer

FINAL = ("passed", "blown", "timeout")


class ChallengeEnv(gym.Env):
    metadata = {"render_modes": []}

    def __init__(self, config_path, window, seed=None, server=None):
        super().__init__()
        self.server = server or EnvServer(config_path, quiet=True)
        self._owns_server = server is None
        info = self.server.info()
        self.obs_fields = info["obsFields"]
        self.observation_space = gym.spaces.Box(-np.inf, np.inf, (len(self.obs_fields),), np.float32)
        self.action_space = gym.spaces.Discrete(info["actionN"])
        self.window = list(window)
        self.starts = self.server.starts(self.window)
        if not self.starts:
            raise ValueError(f"no attempt fits in {self.window} (it needs more trading days than the account's sessions)")
        self._base_seed = 0 if seed is None else int(seed)
        self._rng = np.random.default_rng(self._base_seed)
        self._mask = np.ones(self.action_space.n, dtype=bool)
        self._obs = np.zeros(len(self.obs_fields), dtype=np.float32)

    def _take(self, msg):
        self._obs = np.asarray(msg["obs"], dtype=np.float32)
        self._mask = np.asarray(msg["mask"], dtype=bool)
        return self._obs

    def reset(self, *, seed=None, options=None):
        super().reset(seed=seed)
        if seed is not None:
            # SB3 seeds env k of a run with seed s as s + k, so runs with nearby
            # seeds would share start streams: mix in this env's own seed.
            self._rng = np.random.default_rng([self._base_seed, int(seed)])
        fixed = (options or {}).get("start")
        for _ in range(200):
            start = fixed if fixed is not None else int(self._rng.choice(self.starts))
            msg = self.server.request({"cmd": "reset", "start": int(start), "end": self.window[1]})
            if not msg["done"]:
                return self._take(msg), {"kind": msg["kind"], "start": start}
            if fixed is not None:
                raise ValueError(f"the attempt from {start} has no decision")
        raise RuntimeError("200 attempts in a row had no decision: the strategies find no setups in this window")

    def step(self, action):
        msg = self.server.request({"cmd": "step", "action": int(action)})
        reward = float(msg.get("reward", 0.0))
        if not msg["done"]:
            return self._take(msg), reward, False, False, {"kind": msg["kind"]}
        outcome = msg["outcome"]
        terminated = outcome["status"] in FINAL
        return self._obs, reward, terminated, not terminated, {"outcome": outcome}

    def action_masks(self):
        return self._mask.copy()

    def close(self):
        if self._owns_server:
            self.server.close()
