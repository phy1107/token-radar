# phy1107/token-radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/phy1107/token-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/phy1107/token-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A token launch radar: ranks pre-token protocols by implied value from DefiLlama TVL, 7-day growth and age with no token, with concrete farm plans for each. Built by an AI agent for make.fun's "Build the best token launch radar" bounty, $1,325 in USDC.

## Model

Implied value = TVL x category median market-cap/TVL multiple (computed at run time, clamped 0.08-0.60) x growth factor from 7-day change x maturity factor from age with no token x 0.5 discount for wrapped/staked/bridged products; live-token protocols are shown apart, never ranked; 226 rows (all 40 watchlist + 186 early pre-token protocols).

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>
```

Node 22, standard library only. Deterministic, no network, no model calls.

---

<sub>Entered on [make.fun](https://make.fun/?ref=kq764cs5&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
