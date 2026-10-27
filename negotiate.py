#!/usr/bin/env python3
"""
LLM-Powered Negotiation Email Generator

Replaces the generic template in api-bridge.js with a fully reasoned,
personalized retention email. The LLM analyzes the user's specific
situation — tenure, health score, overlap, budget pressure — and crafts
an email that reflects their real leverage.

Usage:
  python3 negotiate.py --user-id 6710506545 --service "ChatGPT Plus"

Output: JSON with { to, subject, body, strategy_used }
"""

import json
import os
import sys
import argparse
import urllib.request
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


def load_user_context(user_id: str) -> tuple[dict, dict | None]:
    """Returns (subscriptions_data, llm_analysis_or_None)"""
    sub_file = user_path(USER_DATA_DIR, user_id) / "scanned-subscriptions.json"
    data     = {}
    if sub_file.exists():
        with open(sub_file) as f:
            data = json.load(f)

    analysis = None
    analysis_file = user_path(USER_DATA_DIR, user_id) / "llm-analysis.json"
    if analysis_file.exists():
        with open(analysis_file) as f:
            analysis = json.load(f)

    return data, analysis


def call_llm(prompt: str, system: str) -> str:
    if not API_KEY:
        raise RuntimeError("OPENAI_API_KEY not set")

    payload = json.dumps({
        "model": MODEL,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user",   "content": prompt},
        ],
        "temperature": 0.5,
        "max_tokens": 800,
    }).encode()

    req = urllib.request.Request(
        f"{API_BASE}/chat/completions",
        data=payload,
        headers={
            "Authorization": f"Bearer {API_KEY}",
            "Content-Type":  "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=45) as resp:
        return json.loads(resp.read())["choices"][0]["message"]["content"]


def log_decision(user_id: str, amount_saved: float):
    try:
        payload = json.dumps({
            "userId":          user_id,
            "action":          "recommend_negotiate",
            "amountSavedUSD":  amount_saved,
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
        pass


def generate_negotiation_email(user_id: str, service_name: str) -> dict:
    today = date.today()
    data, analysis = load_user_context(user_id)

    subs   = data.get("subscriptions", [])
    budget = data.get("monthly_budget")

    # Find this service
    target = next(
        (s for s in subs if s.get("name", "").lower() == service_name.lower()),
        None
    )

    # Find overlapping services from analysis
    overlaps = []
    if analysis:
        for o in analysis.get("overlaps", []):
            if any(s.lower() == service_name.lower() for s in o["services"]):
                competitors = [s for s in o["services"] if s.lower() != service_name.lower()]
                overlaps.extend(competitors)

    # Find negotiation strategy from analysis
    candidate = None
    if analysis:
        candidate = next(
            (c for c in analysis.get("negotiation_candidates", [])
             if c.get("service", "").lower() == service_name.lower()),
            None
        )

    # All active subs for context (cost pressure)
    active = [s for s in subs if s.get("status") == "active"]
    total_monthly = sum(s.get("monthly_cost_usd") or s.get("monthly_cost", 0) for s in active)

    context = {
        "today": str(today),
        "target_service": target or {"name": service_name},
        "overlapping_services_user_has": overlaps,
        "known_strategy": candidate.get("strategy") if candidate else None,
        "expected_discount_pct": candidate.get("expected_discount_pct", 20) if candidate else 20,
        "user_total_monthly_usd": round(total_monthly, 2),
        "user_monthly_budget": budget,
        "other_active_subscriptions": [s["name"] for s in active if s.get("name", "").lower() != service_name.lower()],
    }

    system = (
        "You are an expert at writing retention/negotiation emails that actually get results. "
        "You write personalized, specific emails — not templates. "
        "The user has real leverage and you use it precisely. "
        "Output ONLY valid JSON. No markdown, no explanation outside the JSON."
    )

    prompt = f"""Write a negotiation/retention email for this user to send to {service_name}'s support team.

User context:
{json.dumps(context, indent=2)}

Rules:
- Reference specific details: how long they've been subscribed, their health score if low, a named competitor if present
- Make a concrete ask: specific % discount, annual plan, or pause option — not a vague "any deals?"
- Tone must match the service: formal for enterprise tools, casual for consumer apps
- Do NOT use filler phrases like "I hope this finds you well"
- Keep it under 150 words — brevity signals confidence
- The email should feel written by a real person, not a bot

Return JSON with exactly:
{{
  "to": "<support email — research the right one>",
  "subject": "<specific subject line, not generic>",
  "body": "<the full email body>",
  "strategy_used": "<one sentence explaining the leverage angle used>",
  "estimated_discount_pct": <number>
}}"""

    raw = call_llm(prompt, system).strip()

    # Strip accidental markdown
    if raw.startswith("```"):
        raw = raw.split("\n", 1)[1]
        raw = raw.rsplit("```", 1)[0]

    result = json.loads(raw)
    result["service"]      = service_name
    result["generated_at"] = datetime.now().isoformat()
    return result


def main():
    parser = argparse.ArgumentParser(description="LLM-powered negotiation email generator")
    parser.add_argument("--user-id",  required=True, help="User ID to load context for")
    parser.add_argument("--service",  required=True, help="Service name to negotiate for")
    args = parser.parse_args()

    if not API_KEY:
        print("Error: OPENAI_API_KEY not set")
        sys.exit(1)

    print(f"Generating negotiation email for {args.service}...")
    result = generate_negotiation_email(args.user_id, args.service)

    # Output JSON for api-bridge.js to capture
    print(json.dumps(result))

    # Log the negotiation recommendation on-chain
    discount = result.get("estimated_discount_pct", 20)
    # Estimate: apply expected discount to monthly cost (rough saving)
    data, _ = load_user_context(args.user_id)
    subs     = data.get("subscriptions", [])
    target   = next(
        (s for s in subs if s.get("name", "").lower() == args.service.lower()), {}
    )
    monthly_cost   = target.get("monthly_cost_usd") or target.get("monthly_cost", 0)
    estimated_saving = round(monthly_cost * discount / 100, 2)
    log_decision(args.user_id, estimated_saving)


if __name__ == "__main__":
    main()
