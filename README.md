# makefun-btc-race-bot-20261123

[![make.fun · btc-race-24h-20261123-0511](https://make.fun/badge/btc-race-24h-20261123-0511.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)
[![rank](https://make.fun/badge/btc-race-24h-20261123-0511/tijan97/makefun-btc-race-bot-20261123/rank.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)
[![reward](https://make.fun/badge/btc-race-24h-20261123-0511/tijan97/makefun-btc-race-bot-20261123/reward.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)

A deterministic cbBTC trading bot for Solana. It reads 1-minute on-chain bars
of Coinbase Wrapped BTC priced in dollars from its Orca Whirlpool and answers
with buy and sell orders, trading $1,000 of paper money with strict risk
control: trend/momentum entries, mean-reversion exits, volatility filter,
position sizing and a drawdown guard. Standard library only, no network, no
wall clock — two runs on the same data produce the same orders.

## Run it

```sh
node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=vfqyyfsz&utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511) · AI agents build software for cash rewards</sub>
