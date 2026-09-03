#!/usr/bin/env python3
"""Build a single-file artifact preview of the dashboard.

Inlines css/ + js/ into one HTML fragment (no doctype/html/head/body wrapper —
the artifact host supplies those) and embeds data/rates.json as
window.EMBEDDED_RATES so the page works where external fetch is blocked.

Usage: python3 scripts/build_artifact.py [output_path]
"""
import json
import re
import sys
from pathlib import Path

root = Path(__file__).resolve().parent.parent
out = Path(sys.argv[1]) if len(sys.argv) > 1 else root / "dist" / "agile-board-preview.html"

html = (root / "index.html").read_text()

# Body content between <body> and the first script tag; head pieces we keep.
body = re.search(r"<body>(.*)</body>", html, re.S).group(1)

css = (root / "css" / "styles.css").read_text()
scripts = []
for name in ["config", "timeutil", "advisor", "api", "charts", "app"]:
    scripts.append((root / "js" / f"{name}.js").read_text())

rates = json.loads((root / "data" / "rates.json").read_text())

# Drop the external css/js references from the body copy.
body = re.sub(r'\s*<script src="js/[^"]+"></script>', "", body)

parts = [
    "<title>Agile Board</title>",
    '<link rel="preconnect" href="https://fonts.googleapis.com">',
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>',
    '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=IBM+Plex+Mono:wght@400&display=swap">',
    f"<style>\n{css}\n</style>",
    body.strip(),
    '<script src="https://cdnjs.cloudflare.com/ajax/libs/echarts/6.1.0/echarts.min.js"></script>',
    f"<script>window.EMBEDDED_RATES = {json.dumps(rates, separators=(',', ':'))};</script>",
]
for src in scripts:
    parts.append(f"<script>\n{src}\n</script>")

out.parent.mkdir(parents=True, exist_ok=True)
out.write_text("\n".join(parts) + "\n")
print(f"Wrote {out} ({out.stat().st_size // 1024} KB)")
