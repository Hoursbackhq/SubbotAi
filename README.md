# SubBot — AI Subscription Manager That Pays for Itself

> You're paying for Claude, ChatGPT, Cursor, Copilot, Midjourney, Notion, Linear, Vercel, Railway, Supabase, Planetscale, Datadog, and fourteen other things you forgot about. SubBot finds them, audits them, and runs forever on **free GoodDollar UBI** — no credit card, no top-ups.

**Live now →**
- Web: [subbotai.xyz](https://subbotai.xyz)
- Telegram: [@SubmanagerAgentBot](https://t.me/SubmanagerAgentBot)
- SubBotCredits: [`0x4CB0d47BA5F40A5ffDc9BfF6D7810D9a887853B1`](https://celoscan.io/address/0x4CB0d47BA5F40A5ffDc9BfF6D7810D9a887853B1)
- SubBotLog: [`0x5bc06976e5b46fd624195EFdD0bFC45a73569003`](https://celoscan.io/address/0x5bc06976e5b46fd624195EFdD0bFC45a73569003)
- SubBotVault (legacy): [`0x48720eeDdCc1Cf3B2C613Dc093869a2332841e62`](https://celoscan.io/address/0x48720eeDdCc1Cf3B2C613Dc093869a2332841e62)

---

## The subscription explosion nobody talks about

It's not 2019 anymore. You don't have 3 subscriptions — you have 20.

**AI tools alone:**
Claude Pro ($20) + ChatGPT Plus ($20) + Cursor Pro ($20) + GitHub Copilot ($10) + Midjourney ($10) + Perplexity ($20) + Grok ($8) + v0 ($20) — that's **$128/month** just on AI, and most people use 2-3 of these regularly while the rest auto-renew silently.

**Developer infrastructure:**
Vercel Pro ($20) + Railway ($5-20) + Supabase Pro ($25) + Planetscale ($29) + Neon ($19) + Cloudflare Workers ($5) + Render ($7) + Datadog ($15) + Sentry ($26) — another **$170/month** on infra, half of which is running hobby projects that went cold six months ago.

**The rest:**
Netflix, Spotify, YouTube Premium, iCloud, Google One, 1Password, Notion, Linear, Figma, Canva, Grammarly, domains on three different registrars, that monitoring service you set up once...

The average developer or knowledge worker is bleeding **$300-500/month** across 15-30 subscriptions. Nobody audits them. Nobody catches the overlaps (Claude + ChatGPT + Copilot all doing code completion). Nobody cancels before the trial-to-paid conversion hits.

**SubBot does.**

---

## What SubBot actually does

SubBot is an autonomous AI agent — not a dashboard you check once and forget.

### It acts without being asked

Every morning at 9:05am, SubBot's digest agent wakes up independently. It loads every user's subscription portfolio, feeds it to the LLM, and asks: *is there anything worth telling this person today?*

If a subscription renews in 4 days — you get a message. If you crossed your budget — you get a message. If nothing is actionable — silence. **The agent decides.**

### The LLM does the reasoning, not hardcoded rules

SubBot doesn't use `if cost > threshold: alert()`. Your full portfolio — costs, renewal dates, overlaps, usage health, budget — goes to the LLM. It reasons contextually:

> *"You have Claude Pro ($20), ChatGPT Plus ($20), and GitHub Copilot ($10). All three overlap on code generation. If you're shipping code daily, keep Claude + Copilot and cancel ChatGPT Plus before June 28 — that's $240/year back. ChatGPT's web browsing is now available free."*

That's judgment, not formulas.

### Every decision is logged on Celo

Every recommendation creates an immutable transaction on Celo mainnet via `SubBotLog.sol` — action type, estimated savings, timestamp. The agent's track record lives on-chain permanently.

### Gmail scan finds everything

Connect Gmail (via the Telegram bot or web app) and SubBot scans 120 days of receipts across 50+ known billing patterns — Stripe, Apple, Google Play, PayPal, direct merchants. It catches subscriptions you forgot existed.

### Negotiation emails with real leverage

Tell SubBot to negotiate a service and it drafts a personalized retention email using your actual data — tenure length, competitor services you already pay for, historical pricing, expected discount percentage.

---

## How GoodDollar makes this free forever

[GoodDollar](https://gooddollar.org) distributes free **G$** tokens to verified members every day — universal basic income on Celo.

Most people collect G$ and don't know what to do with it. **SubBot gives G$ a job.**

Every operation costs a fraction of G$:

| Action | Cost |
|--------|------|
| View dashboard | **Free** |
| Daily digest | **Free** |
| Renewal alerts | **Free** |
| Gmail scan | 0.10 G$ |
| AI portfolio audit | 0.05 G$ |
| CSV export | 0.05 G$ |
| Negotiation email | 0.10 G$ |

**One week of daily G$ claims covers a month of full operation.** No wallet top-ups. No card on file. Just UBI doing its job — saving you hundreds on subscriptions you would have kept paying for.

### Three funding modes

| Mode | How it works |
|------|-------------|
| **G$ UBI** | Claim daily G$ → agent spends micro-amounts → runs forever from free income |
| **Vault (cUSD)** | Deposit once → Aave v3 earns yield → agent spends from yield only |
| **Pay-per-run** | No deposit needed. Bot shows cost before each action, you confirm. |

The vault integrates directly with **Aave v3 on Celo** — your cUSD deposit earns real market-rate interest from borrowers. The agent harvests yield for operations. Your principal stays locked and untouched.

---

## Login with Web3Auth

No seed phrase. No wallet extension. No Telegram ID required.

Sign in with Google, Twitter, Discord, or email. Web3Auth issues a verified JWT; SubBot validates it and creates your isolated account. GoodDollar users can sign in with the same social login they already use — zero friction.

Works natively with **MiniPay** (Opera Mini's built-in wallet). Multi-currency support (NGN, GBP, EUR, KES, GHS, ZAR → USD) — built for the users most fintech tools ignore.

---

## Architecture

```
                    ┌─────────────────────────────────┐
                    │   AUTONOMOUS AGENT LAYER          │
                    │                                   │
  9:00am daily ───► │  subscription-alerts.py           │
  9:05am daily ───► │  agent-digest.py    (LLM loop)    │
  Mon 8:00am  ───► │  llm-analyze.py     (LLM audit)   │
                    └──────────────┬───────────────────┘
                                   │ decisions + vault ops
                                   ▼
                    ┌─────────────────────────────────┐
                    │   CELO MAINNET                    │
                    │                                   │
                    │   SubBotVault.sol                 │
                    │   — G$ UBI balance (daily claims) │
                    │   — cUSD → Aave v3 yield          │
                    │   — agent spends from yield only  │
                    │                                   │
                    │   SubBotLog.sol                   │
                    │   — immutable decision log        │
                    │   — savings tracker               │
                    └─────────────────────────────────┘

User (Telegram / Web / MiniPay)
      │
      ▼
Hermes Gateway  (Hermes-4-70B · Nous inference API)
      │
      ├── llm-analyze.py      ← LLM portfolio reasoning
      ├── negotiate.py        ← LLM negotiation strategy
      ├── gmail-scanner.py    ← IMAP scan, 50+ services
      ├── export.py           ← CSV → Telegram
      ├── currency.py         ← Live FX, 6hr cache
      └── sync-to-web.py      ← Push to API bridge
           │
           ▼
      API Bridge  (Node.js · subbotai.xyz)
           │
           ├── POST /auth/verify-web3auth  ← JWKS JWT verification
           ├── POST /log-decision          ← writes to Celo contract
           ├── POST /audit                 ← triggers LLM analysis
           ├── POST /delete-sub            ← remove subscription
           ├── POST /update-sub            ← edit subscription
           ├── GET  /balance               ← G$ / cUSD balance via RPC
           └── serves public/              ← PWA dashboard
                │
                ▼
           Web Dashboard + Chrome Extension
           (Vanilla JS · Tailwind · PWA · MiniPay-ready)
```

---

## On-chain proof

**SubBotCredits** — [`0x4CB0d47BA5F40A5ffDc9BfF6D7810D9a887853B1`](https://celoscan.io/address/0x4CB0d47BA5F40A5ffDc9BfF6D7810D9a887853B1)

G$ credit system. Users deposit GoodDollar tokens, agent spends them for operations. No yield, no swaps — just deposit and spend. Users can withdraw unspent G$ at any time. `spendCredits()` reverts if balance is insufficient.

- G$ (GoodDollar) — [`0x62B8b11039fcfe5Ab0c56E502B1c372a3d2a9C14`](https://celoscan.io/address/0x62B8b11039fcfe5Ab0c56E502B1c372a3d2a9C14)
- Agent wallet — [`0xfEFAC90c384f6c09004F485b9fa894D9dA910898`](https://celoscan.io/address/0xfEFAC90c384f6c09004F485b9fa894D9dA910898)

**SubBotLog** — [`0x5bc06976e5b46fd624195EFdD0bFC45a73569003`](https://celoscan.io/address/0x5bc06976e5b46fd624195EFdD0bFC45a73569003)

Immutable decision audit trail. Every LLM recommendation creates a transaction with a privacy-preserving user hash, action type, and estimated savings.

**SubBotVault** (legacy) — [`0x48720eeDdCc1Cf3B2C613Dc093869a2332841e62`](https://celoscan.io/address/0x48720eeDdCc1Cf3B2C613Dc093869a2332841e62)

Previous yield-bearing vault (Aave v3 integration). Superseded by SubBotCredits for simpler G$ operations.

---

## Quick start

**Web app (no setup):**
1. Open [subbotai.xyz](https://subbotai.xyz)
2. Sign in with Web3Auth (Google, email, or wallet)
3. Add subscriptions with **+** or scan Gmail
4. Dashboard, Audit, and Alerts update in real time

**Telegram:**
1. Message [@SubmanagerAgentBot](https://t.me/SubmanagerAgentBot)
2. `/scan` — scan Gmail for subscriptions
3. `/audit` — LLM portfolio analysis
4. `/negotiate Netflix` — generate retention email

---

## Running locally

```bash
git clone https://github.com/Calebux/Portal-Subscription-manager
cd Portal-Subscription-manager
npm install
pip install hermes-agent && hermes setup

# Configure ~/.hermes/.env
TELEGRAM_BOT_TOKEN=your_token
OPENAI_API_KEY=your_nous_key
OPENAI_BASE_URL=https://inference-api.nousresearch.com/v1

# Configure .env
AGENT_PRIVATE_KEY=0x...
LOG_CONTRACT_ADDRESS=0x5bc06976e5b46fd624195EFdD0bFC45a73569003
VAULT_CONTRACT_ADDRESS=0x48720eeDdCc1Cf3B2C613Dc093869a2332841e62

# Start
node api-bridge.js        # Terminal 1 — API bridge
hermes gateway run        # Terminal 2 — Telegram agent
```

### Deploy to VPS

```bash
scp deploy-vps.sh root@your-server:~/
ssh root@your-server "bash ~/deploy-vps.sh"
```

---

## File reference

| File | What it does |
|------|-------------|
| `agent-digest.py` | Autonomous daily agent — LLM reviews all users, sends briefings |
| `llm-analyze.py` | LLM portfolio reasoning — contextual judgment over subscriptions |
| `negotiate.py` | LLM negotiation emails with real user leverage |
| `contracts/SubBotLog.sol` | On-chain decision audit trail (Celo) |
| `contracts/SubBotVault.sol` | G$/cUSD vault with Aave v3 yield |
| `contracts/SubBotGoodDollar.sol` | GoodDollar claim adapter |
| `subscription-alerts.py` | Renewal daemon — alerts 3 and 1 day before charges |
| `gmail-scanner.py` | IMAP scanner — 50+ billing patterns |
| `api-bridge.js` | Node.js bridge — auth, Celo logging, vault ops, serves PWA |
| `public/` | Web dashboard — PWA, light/dark theme, Web3Auth, MiniPay-ready |
| `extension/` | Chrome extension — same UI, offline-capable |
| `deploy-vps.sh` | One-command VPS deployment with systemd |

---

## License

MIT
