// GTA VI trophy rarity forecast (make.fun gta6-trophy-rarity-forecast-01).
//
// Forecasts, for every trophy, its Exophase earn rate at the case's target,
// as five quantiles (levels 0.05 / 0.25 / 0.5 / 0.75 / 0.95) in percent.
//
// Model, in brief:
//  * Exophase's page is a stale snapshot: the rates in a read are as of the
//    game's last refresh before the read, not the read time. Consecutive
//    reads that are identical carry no new information, so the history is
//    first compressed into distinct snapshots (first-seen time kept).
//  * Earners and tracked players are modelled separately, in log space,
//    against x = ln(1 + hours since release). Per trophy, log(earners) is
//    fitted by least squares over the distinct snapshots and its slope is
//    shrunk toward the pooled (median) slope; log(players tracked) is
//    fitted the same way. The forecast rate is earners / players at the
//    target. Using ln(1 + hours) makes the extrapolation saturate instead
//    of running away over a multi-day horizon, and modelling earners
//    separately from players keeps dilution (new, less-progressed players
//    joining) from being confused with real progression.
//  * When the history holds only one distinct snapshot (launch night: the
//    page sat unchanged for hours), no trend is estimable. Then a prior
//    takes over: the tracked base is assumed to keep growing through the
//    unseen refreshes (log-players growth ~0.35/hour of unseen time, the
//    order of the first refresh the kit documents: 638 -> 3,868 tracked
//    players), while earners grow much more slowly (new players hold ~1
//    trophy each on average), so rates fall sharply at the refresh. A
//    trophy already at 100% is assumed to stay at ~100% (every new player
//    earns it almost immediately).
//  * Spread (logit std) combines a random-walk term growing with the
//    horizon, the fit's residual, slope uncertainty over the extrapolation
//    gap, and a large extra term when the history is a single flat
//    snapshot (a refresh of unknown size is coming). Quantiles are the
//    median shifted by the standard-normal z for each level.
//
// Deterministic: no randomness, no clock reads, no network, stdlib only.

import { readdirSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const Z = [-1.6448536269514722, -0.6744897501960817, 0, 0.6744897501960817, 1.6448536269514722];
const RELEASE_MS = Date.parse("2026-11-19T00:00:00Z");

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}
function logitPct(p: number): number {
  const q = clamp(p, 0.01, 99.99) / 100;
  return Math.log(q / (1 - q));
}
function invLogitPct(l: number): number {
  const e = Math.exp(-clamp(l, -30, 30));
  return 100 / (1 + e);
}
function xOf(ms: number): number {
  const h = Math.max(0, (ms - RELEASE_MS) / 3600000);
  return Math.log1p(h);
}

// Least-squares line y ~ a + b*x. Returns null when x has no spread.
function ols(xs: number[], ys: number[]): { a: number; b: number; resid: number } | null {
  const n = xs.length;
  if (n < 2) return null;
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; }
  mx /= n; my /= n;
  let sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sxx += (xs[i] - mx) * (xs[i] - mx); sxy += (xs[i] - mx) * (ys[i] - my); }
  if (sxx < 1e-12) return null;
  const b = sxy / sxx;
  const a = my - b * mx;
  let ss = 0;
  for (let i = 0; i < n; i++) { const r = ys[i] - (a + b * xs[i]); ss += r * r; }
  return { a, b, resid: Math.sqrt(ss / Math.max(1, n - 2)) };
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

interface Trophy { id: number; tier: string }
interface CaseFile {
  id: string;
  at: string;
  target: string;
  horizon_minutes: number;
  trophies: Trophy[];
  history: { slot: string; at: string; players_tracked: number; rates: (number | null)[] }[];
}

function tierPrior(tier: string): number {
  if (tier === "platinum") return 0.05;
  if (tier === "gold") return 0.5;
  if (tier === "silver") return 1.0;
  return 2.0;
}

