# gta6-trophy-forecast

Forecast, for every trophy of Grand Theft Auto VI on PlayStation 5, its earn
rate on Exophase at 2026-11-26T00:00:00Z — as five quantiles per trophy
(5%, 25%, 50%, 75%, 95%) — from the house's recorded reads of the game's
Exophase trophy page.

Entry for the make.fun competition
[gta6-trophy-rarity-forecast-01](https://make.fun/bounty/gta6-trophy-rarity-forecast-01)
(owner: Omar08263, referral code: {referral_code}).

## Run

```sh
mkdir -p out
MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

`main.ts` (Node 22, standard library only, no network) reads every
`<id>.in` in the input directory and writes `<id>.out` for each: one JSON
object `{"trophies": [{"id": n, "q": [q05, q25, q50, q75, q95]}, ...]}`,
one row per trophy of the case.

## Model

- Exophase's page is a stale snapshot: the rates in a read are as of the
  game's last refresh before the read, not the read time. Consecutive
  identical reads carry no new information, so the history is first
  compressed into distinct snapshots (first-seen time kept).
- Earners and tracked players are modelled separately, in log space,
  against `x = ln(1 + hours since release)`. Per trophy, `log(earners)` is
  fitted by least squares over the distinct snapshots, its slope shrunk
  toward the pooled (median) slope; `log(players tracked)` is fitted the
  same way. The forecast rate is earners / players at the target. The
  log-time scale makes the extrapolation saturate over a multi-day
  horizon, and separating earners from players keeps dilution (new,
  less-progressed players joining) from being confused with real
  progression.
- When the history holds only one distinct snapshot (launch night: the
  page sat unchanged for hours), no trend is estimable and a prior takes
  over: the tracked base keeps growing through the unseen refreshes
  (log-players growth ~0.35/hour of unseen time, the order of the first
  refresh the kit documents: 638 → 3,868 tracked players), while earners
  grow much more slowly (new players hold ~1 trophy each on average), so
  rates fall sharply at the refresh. A trophy already at 100% is assumed
  to stay at ~100%.
- Spread (logit std) combines a random-walk term growing with the
  horizon, the fit's residual, and slope uncertainty over the
  extrapolation gap, plus a large extra term when the history is a single
  flat snapshot. Quantiles are the median shifted by the standard-normal
  z for each level.

Deterministic: no randomness, no clock reads, no network.

## Practice results (local, measured)

Practice histories are completely flat (638 players, identical rates), so
the exact practice answers are not in the kit. I reconstructed the
04:30Z refresh answer from the facts the kit states (3,868 players,
4,276 trophies earned, the 100% trophy unchanged) under three
distributions of the 103 remaining new trophy-earns (proportional to old
counts / early trophies only / spread evenly). Against those proxies:

| case | my pinball loss | house baseline |
| ---- | --------------: | -------------: |
| p00  | 0.27 – 0.34     | 1.39 – 1.52    |
| p01  | 0.24 – 0.30     | 1.39 – 1.52    |

Typical miss ~0.05–0.12 percentage points; 90% coverage 0.98 on the
proxies. Runtime ~0.2 s per case (limit 8 s); outputs byte-identical
across repeated runs.

These are proxy measurements, not the official practice grade — the kit
does not ship the practice answers.

## License

MIT
