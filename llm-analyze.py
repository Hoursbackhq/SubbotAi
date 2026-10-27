#!/usr/bin/env python3
"""
LLM-Powered Subscription Portfolio Analyzer

Replaces hardcoded health-score formulas with genuine LLM reasoning.
The model sees the full subscription context and reasons about ROI,
overlaps, and negotiation opportunities — not fixed thresholds.

Usage:
  python3 llm-analyze.py --user-id 6710506545 [--output-json]

Cron (weekly re-analysis):
  0 8 * * 1 python3 ~/.hermes/llm-analyze.py --user-id 6710506545 >> ~/.hermes/analyze.log 2>&1
"""

import json
import os
import sys
import argparse
import urllib.request
import urllib.error
from datetime import date, datetime
from pathlib import Path
from user_paths import user_path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import load_env
load_env.load_hermes_env()

API_KEY               = os.getenv("OPENAI_API_KEY", "")
API_BASE              = os.getenv("OPENAI_BASE_URL", "https://inference-api.nousresearch.com/v1")
MODEL                 = os.getenv("LLM_MODEL", "NousResearch/Hermes-3-Llama-3.1-70B")
USER_DATA_DIR         = Path(os.environ.get("DATA_DIR") or Path.home() / ".hermes") / "user-data"
BRIDGE_URL            = os.getenv("BRIDGE_URL", "http://localhost:3747")
INTERNAL_SERVICE_TOKEN = os.getenv("INTERNAL_SERVICE_TOKEN", "")


def load_subscriptions(user_id: str) -> dict:
    sub_file = user_path(USER_DATA_DIR, user_id) / "scanned-subscriptions.json"
    if sub_file.exists():
        with open(sub_file) as f:
            return json.load(f)
    return {"subscriptions": [], "monthly_budget": None}


def load_token_usage(user_id: str) -> dict | None:
    usage_file = user_path(USER_DATA_DIR, user_id) / "token-usage.json"
    if usage_file.exists():
        with open(usage_file) as f:
            return json.load(f)
    return None