function forecastOne(c: CaseFile): { id: number; q: number[] }[] {
  const nT = c.trophies.length;
  const targetMs = Date.parse(c.target);
  const atMs = Date.parse(c.at);
  const horizonDays = Math.max(0, (c.horizon_minutes || 0) / 1440);
  const xTarget = xOf(targetMs);

  // --- compress history into distinct snapshots (first-seen time kept) ---
  const snaps: { ms: number; x: number; n: number; rates: (number | null)[] }[] = [];
  const seen = new Set<string>();
  const hist = [...(c.history || [])].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  for (const h of hist) {
    const key = `${h.players_tracked}|${(h.rates || []).join(",")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const ms = Date.parse(h.at);
    snaps.push({ ms, x: xOf(ms), n: h.players_tracked || 0, rates: h.rates || [] });
  }
  const last = snaps.length ? snaps[snaps.length - 1] : null;
  const lastRates: (number | null)[] = last ? last.rates : c.trophies.map(() => null);
  const lastN = last && last.n > 0 ? last.n : 638;

  // --- fit log(players tracked) vs x over distinct snapshots ---
  const nPts = snaps.filter((s) => s.n > 0);
  const nFit = ols(nPts.map((s) => s.x), nPts.map((s) => Math.log(s.n)));
  let logNPred: number;
  if (nFit && snaps.length >= 2) {
    const w = snaps.length / (snaps.length + 1); // mild shrinkage of the slope
    logNPred = nFit.a + nFit.b * w * xTarget;
  } else {
    logNPred = Math.log(lastN);
  }
  // Never forecast fewer players than last seen; cap explosive growth.
  logNPred = clamp(logNPred, Math.log(lastN), Math.log(lastN) + Math.log(60));

  // --- per-trophy log(earners) fits, slopes shrunk toward the pooled slope ---
  const slopes: number[] = [];
  const fits: ({ a: number; b: number; resid: number } | null)[] = [];
  for (let i = 0; i < nT; i++) {
    const xs: number[] = [];
    const ys: number[] = [];
    for (const s of snaps) {
      const r = s.rates[i];
      if (r === null || r === undefined || s.n <= 0) continue;
      const e = Math.max(0.5, (r / 100) * s.n); // pseudo-count so 0 stays finite
      xs.push(s.x);
      ys.push(Math.log(e));
    }
    const f = xs.length >= 2 ? ols(xs, ys) : null;
    fits.push(f);
    if (f) slopes.push(f.b);
  }
  const pooledSlope = median(slopes);
  const flatHistory = snaps.length <= 1;

  const out: { id: number; q: number[] }[] = [];
  for (let i = 0; i < nT; i++) {
    const t = c.trophies[i];
    const lastRate = lastRates[i];
    const r = lastRate === null || lastRate === undefined ? null : lastRate;

    let med: number;
    let spread: number;

    if (r !== null && r >= 99.995) {
      // Already at 100%: every tracked player holds it; new players earn
      // it (near-)immediately, so it stays at ~100%.
      med = 99.9;
      spread = 0.3;
    } else if (flatHistory || !fits[i]) {
      // --- single flat snapshot: prior-driven refresh forecast ---
      // Unseen-growth window: first snapshot -> target.
      const firstMs = snaps.length ? snaps[0].ms : atMs;
      const unseenH = Math.max(0, (targetMs - firstMs) / 3600000);
      const nMult = Math.min(25, Math.exp(0.35 * unseenH));
      const eRate = t.tier === "platinum" ? 0.02 : 0.1; // earners / hour, log
      const eMult = Math.exp(eRate * unseenH);
      const base = r === null ? tierPrior(t.tier) : r;
      med = clamp((base * eMult) / nMult, 0.01, 99.9);
      // Wide spread: the refresh size is essentially unknown.
      spread = 0.5 * Math.sqrt(horizonDays) + 0.7;
    } else {
      const f = fits[i]!;
      // Shrink slope toward pooled slope; weight grows with #snapshots.
      const w = snaps.length / (snaps.length + 3);
      const b = w * f.b + (1 - w) * pooledSlope;
      const logE = f.a + b * xTarget;
      const rate = (Math.exp(logE) / Math.exp(logNPred)) * 100;
      med = clamp(rate, 0.01, 99.9);
      const gap = Math.max(0, xTarget - xOf(snaps[snaps.length - 1].ms));
      const slopeUnc = Math.abs(b) * 0.25 * gap + 0.15 * gap;
      spread = Math.sqrt(
        Math.pow(0.5 * Math.sqrt(horizonDays), 2) +
        Math.pow(Math.max(0.15, f.resid), 2) +
        Math.pow(slopeUnc, 2) + 0.04,
      );
      spread = clamp(spread, 0.35, 1.6);
    }

    if (r === null) {
      // Trophy unseen in every read: tier prior, very wide spread.
      med = tierPrior(t.tier);
      spread = Math.max(spread, 1.2);
    }

    const lm = logitPct(med);
    const qs: number[] = [];
    let prev = -Infinity;
    for (const z of Z) {
      let q = invLogitPct(lm + z * spread);
      q = clamp(Math.round(q * 10000) / 10000, 0.01, 99.99);
      if (q < prev) q = prev;
      qs.push(q);
      prev = q;
    }
    out.push({ id: t.id, q: qs });
  }
  return out;
}

function main(): void {
  const inDir = process.env.MAKEFUN_INPUT_DIR || "/input";
  const outDir = process.env.MAKEFUN_OUTPUT_DIR || "/output";
  mkdirSync(outDir, { recursive: true });
  const files = readdirSync(inDir).filter((f) => f.endsWith(".in")).sort();
  for (const f of files) {
    const c = JSON.parse(readFileSync(join(inDir, f), "utf8")) as CaseFile;
    const rows = forecastOne(c);
    const id = f.replace(/\.in$/, "");
    writeFileSync(join(outDir, `${id}.out`), JSON.stringify({ trophies: rows }));
  }
}

main();
