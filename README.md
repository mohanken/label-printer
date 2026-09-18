# Label Printer

A simple web app that replaces Rongta's RLabel app for the **Rongta RP425** 4-inch label printer.
It talks to the printer directly over Bluetooth, so there's nothing to install except a browser.

- **Shipping label**: pick a label PDF or screenshot (USPS, UPS, eBay, Etsy, Pirate Ship…),
  or copy one (Share → Copy) and tap **Paste a copied label**.
  The app finds the label on the page, even the top half of a letter-size sheet, turns it
  upright, and fits it to your 4×6 label at the printer's native 203 dpi.
- **Quick label**: type text, optionally add a QR code or barcode, print.
- **Printer**: label size, darkness, speed, flip, test print, feed, calibrate, diagnostics.

## Using it on iPhone

Safari on iPhone can't use Bluetooth printers, so use the free **Bluefy** browser:

1. Install [Bluefy – Web BLE Browser](https://apps.apple.com/app/bluefy-web-ble-browser/id1492822055) from the App Store.
2. Open this app's web address in Bluefy and bookmark it.
3. Close the RLabel app (the printer can only talk to one app at a time).
4. Tap **Connect printer** and choose the RP425.

Android (Chrome) and Windows/Mac (Chrome or Edge) work without Bluefy.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| Printer not in the list | Printer on (green light)? RLabel closed? Tap **Show all Bluetooth devices**. |
| Label prints upside down | Printer → tick **Flip them**. |
| Print is garbled or stops partway | Printer → Advanced → set **Bluetooth packet size** to 100, then 20. Or tick **Reliable sending**. |
| Whole label prints black (TSPL only) | Printer → Advanced → tick **Invert image bits**. |
| Nothing prints at all | Printer → Advanced → check the printer language is **ZPL (RP425)**, then **Test print**. |
| Test print shows text but no QR code | Printer → Advanced → untick **Compress images**. |
| Paste button does nothing | Press and hold the paste box that appears, then tap **Paste**. The Diagnostics log lists what the clipboard contained. |
| Label position drifts | Printer → **Learn label size**, or hold the feed button until it beeps. |

**Printer → Diagnostics log** shows what the app found and sent. Copy it if you need help.

## Development

No build step: plain HTML, CSS and ES modules. Libraries (pdf.js, JsBarcode, qrcode-generator)
are in `vendor/`.

```bash
npm start          # serves on http://localhost:8425
npm test           # encoder round-trip tests (Node 20+)
```

Open `http://localhost:8425/?mock` to use a fake printer, which is handy for testing without hardware.

| File | What it does |
| --- | --- |
| `js/app.js` | UI wiring, settings, print flow |
| `js/printer.js` | Web Bluetooth connection and chunked sending |
| `js/encoders.js` | ZPL and TSPL command generation |
| `js/raster.js` | Canvas → 1-bit bitmap, label detection |
| `js/importer.js` | PDF/image loading, auto-crop, crop editor |
| `js/designer.js` | Quick label layout (text, QR, barcode) |

The RP425 speaks **ZPL** (its manual lists "Emulation: ZPL"), so the app sends each label as a
1-bit `^GFA` graphic using Zebra's ASCII compression to keep Bluetooth transfers short. TSPL
(`BITMAP`, skipping blank areas) is kept for older Rongta models such as the RP410/RP420.
