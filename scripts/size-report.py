#!/usr/bin/env python3
"""APK size report.

Produces a per-category breakdown of the finished APK using MiB (1,048,576 bytes)
for engineering numbers and MB (1,000,000 bytes) alongside for readability, plus
the delta against a previous report when one is supplied.

Every number comes from the real file; nothing here is estimated. The initial
target is about 15 MiB with a 20 MiB budget, and exceeding the budget is reported
with the category breakdown instead of being hidden.
"""

from __future__ import annotations

import argparse
import json
import zipfile
from pathlib import Path

MIB = 1024 * 1024
MB = 1000 * 1000
TARGET_MIB = 15.0
BUDGET_MIB = 20.0


def category_of(name: str) -> str:
    lower = name.lower()
    if lower.startswith("classes") and lower.endswith(".dex"):
        return "dex"
    if lower == "resources.arsc" or lower.startswith("res/"):
        return "android-resources"
    if lower.startswith("lib/"):
        return "native-libs"
    if lower.startswith("meta-inf/"):
        return "signature-and-metadata"
    if lower == "androidmanifest.xml":
        return "manifest"
    if lower.startswith("assets/web/vendor/mathjax/"):
        return "mathjax-engine"
    if lower.startswith("assets/web/vendor/fonts/mathjax-newcm-font/"):
        return "mathjax-font-glyphs"
    if lower.startswith("assets/web/vendor/fonts/"):
        return "mathjax-font-extensions"
    if lower.startswith("assets/web/vendor/mermaid/"):
        return "mermaid"
    if lower.startswith("assets/web/vendor/smiles"):
        return "smiles"
    if lower.startswith("assets/web/vendor/fonts/"):
        return "fonts"
    if lower.startswith("assets/web/assets/"):
        return "web-application"
    if lower.startswith("assets/web/"):
        return "web-shell"
    if lower.startswith("assets/"):
        return "other-assets"
    return "other"


def collect(apk: Path) -> dict:
    entries = []
    with zipfile.ZipFile(apk) as archive:
        for info in archive.infolist():
            if info.is_dir():
                continue
            entries.append(
                {
                    "name": info.filename,
                    "compress": info.compress_type,
                    "compressed": info.compress_size,
                    "uncompressed": info.file_size,
                    "category": category_of(info.filename),
                }
            )
    return {"entries": entries}


def summarize(entries: list[dict]) -> dict:
    categories: dict[str, dict[str, int]] = {}
    for entry in entries:
        bucket = categories.setdefault(
            entry["category"], {"files": 0, "compressed": 0, "uncompressed": 0}
        )
        bucket["files"] += 1
        bucket["compressed"] += entry["compressed"]
        bucket["uncompressed"] += entry["uncompressed"]
    total_compressed = sum(bucket["compressed"] for bucket in categories.values())
    total_uncompressed = sum(bucket["uncompressed"] for bucket in categories.values())
    return {
        "categories": categories,
        "total_compressed": total_compressed,
        "total_uncompressed": total_uncompressed,
        "entry_count": len(entries),
    }


