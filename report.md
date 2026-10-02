# LiteDoc release run diagnostics

- run: https://github.com/xstrsx/SuperMarkdownReader/actions/runs/37010431096
- ref: refs/tags/v0.1.0
- commit: 645d2581855f3b3476328342e2a0a2a85cfa8599
- generated: 2026-10-02T13:05:35Z

## Job results
- guard: success
- build: success
- sign: failure
- verify-signed: skipped


## size-report.md

# LiteDoc APK size report

- APK: `app-release-unsigned.apk`
- SHA-256: `5bb78f0dc20b65ce0b980d7292aa108537f9409dab31a1ce3d5e9a993ad08faa`
- Total in APK (compressed): 5.84 MiB (6.1 MB)
- Total unpacked: 18.38 MiB (19.3 MB)
- Entries: 270
- Target: 15.00 MiB, budget: 20.00 MiB

| Category | Files | Compressed (MiB) | Share | Unpacked (MiB) |
| --- | ---: | ---: | ---: | ---: |
| mathjax-font-glyphs | 40 | 2.975 | 51.0% | 9.507 |
| mermaid | 105 | 1.532 | 26.2% | 5.205 |
| mathjax-engine | 42 | 0.670 | 11.5% | 1.990 |
| dex | 1 | 0.291 | 5.0% | 0.598 |
| web-application | 47 | 0.281 | 4.8% | 0.831 |
| other-assets | 4 | 0.045 | 0.8% | 0.138 |
| android-resources | 6 | 0.017 | 0.3% | 0.023 |
| web-shell | 2 | 0.015 | 0.3% | 0.056 |
| mathjax-font-extensions | 1 | 0.005 | 0.1% | 0.013 |
| signature-and-metadata | 20 | 0.004 | 0.1% | 0.010 |
| manifest | 1 | 0.002 | 0.0% | 0.009 |
| other | 1 | 0.000 | 0.0% | 0.001 |

- APK file size on disk: 5.89 MiB (6.2 MB)
- Within the 15 MiB target.

## Largest entries

| Entry | Compressed (KiB) | Unpacked (KiB) |
| --- | ---: | ---: |
| `assets/web/vendor/mathjax/tex-svg.js` | 601.9 | 1806.3 |
| `assets/web/vendor/mermaid/chunks/mermaid.esm.min/elk-GHAXNSLK.mjs` | 494.2 | 1572.8 |
| `classes.dex` | 297.5 | 612.3 |
| `assets/web/vendor/fonts/mathjax-newcm-font/svg/dynamic/greek.js` | 280.7 | 1040.6 |
| `assets/web/vendor/fonts/mathjax-newcm-font/svg/dynamic/cyrillic.js` | 232.3 | 680.8 |
| `assets/web/vendor/fonts/mathjax-newcm-font/svg/dynamic/monospace-ex.js` | 200.2 | 609.9 |
| `assets/web/vendor/fonts/mathjax-newcm-font/svg/dynamic/sans-serif-ex.js` | 199.5 | 483.6 |
| `assets/web/vendor/mermaid/chunks/mermaid.esm.min/chunk-44AU3KAP.mjs` | 150.3 | 688.6 |
| `assets/web/vendor/mermaid/chunks/mermaid.esm.min/chunk-PKJCTQEK.mjs` | 146.4 | 459.1 |
| `assets/web/vendor/fonts/mathjax-newcm-font/svg/dynamic/PUA.js` | 141.9 | 350.4 |
| `assets/web/vendor/fonts/mathjax-newcm-font/svg/dynamic/latin-i.js` | 124.7 | 478.2 |
| `assets/web/vendor/fonts/mathjax-newcm-font/svg/dynamic/greek-ss.js` | 119.5 | 528.2 |
| `assets/web/vendor/fonts/mathjax-newcm-font/svg/dynamic/latin-bi.js` | 117.8 | 443.9 |
| `assets/web/vendor/fonts/mathjax-newcm-font/svg/dynamic/cyrillic-ss.js` | 105.6 | 285.0 |
| `assets/web/vendor/fonts/mathjax-newcm-font/svg/dynamic/monospace-l.js` | 103.6 | 379.2 |
| `assets/web/vendor/fonts/mathjax-newcm-font/svg/dynamic/phonetics.js` | 95.1 | 242.2 |
| `assets/web/vendor/fonts/mathjax-newcm-font/svg/dynamic/latin.js` | 94.8 | 350.3 |
| `assets/web/vendor/fonts/mathjax-newcm-font/svg/dynamic/sans-serif.js` | 85.6 | 208.3 |
| `assets/web/assets/main.js` | 85.1 | 284.5 |
| `assets/web/vendor/fonts/mathjax-newcm-font/svg/dynamic/arrows.js` | 80.9 | 218.9 |
| `assets/web/vendor/mermaid/chunks/mermaid.esm.min/katex-QVRI4OIV.mjs` | 76.9 | 266.2 |
| `assets/web/vendor/fonts/mathjax-newcm-font/svg/dynamic/cherokee.js` | 75.3 | 191.7 |
| `assets/web/vendor/fonts/mathjax-newcm-font/svg/dynamic/latin-b.js` | 73.4 | 292.2 |
| `assets/web/vendor/fonts/mathjax-newcm-font/svg/dynamic/sans-serif-i.js` | 71.9 | 219.8 |
| `assets/web/vendor/fonts/mathjax-newcm-font/svg/dynamic/math.js` | 69.4 | 192.5 |

## apk-verification-unsigned.json

```json
{
  "generatedBy": "scripts/verify-apk.py",
  "apk": "app-release-unsigned.apk",
  "mode": "unsigned",
  "facts": {
    "vendor_files_checked": 236,
    "vendor_files_missing": 0,
    "vendor_bytes": 18399573,
    "permissions": [
      "android.permission.INTERNET",
      "dev.litedoc.viewer.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION"
    ],
    "intent_filters": [],
    "launchable": [],
    "package": "dev.litedoc.viewer",
    "version_code": "3",
    "version_name": "0.1.0",
    "min_sdk": "26",
    "target_sdk": "36",
    "label": "'LiteDoc'",
    "features": [
      "android.software.webview",
      "android.hardware.faketouch"
    ],
    "apk_sha256": "5bb78f0dc20b65ce0b980d7292aa108537f9409dab31a1ce3d5e9a993ad08faa",
    "apk_bytes": 6173174
  },
  "failures": [],
  "notes": [
    "app-defined signature permission (expected): dev.litedoc.viewer.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION"
  ],
  "result": "pass"
}

```
