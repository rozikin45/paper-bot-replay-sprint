// Paper Bot for "Pump.fun Replay Sprint — Paper Bot, Real Ranking" (make.fun).
//
// Entrypoint: node main.ts (Node 22 strips the types; no build, no install).
// The bot answers each batch with the orders decided on that slot, after the
// hello handshake. Strategy lives in strategy.ts: an established-runner dip
// buyer that buys only coins aged 1000+ slots that peaked 2x, pulled back
// 15-30%, and started rising again — never a fresh launch.

import { runBot } from './vendor/makefun-bot.ts';
import { EstablishedDipBuyer } from './strategy.ts';

const bot = new EstablishedDipBuyer();

await runBot({
  onBatch(state, batch) {
    return bot.onBatch(state, batch);
  },
});
