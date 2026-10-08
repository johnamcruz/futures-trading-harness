"""The gymnasium env over the harness's env server, on synthetic bars."""

import tempfile
import unittest

import numpy as np

from fth_rl.bridge import EnvServer, EnvServerError
from fth_rl.config import load_config

from .synthetic import environ, write_config


class EnvTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dir = tempfile.mkdtemp()
        cls.config, env = write_config(cls.dir)
        cls._environ = environ(env)
        cls._environ.__enter__()

    @classmethod
    def tearDownClass(cls):
        cls._environ.__exit__(None, None, None)

    def test_episodes_follow_masks_and_end_on_the_attempts_outcome(self):
        from fth_rl.env import ChallengeEnv

        cfg = load_config(self.config)
        env = ChallengeEnv(str(self.config), cfg["_windows"]["train"], seed=1)
        try:
            self.assertEqual(env.observation_space.shape, (len(env.obs_fields),))
            self.assertEqual(env.obs_fields[-1], "strategy:ema_wide")
            rng = np.random.default_rng(0)
            for _ in range(3):
                obs, info = env.reset()
                self.assertEqual(obs.shape, (len(env.obs_fields),))
                total, steps, done = 0.0, 0, False
                while not done:
                    m = env.action_masks()
                    self.assertTrue(m[:2].all())
                    if info.get("kind") == "position":
                        self.assertFalse(m[2])
                    obs, r, term, trunc, info = env.step(int(rng.choice(np.flatnonzero(m))))
                    total += r
                    steps += 1
                    done = term or trunc
                self.assertIn(info["outcome"]["status"], ("passed", "blown", "timeout", "active"))
                self.assertTrue(np.isfinite(total) and steps > 0)
            # A masked action is refused, and the episode goes on.
            found = False
            for _ in range(10):
                env.reset()
                done = False
                while not done and not found:
                    if not env.action_masks()[2]:
                        with self.assertRaisesRegex(EnvServerError, "not allowed"):
                            env.step(2)
                        _, _, term, trunc, _ = env.step(0)
                        found = True
                        break
                    _, _, term, trunc, _ = env.step(2)
                    done = term or trunc
                if found:
                    break
            self.assertTrue(found, "no in-trade decision in 10 attempts")
        finally:
            env.close()

    def test_rewards_sum_to_the_balance_change_plus_the_outcome(self):
        from fth_rl.env import ChallengeEnv

        cfg = load_config(self.config)
        with EnvServer(self.config, quiet=True) as server:
            info = server.info()
            env = ChallengeEnv(str(self.config), cfg["_windows"]["train"], seed=2, server=server)
            env.reset()
            total, done = 0.0, False
            while not done:
                _, r, term, trunc, step_info = env.step(int(np.flatnonzero(env.action_masks())[-1]))
                total += r
                done = term or trunc
            o = step_info["outcome"]
            rw = info["reward"]
            bonus = {"passed": rw["pass"] + rw["speed"] * max(0, 1 - o["sessions"] / info["accountProfile"]["sessions"]), "blown": -rw["blow"], "timeout": -rw["timeout"]}.get(o["status"], 0)
            trades = rw["win"] * o["wins"] - rw["loss"] * o["losses"]
            self.assertAlmostEqual(total, rw["dense"] * o["profit"] / info["accountProfile"]["max_loss"] + trades + bonus, places=6)
            # The same attempt, rules only, through evaluate: every setup taken at full size.
            r = server.evaluate([env.starts[0]], cfg["_windows"]["train"][1])
            self.assertEqual(r["attempts"], 1)


if __name__ == "__main__":
    unittest.main()
