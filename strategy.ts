// Established-runner dip buyer for agent-fun/replay/v2 (pump.fun curves).
//
// Idea, measured on the dev window's own tape (128k events, 1222 coins):
// launch-sniping does not survive the harness. The signal only exists at
// the price of the trade that prints it, but a bot decides once per slot and
// fills two slots later — by then the move is gone (a 2-trade entry delay
// turns a +2.7 SOL backtest into a losing one). So this bot does not chase
// launches at all. It buys only coins that already proved themselves:
// aged 1000+ slots, peaked at least 2x their create price, then pulled back
// 15-30% from that peak and started rising again.
//
// Entry (all must hold on the slot the buy is decided):
//   - coin aged >= 1000 slots since create, not complete, not already held
//   - peak price >= 2x the create price (a proven runner, not a fresh coin)
//   - current price between 0.70x and 0.85x of the peak (a real pullback)
//   - the last three observed prices are rising (the dip is turning)
//   - real SOL reserve >= 3 SOL (established liquidity, so the 1% size cap
//     still allows a meaningful stake in one order)
//   - one buy per mint, fixed 0.12 SOL stake, at most 5 open positions
// Exits, priced off the position's own cost basis every batch:
//   - take-profit +12%, stop-loss -8% (tight: losers are cut fast, winners
//     are banked while the window's runners still run)
//   - trailing stop: once up >= 25%, exit on a 12% fall from the best value
//   - max hold 20000 slots, or the creator sells -> exit at once
//
// Nothing here reads the clock, the environment or Math.random: the bot is a
// pure function of the batches it is fed, so two runs agree byte for byte.

import type { Batch, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Slots since create before a coin counts as established. */
  minAgeSlots: number;
  /** Peak must reach this multiple of the create price (bps, 10000 = 1.00x). */
  minPeakBps: number;
  /** Current price must sit in this band under the peak (bps of the peak). */
  dipLowBps: number;
  dipHighBps: number;
  /** Real SOL reserve at decision time, at least (lamports). */
  minRealSolLamports: bigint;
  /** Lamports to spend per buy (still capped at 1% of real reserve). */
  stakeLamports: bigint;
  /** Most open positions at once. */
  maxPositions: number;
  /** Exit when the position is worth this much over its cost (bps). */
  tpBps: number;
  /** Exit when it is worth this much under its cost (bps). */
  slBps: number;
  /** Trailing stop arms once up this much (bps), then exits on a fall of trailBps. */
  trailArmBps: number;
  trailBps: number;
  /** Max slots to hold a position. */
  maxHoldSlots: number;
  /** Slippage allowed on buys (bps). */
  buySlippageBps: number;
  /** Slippage allowed on sells (bps). */
  sellSlippageBps: number;
}

export const DEFAULT_PARAMS: Params = {
  minAgeSlots: 1000,
  minPeakBps: 20000,
  dipLowBps: 7000,
  dipHighBps: 8500,
  minRealSolLamports: 3_000_000_000n,
  stakeLamports: 120_000_000n,
  maxPositions: 5,
  tpBps: 1200,
  slBps: 800,
  trailArmBps: 2500,
  trailBps: 1200,
  maxHoldSlots: 20000,
  buySlippageBps: 500,
  sellSlippageBps: 800,
};

/** Price of a curve as virtual quote per virtual token, as a float ratio. */
function priceOf(vq: bigint, vt: bigint): number {
  if (vt === 0n) return 0;
  return Number(vq) / Number(vt);
}

interface CoinTrack {
  creator: Pubkey;
  createdSlot: number;
  createPrice: number;
  peak: number;
  creatorSold: boolean;
  /** Last three observed prices, oldest first. */
  lastPrices: number[];
  /** Has this coin already been bought once (one buy per mint). */
  entered: boolean;
}

interface HeldTrack {
  bestValueBps: number;
  entrySlot: number;
}

export class EstablishedDipBuyer {
  readonly params: Params;
  readonly coins = new Map<Pubkey, CoinTrack>();
  readonly held = new Map<Pubkey, HeldTrack>();

  constructor(params: Params = DEFAULT_PARAMS) {
    this.params = params;
  }

