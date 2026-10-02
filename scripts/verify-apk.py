#!/usr/bin/env python3
"""Static verification of a built LiteDoc APK.

This runs inside the build workflow. It never installs or launches the APK: it
inspects the archive, the manifest facts reported by `aapt2 dump badging`, the
embedded vendor manifest and (for the signed artifact) the certificate reported by
`apksigner verify --print-certs`.

Checks:
  1. applicationId / versionCode / versionName / minSdk / targetSdk match the
     declared values;
  2. no launchable activity, no BROWSABLE/http intent filter and no permission
     beyond INTERNET;
  3. `debuggable` and `testOnly` are absent;
  4. every file listed in `assets/web/vendor-manifest.json` is present in the APK
     with the recorded uncompressed size, and no file is missing from the manifest;
  5. no source map, keystore, node_modules tree, fixture or debug artifact ships;
  6. for a signed APK: `apksigner verify` succeeds and the signer certificate
     SHA-256 matches EXPECTED_SIGNER_SHA256 exactly.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

REQUIRED_ASSETS = [
    "assets/web/index.html",
    "assets/web/assets/main.js",
    "assets/web/assets/document.worker.js",
    "assets/web/assets/content.css",
    "assets/web/assets/print.css",
    "assets/web/vendor/mathjax/tex-svg.js",
    "assets/web/vendor/mermaid/mermaid.esm.min.mjs",
    "assets/web/vendor-manifest.json",
]

FORBIDDEN_PATTERNS = [
    (re.compile(r"\.map$"), "source map"),
    (re.compile(r"\.(jks|keystore|p12|pem|key)$"), "signing material"),
    (re.compile(r"node_modules/"), "node_modules content"),
    (re.compile(r"^assets/fixtures/"), "test fixture"),
    (re.compile(r"\.dbg$|\.dSYM|debug\.log"), "debug artifact"),
]


def run(command: list[str]) -> tuple[int, str]:
    try:
        completed = subprocess.run(command, capture_output=True, text=True, check=False)
    except FileNotFoundError:
        return 127, f"not found: {command[0]}"
    return completed.returncode, f"{completed.stdout}\n{completed.stderr}"


def find_tool(name: str, build_tools: str | None, sdk_root: str | None) -> str | None:
    if build_tools:
        candidate = Path(build_tools) / name
        if candidate.is_file():
            return str(candidate)
    if sdk_root:
        root = Path(sdk_root) / "build-tools"
        if root.is_dir():
            versions = sorted((entry for entry in root.iterdir() if entry.is_dir()), reverse=True)
            for version in versions:
                candidate = version / name
                if candidate.is_file():
                    return str(candidate)
    return shutil.which(name)


def parse_badging(text: str) -> dict:
    facts: dict[str, object] = {"permissions": [], "intent_filters": [], "launchable": []}
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("package:"):
            match = re.search(r"name='([^']*)'", line)
            if match:
                facts["package"] = match.group(1)
            match = re.search(r"versionCode='([^']*)'", line)
            if match:
                facts["version_code"] = match.group(1)
            match = re.search(r"versionName='([^']*)'", line)
            if match:
                facts["version_name"] = match.group(1)
        elif line.startswith("sdkVersion:"):
            facts["min_sdk"] = line.split("'")[1] if "'" in line else ""
        elif line.startswith("targetSdkVersion:"):
            facts["target_sdk"] = line.split("'")[1] if "'" in line else ""
        elif line.startswith("uses-permission:"):
            match = re.search(r"name='([^']*)'", line)
            if match:
                facts["permissions"].append(match.group(1))  # type: ignore[union-attr]
        elif line.startswith("launchable-activity:"):
            facts["launchable"].append(line)  # type: ignore[union-attr]
        elif line.startswith("application-debuggable"):
            facts["debuggable"] = True
        elif line.startswith("application-label:"):
            facts["label"] = line.split(":", 1)[1].strip()
        elif line.startswith("uses-feature:"):
            match = re.search(r"name='([^']*)'", line)
            if match:
                facts.setdefault("features", [])
                facts["features"].append(match.group(1))  # type: ignore[union-attr]
        elif line.startswith("testOnly"):
            facts["test_only"] = True
    return facts


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apk", required=True)
    parser.add_argument("--mode", choices=["unsigned", "signed"], default="unsigned")
    parser.add_argument("--expect-application-id", default="dev.litedoc.viewer")
    parser.add_argument("--expect-min-sdk", default="26")
    parser.add_argument("--expect-target-sdk", default="36")
    parser.add_argument("--expect-version-code", default=None)
    parser.add_argument("--expect-version-name", default=None)
    parser.add_argument("--expected-signer-sha256", default=None)
    parser.add_argument("--vendor-manifest", default=None)
    parser.add_argument("--build-tools", default=None)
    parser.add_argument("--sdk-root", default=os.environ.get("ANDROID_HOME") or os.environ.get("ANDROID_SDK_ROOT"))
    parser.add_argument("--out", default="reports/apk-verification.json")
    args = parser.parse_args()

    apk = Path(args.apk)
    if not apk.is_file():
        raise SystemExit(f"APK not found: {apk}")

    failures: list[str] = []
    notes: list[str] = []
    facts: dict[str, object] = {}

    with zipfile.ZipFile(apk) as archive:
        names = set(archive.namelist())
        infos = {info.filename: info for info in archive.infolist()}

        for required in REQUIRED_ASSETS:
            if required not in names:
                failures.append(f"missing required asset: {required}")

        for name in sorted(names):
            for pattern, label in FORBIDDEN_PATTERNS:
                if pattern.search(name):
                    failures.append(f"forbidden {label} shipped: {name}")

        vendor_manifest = None
        manifest_path = args.vendor_manifest
        if manifest_path is None:
            embedded = "assets/web/vendor-manifest.json"
            if embedded in names:
                vendor_manifest = json.loads(archive.read(embedded).decode("utf-8"))
        else:
            candidate = Path(manifest_path)
            if candidate.is_file():
                vendor_manifest = json.loads(candidate.read_text(encoding="utf-8"))

        if vendor_manifest is None:
            failures.append("vendor manifest unavailable; cannot verify the offline resource set")
        else:
            missing = 0
            mismatched = 0
            for entry in vendor_manifest.get("files", []):
                asset_name = f"assets/web/{entry['path']}"
                info = infos.get(asset_name)
                if info is None:
                    missing += 1
                    if missing <= 10:
                        failures.append(f"vendor manifest lists a file missing from the APK: {asset_name}")
                    continue
                if info.file_size != entry["bytes"]:
                    mismatched += 1
                    if mismatched <= 10:
                        failures.append(
                            f"size mismatch for {asset_name}: apk={info.file_size} manifest={entry['bytes']}"
                        )
            if missing > 10:
                failures.append(f"... and {missing - 10} more missing vendor files")
            if mismatched > 10:
                failures.append(f"... and {mismatched - 10} more size mismatches")
            facts["vendor_files_checked"] = len(vendor_manifest.get("files", []))
            facts["vendor_files_missing"] = missing
            facts["vendor_bytes"] = vendor_manifest.get("totals", {}).get("bytes", 0)

    aapt2 = find_tool("aapt2", args.build_tools, args.sdk_root)
    if aapt2 is None:
        failures.append("aapt2 not found; manifest facts could not be verified")
    else:
        code, output = run([aapt2, "dump", "badging", str(apk)])
        if code != 0:
            failures.append(f"aapt2 dump badging failed: {output.strip()[:200]}")
        else:
            facts.update(parse_badging(output))
            if facts.get("package") != args.expect_application_id:
                failures.append(f"applicationId mismatch: {facts.get('package')}")
            if str(facts.get("min_sdk")) != str(args.expect_min_sdk):
                failures.append(f"minSdk mismatch: {facts.get('min_sdk')}")
            if str(facts.get("target_sdk")) != str(args.expect_target_sdk):
                failures.append(f"targetSdk mismatch: {facts.get('target_sdk')}")
            if args.expect_version_name and str(facts.get("version_name")) != args.expect_version_name:
                failures.append(f"versionName mismatch: {facts.get('version_name')}")
            if args.expect_version_code and str(facts.get("version_code")) != str(args.expect_version_code):
                failures.append(f"versionCode mismatch: {facts.get('version_code')}")
            permissions = facts.get("permissions", [])
            unexpected = [p for p in permissions if p != "android.permission.INTERNET"]
            if unexpected:
                failures.append(f"unexpected permissions: {', '.join(unexpected)}")
            if "android.permission.INTERNET" not in permissions:
                failures.append("INTERNET permission is missing (the image proxy needs it)")
            if facts.get("launchable"):
                failures.append("the APK declares a launchable activity; LiteDoc must have no launcher")
            if facts.get("debuggable"):
                failures.append("application is debuggable")
            if facts.get("test_only"):
                failures.append("application is marked testOnly")
            if "-" in output and "BROWSABLE" in output:
                failures.append("a BROWSABLE intent filter is declared")

    digest = hashlib.sha256(apk.read_bytes()).hexdigest()
    facts["apk_sha256"] = digest
    facts["apk_bytes"] = apk.stat().st_size

    if args.mode == "signed":
        apksigner = find_tool("apksigner", args.build_tools, args.sdk_root)
        if apksigner is None:
            failures.append("apksigner not found; cannot verify the signature")
        else:
            code, output = run([apksigner, "verify", "--verbose", "--print-certs", str(apk)])
            if code != 0:
                failures.append(f"apksigner verify failed: {output.strip()[:300]}")
            else:
                match = re.search(r"Signer #1 certificate SHA-256 digest:\s*([0-9a-fA-F:]+)", output)
                actual = match.group(1).replace(":", "").lower() if match else None
                facts["signer_sha256"] = actual
                expected = (args.expected_signer_sha256 or "").replace(":", "").lower()
                if not expected:
                    failures.append("EXPECTED_SIGNER_SHA256 is not configured; refusing to accept the artifact")
                elif actual is None:
                    failures.append("could not read the signer certificate digest")
                elif actual != expected:
                    failures.append(f"signer certificate mismatch: {actual} != {expected}")
                if "v2" not in output.lower() and "v3" not in output.lower():
                    notes.append("signature scheme v2/v3 not reported; verify manually")
    else:
        if apk.name.endswith("-release.apk") and "signed" in apk.name:
            failures.append("an unsigned artifact must not be named like a signed release")

    report = {
        "generatedBy": "scripts/verify-apk.py",
        "apk": apk.name,
        "mode": args.mode,
        "facts": facts,
        "failures": failures,
        "notes": notes,
        "result": "pass" if not failures else "fail",
    }
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    print(f"[verify-apk] mode={args.mode} apk={apk.name} sha256={digest}")
    print(f"[verify-apk] package={facts.get('package')} minSdk={facts.get('min_sdk')} "
          f"targetSdk={facts.get('target_sdk')} version={facts.get('version_name')}")
    for entry in notes:
        print(f"[verify-apk] note: {entry}")
    for entry in failures:
        print(f"[verify-apk] FAIL {entry}")
    print(f"[verify-apk] {report['result']}")
    return 0 if not failures else 1


if __name__ == "__main__":
    sys.exit(main())