def call_llm(prompt: str, system: str) -> str:
    if not API_KEY:
        raise RuntimeError("OPENAI_API_KEY not set — add it to ~/.hermes/.env")

    payload = json.dumps({
        "model": MODEL,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user",   "content": prompt},
        ],
        "temperature": 0.3,
        "max_tokens": 2000,
    }).encode()

    req = urllib.request.Request(
        f"{API_BASE}/chat/completions",
        data=payload,
        headers={
            "Authorization": f"Bearer {API_KEY}",
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read())["choices"][0]["message"]["content"]


def log_decision_onchain(user_id: str, action: str, amount_saved_usd: float):
    """Fire-and-forget: POST to api-bridge /log-decision for on-chain audit trail."""
    try:
        payload = json.dumps({
            "userId": user_id,
            "action": action,
            "amountSavedUSD": amount_saved_usd,
        }).encode()
        req = urllib.request.Request(
            f"{BRIDGE_URL}/log-decision",
            data=payload,
            headers={
                "Content-Type": "application/json",
                "X-Internal-Token": INTERNAL_SERVICE_TOKEN,
            },
        )
        urllib.request.urlopen(req, timeout=5)
    except Exception:
        pass  # non-critical — don't fail the analysis


def analyze(user_id: str) -> dict:
    today = date.today()
    data  = load_subscriptions(user_id)
    active = [s for s in data.get("subscriptions", []) if s.get("status") == "active"]

    if not active:
        return {"error": "No active subscriptions found"}

    budget      = data.get("monthly_budget")
    token_usage = load_token_usage(user_id)

    usage_context = ""
    if token_usage and token_usage.get("insights"):
        usage_context = (
            f"\n\nAPI token usage data (from provider dashboards):\n"
            f"{json.dumps(token_usage['insights'], indent=2)}"
        )

    budget_context = (
        f"\nMonthly budget set by user: ${budget}/month"
        if budget else "\nUser has not set a monthly budget."
    )

    system = (
        "You are a world-class subscription finance analyst specializing in AI/SaaS costs. "
        "You reason carefully about actual ROI for each service given this specific user's situation. "
        "You give specific, honest, actionable advice — not generic templates. "
        "You reference exact service names, costs, renewal dates, and health scores in your reasoning. "
        "Output ONLY valid JSON. No markdown fences, no explanation outside the JSON."
    )

    prompt = f"""Today is {today}. Analyze this user's full subscription portfolio.

Active subscriptions:
{json.dumps(active, indent=2)}
{budget_context}
{usage_context}

Return a JSON object with EXACTLY these fields:

{{
  "overall_health": "good|warning|critical",
  "summary": "2-3 sentences describing their situation honestly — total spend, biggest risks, one key opportunity",
  "total_monthly_usd": <number>,
  "annual_usd": <number>,
  "budget_status": "under|over|unset",
  "budget_gap_usd": <number or null — positive means over, negative means under>,
  "action_items": [
    {{
      "priority": "high|medium|low",
      "action": "cancel|negotiate|consolidate|keep|upgrade",
      "service": "<exact service name>",
      "reasoning": "<specific reasoning — reference health score, overlap, tenure, renewal date>",
      "monthly_saving_usd": <number or null>
    }}
  ],
  "overlaps": [
    {{
      "services": ["<name>", "<name>"],
      "overlap_type": "<why they overlap — same use case, same capability, redundant value>",
      "recommendation": "<which to keep and exactly why — be specific about relative value>",
      "monthly_saving_usd": <number>
    }}
  ],
  "negotiation_candidates": [
    {{
      "service": "<name>",
      "reason": "<why this service is ripe — low health score, competition exists, tenure, price increase>",
      "strategy": "<exact angle — e.g. cite Cursor as cheaper alternative, request annual plan discount>",
      "expected_discount_pct": <number>
    }}
  ],
  "forgotten_services": [
    {{
      "service": "<name>",
      "evidence": "<why it looks unused — low health score, category overlap with active tools, no activity>",
      "monthly_cost_usd": <number>
    }}
  ],
  "quick_wins": [
    "<actionable sentence with exact service, amount, and deadline — e.g. Cancel X before March 28 to avoid another $20 charge>",
    "<second quick win>"
  ]
}}

Be specific. If two services overlap, explain the actual use-case collision. If health score is low,
say what that implies about real usage. Reference renewal dates when they create urgency."""

    raw = call_llm(prompt, system).strip()

    # Strip accidental markdown fences
    if raw.startswith("```"):
        raw = raw.split("\n", 1)[1]
        raw = raw.rsplit("```", 1)[0]

    result = json.loads(raw)
    result["generated_at"] = datetime.now().isoformat()
    result["user_id"]      = user_id
    return result


def main():
    parser = argparse.ArgumentParser(description="LLM-powered subscription portfolio analyzer")
    parser.add_argument("--user-id",    required=True, help="User ID to analyze")
    parser.add_argument("--output-json", action="store_true", help="Print full JSON to stdout")
    args = parser.parse_args()

    print(f"Analyzing portfolio for user {args.user_id}...")
    analysis = analyze(args.user_id)

    if "error" in analysis:
        print(f"Error: {analysis['error']}")
        sys.exit(1)

    # Save result
    out_dir  = user_path(USER_DATA_DIR, args.user_id)
    out_dir.mkdir(parents=True, exist_ok=True)
    out_file = out_dir / "llm-analysis.json"
    with open(out_file, "w") as f:
        json.dump(analysis, f, indent=2)
    print(f"Saved → {out_file}")

    # Log high-priority cancellations on-chain
    total_saving = sum(
        a.get("monthly_saving_usd", 0) or 0
        for a in analysis.get("action_items", [])
        if a.get("priority") == "high"
    )
    if total_saving > 0:
        log_decision_onchain(args.user_id, "audit_complete", total_saving)

    if args.output_json:
        print(json.dumps(analysis, indent=2))
    else:
        print(f"Health:      {analysis.get('overall_health')}")
        print(f"Monthly:     ${analysis.get('total_monthly_usd', 0):.2f}")
        print(f"Actions:     {len(analysis.get('action_items', []))}")
        print(f"Overlaps:    {len(analysis.get('overlaps', []))}")
        print(f"Quick wins:  {len(analysis.get('quick_wins', []))}")


if __name__ == "__main__":
    main()