  private observe(mint: Pubkey, px: number): void {
    const t = this.coins.get(mint);
    if (t === undefined) return;
    if (px > t.peak) t.peak = px;
    t.lastPrices.push(px);
    if (t.lastPrices.length > 3) t.lastPrices.splice(0, t.lastPrices.length - 3);
  }

  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const p = this.params;
    const orders: OrderInput[] = [];
    const touched = new Set<Pubkey>();

    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        const c = state.curves.get(e.mint);
        const cp = c ? priceOf(c.virtual_quote_reserves, c.virtual_token_reserves) : 0;
        this.coins.set(e.mint, {
          creator: e.creator,
          createdSlot: e.slot,
          createPrice: cp,
          peak: cp,
          creatorSold: false,
          lastPrices: cp > 0 ? [cp] : [],
          entered: false,
        });
        touched.add(e.mint);
      } else if (e.event === 'TradeEvent') {
        let t = this.coins.get(e.mint);
        if (t === undefined) {
          const c = state.curves.get(e.mint);
          const cp = c ? priceOf(c.virtual_quote_reserves, c.virtual_token_reserves) : 0;
          t = {
            creator: e.creator,
            createdSlot: e.slot,
            createPrice: cp,
            peak: cp,
            creatorSold: false,
            lastPrices: [],
            entered: false,
          };
          this.coins.set(e.mint, t);
        }
        if (!e.is_buy && e.user === e.creator) t.creatorSold = true;
        const c = state.curves.get(e.mint);
        if (c !== undefined) this.observe(e.mint, priceOf(c.virtual_quote_reserves, c.virtual_token_reserves));
        touched.add(e.mint);
      } else {
        this.coins.delete(e.mint);
        this.held.delete(e.mint);
      }
    }
    // Marks also move the observed price for held coins.
    for (const m of batch.marks) {
      this.observe(m.mint, priceOf(BigInt(m.virtual_quote_reserves), BigInt(m.virtual_token_reserves)));
    }

    // Exits first: every held position is re-priced off its own cost basis.
    for (const [mint, pos] of state.positions) {
      const c = state.curves.get(mint);
      if (c === undefined || c.complete) continue;
      const px = priceOf(c.virtual_quote_reserves, c.virtual_token_reserves);
      const value = BigInt(Math.floor(Number(pos.token_amount) * px));
      const cost = pos.cost_lamports;
      const upBps = cost > 0n ? Number(((value - cost) * 10000n) / cost) : 0;
      const h = this.held.get(mint);
      if (h === undefined) {
        this.held.set(mint, { bestValueBps: upBps, entrySlot: state.slot });
        continue;
      }
      if (upBps > h.bestValueBps) h.bestValueBps = upBps;
      const t = this.coins.get(mint);
      const downFromBestBps = h.bestValueBps - upBps;
      const agedOut = state.slot - h.entrySlot > p.maxHoldSlots;
      const devSold = t !== undefined && t.creatorSold;
      if (
        upBps >= p.tpBps ||
        upBps <= -p.slBps ||
        (h.bestValueBps >= p.trailArmBps && downFromBestBps >= p.trailBps) ||
        agedOut ||
        devSold
      ) {
        orders.push({
          side: 'sell',
          mint,
          token_amount: pos.token_amount,
          max_slippage_bps: p.sellSlippageBps,
        });
        this.held.delete(mint);
      }
    }

    // Entries: only coins that traded on this slot.
    for (const mint of touched) {
      const t = this.coins.get(mint);
      const c = state.curves.get(mint);
      if (t === undefined || c === undefined || c.complete) continue;
      if (t.entered || state.positions.has(mint)) continue;
      if (state.committedPositionCount() >= p.maxPositions) continue;
      let pendingBuy = false;
      for (const po of state.pending.values()) {
        if (po.order.side === 'buy' && po.order.mint === mint) pendingBuy = true;
      }
      if (pendingBuy) continue;
      if (state.slot - t.createdSlot < p.minAgeSlots) continue;
      if (t.createPrice <= 0) continue;
      if (t.peak < (t.createPrice * p.minPeakBps) / 10000) continue;
      if (c.real_quote_reserves < p.minRealSolLamports) continue;
      const px = priceOf(c.virtual_quote_reserves, c.virtual_token_reserves);
      if (px < (t.peak * p.dipLowBps) / 10000 || px > (t.peak * p.dipHighBps) / 10000) continue;
      // The dip is turning: the last three observed prices rise.
      const lp = t.lastPrices;
      if (lp.length < 3 || !(lp[2] > lp[1] && lp[1] > lp[0])) continue;
      const cap = state.maxBuyLamports(mint);
      const free = state.freeCashLamports() - state.txFeeLamports();
      let stake = p.stakeLamports;
      if (stake > cap) stake = cap;
      if (stake > free) stake = free;
      if (stake <= 0n) continue;
      orders.push({ side: 'buy', mint, quote_lamports: stake, max_slippage_bps: p.buySlippageBps });
      t.entered = true;
    }

    return orders;
  }
}
