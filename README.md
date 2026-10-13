# SOLRunner

Mobile-first Solana early-runner discovery dashboard.

## Current implementation
- Live candidate discovery via the public DexScreener token profile and token-pair APIs.
- Solana-only filtering.
- Default maximum pool age: 30 minutes.
- Default minimum reported pool liquidity: $20,000.
- Heuristic score sorted descending by default.
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
