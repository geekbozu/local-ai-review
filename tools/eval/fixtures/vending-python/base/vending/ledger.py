# Close-of-day payouts: takings leave the machine account and land in the
# operator account, one receipt per transfer, one batch id per close.

# The floor keeps micro-charges in the machine: takings only leave once they
# reach it, so an operator is not paid in single-vend receipts.
PAYOUT_FLOOR_CENTS = 500


def pick_payouts(rows, floor_cents=PAYOUT_FLOOR_CENTS):
    return [row for row in rows if row["amount_cents"] >= floor_cents]


def summarize(payouts):
    return {"count": len(payouts), "total_cents": sum(p["amount_cents"] for p in payouts)}


def group_by_operator(payouts):
    by_operator = {}
    for payout in payouts:
        by_operator.setdefault(payout["operator_id"], []).append(payout)
    return by_operator
