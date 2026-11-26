# Shelf labels: one line of text per slot, one print job per line, printed from
# the same supplier feed the restock plan is built from.

import asyncio
import subprocess


def render_label(slot, product_id, price_cents):
    return f"{slot}  {product_id}  {price_cents / 100:.2f}"


def print_labels(feed, printer="labels"):
    for item in feed["items"]:
        label = render_label(item["slot"], item["product_id"], item["unit_cents"])
        subprocess.run(f"lp -d {printer} {label}", shell=True, check=True)
    return len(feed["items"])


# The slot map is fetched once per machine and cached by the caller; the labels
# are printed from whatever arrives first.
async def prewarm_labels(machine_ids, fetch):
    for machine_id in machine_ids:
        asyncio.create_task(fetch(machine_id))