def render_markdown(report: dict, baseline: dict | None) -> str:
    summary = report["summary"]
    lines = [
        "# LiteDoc APK size report",
        "",
        f"- APK: `{report['apk']}`",
        f"- SHA-256: `{report['sha256']}`",
        f"- Total in APK (compressed): {summary['total_compressed'] / MIB:.2f} MiB "
        f"({summary['total_compressed'] / MB:.1f} MB)",
        f"- Total unpacked: {summary['total_uncompressed'] / MIB:.2f} MiB "
        f"({summary['total_uncompressed'] / MB:.1f} MB)",
        f"- Entries: {summary['entry_count']}",
        f"- Target: {TARGET_MIB:.2f} MiB, budget: {BUDGET_MIB:.2f} MiB",
        "",
        "| Category | Files | Compressed (MiB) | Share | Unpacked (MiB) |",
        "| --- | ---: | ---: | ---: | ---: |",
    ]
    ordered = sorted(
        summary["categories"].items(), key=lambda item: item[1]["compressed"], reverse=True
    )
    for name, bucket in ordered:
        share = bucket["compressed"] / summary["total_compressed"] * 100 if summary["total_compressed"] else 0
        lines.append(
            f"| {name} | {bucket['files']} | {bucket['compressed'] / MIB:.3f} | {share:.1f}% "
            f"| {bucket['uncompressed'] / MIB:.3f} |"
        )

    apk_bytes = report["apk_bytes"]
    lines += [
        "",
        f"- APK file size on disk: {apk_bytes / MIB:.2f} MiB ({apk_bytes / MB:.1f} MB)",
    ]
    if apk_bytes / MIB > BUDGET_MIB:
        lines.append(
            f"- **Over the {BUDGET_MIB:.0f} MiB budget.** Required offline resources are not "
            "removed to reach a number; see the breakdown above for the next optimisation step."
        )
    elif apk_bytes / MIB > TARGET_MIB:
        lines.append(f"- Above the {TARGET_MIB:.0f} MiB target, within the {BUDGET_MIB:.0f} MiB budget.")
    else:
        lines.append(f"- Within the {TARGET_MIB:.0f} MiB target.")

    if baseline:
        lines += ["", "## Delta against the previous report", ""]
        previous_total = baseline.get("apk_bytes", 0)
        lines.append(f"- Previous APK: {previous_total / MIB:.2f} MiB")
        lines.append(f"- Delta: {(apk_bytes - previous_total) / MIB:+.2f} MiB")
        previous_categories = baseline.get("summary", {}).get("categories", {})
        lines += ["", "| Category | Delta (MiB) |", "| --- | ---: |"]
        for name, bucket in ordered:
            before = previous_categories.get(name, {}).get("compressed", 0)
            lines.append(f"| {name} | {(bucket['compressed'] - before) / MIB:+.3f} |")

    biggest = [entry for entry in report["entries"] if entry["compressed"] > 64 * 1024]
    biggest.sort(key=lambda entry: entry["compressed"], reverse=True)
    lines += ["", "## Largest entries", "", "| Entry | Compressed (KiB) | Unpacked (KiB) |", "| --- | ---: | ---: |"]
    for entry in biggest[:25]:
        lines.append(
            f"| `{entry['name']}` | {entry['compressed'] / 1024:.1f} | {entry['uncompressed'] / 1024:.1f} |"
        )
    lines.append("")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apk", required=True)
    parser.add_argument("--out", default="reports/size-report.md")
    parser.add_argument("--json", default="reports/size-report.json")
    parser.add_argument("--baseline", default=None)
    args = parser.parse_args()

    apk = Path(args.apk)
    if not apk.is_file():
        raise SystemExit(f"APK not found: {apk}")

    import hashlib

    digest = hashlib.sha256(apk.read_bytes()).hexdigest()
    collected = collect(apk)
    summary = summarize(collected["entries"])
    report = {
        "apk": apk.name,
        "apk_bytes": apk.stat().st_size,
        "sha256": digest,
        "entries": collected["entries"],
        "summary": summary,
    }

    baseline = None
    if args.baseline and Path(args.baseline).is_file():
        baseline = json.loads(Path(args.baseline).read_text(encoding="utf-8"))

    Path(args.json).parent.mkdir(parents=True, exist_ok=True)
    Path(args.json).write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(render_markdown(report, baseline), encoding="utf-8")

    print(
        f"[size-report] {apk.name}: {report['apk_bytes'] / MIB:.2f} MiB "
        f"(compressed content {summary['total_compressed'] / MIB:.2f} MiB, "
        f"{summary['entry_count']} entries)"
    )
    for name, bucket in sorted(
        summary["categories"].items(), key=lambda item: item[1]["compressed"], reverse=True
    )[:8]:
        print(f"[size-report]   {name:24s} {bucket['compressed'] / MIB:8.3f} MiB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
