# SOLRunner

Mobile-first Solana early-runner discovery dashboard.

## Current implementation
- Live candidate discovery across GeckoTerminal new pools, 5m/1h trending pools and high-activity pools, enriched with public DexScreener profile, boost, search and pair APIs.
- Solana-only filtering, with no maximum pool-age cutoff; older pools can qualify when current activity and liquidity support them.
- Minimum reported pool liquidity: $20,000.
- Heuristic organic-momentum score sorted descending by default. Scoring penalizes extreme turnover relative to liquidity, near one-sided flow, and weak unique-buyer breadth when that data is available.
- Organic status (STRONG SIGNAL / WATCH / FLAGGED / INSUFFICIENT DATA) is separate from RugCheck security status. Only STRONG SIGNAL candidates with a fresh RugCheck NO_MAJOR_FLAGS result and no market-pattern flag enter the verified strong shortlist. HIGH_RISK, CAUTION, and unavailable reports remain separately visible.
- Token logos accept only HTTP(S) URLs. GeckoTerminal is checked first, with one rate-limited metadata lookup per refresh, followed by a rotating batch of up to eight DexScreener lookups and Jupiter fallbacks. Positive and negative results are cached to improve coverage without repeatedly hitting provider limits.
- See the app's Telemetry view for provider health, pipeline counts and token-logo coverage.
- Manual review only. No wallet connection, private keys, or trade execution.
- Server-side proxy and short cache to avoid exposing provider calls in the browser.

## Important limitations
The score is a market-activity heuristic, not a prediction or probability of profit. The public DexScreener feed does not provide verified smart-money attribution, holder distribution, or a complete security audit. Those fields must not be inferred from this score. A pool's reported liquidity does not guarantee exit liquidity.

## Run locally
```bash
npm install
npm start
```
Open http://localhost:3000.

## Deploy to Northflank
Create a service from this GitHub repository using the Dockerfile. Expose port 3000 and set `PORT=3000` if required. No API keys are needed for the current public feed integration.
