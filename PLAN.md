# Read-Aloud — Plan

Personal-use TTS web app. Reads pasted text, PDFs, DOCX, and images (OCR). English first, Hebrew later. **Zero API costs.**

## Architecture: 100% browser, no backend

Everything runs client-side. No server, no API keys, no usage bills. Open the page, drop a file, hear it.

| Concern | Library | Cost | Notes |
|---|---|---|---|
| TTS | Web Speech API (`speechSynthesis`) | free | Built into the browser |
| PDF text | pdf.js | free | Extracts text layer |
| DOCX | mammoth.js | free | DOCX → plain text |
| OCR | Tesseract.js | free | English works well; Hebrew is OK |
| Lang detect | franc-min | free | Routes chunks to EN vs HE voice (v2) |
| UI | Vanilla HTML + a tiny bit of JS, or Vite + React if it grows | free | |

## Voice quality on the free path

Web Speech API quality depends on the browser:

- **Edge on Windows** ships **Microsoft Online Neural voices** (Aria, Guy, Jenny, etc.) through `speechSynthesis`. These are the *same* neural voices Azure charges $16/M chars for — free here. **This is the recommended browser.**
- **Chrome on Windows** uses the older SAPI voices (David, Zira) — robotic.
- **Safari on Mac** uses Apple voices (Samantha, Alex) — pretty good.
- **Firefox** — limited.

Hebrew: Edge has `he-IL-HilaNeural` (online) — free, decent quality. Good enough for v2.

**Tradeoff vs paid APIs:** can't easily export the audio as an MP3 file — Web Speech speaks through the speakers and doesn't expose the audio buffer. For "read this to me" that's fine. If exporting MP3s becomes a need later, we add a paid TTS API or a local Piper/Coqui server.

## Features (v1, English only)

1. **Input methods**
   - Paste/type text
   - Drop a PDF → text layer extracted
   - Drop a DOCX → text extracted
   - Drop an image (PNG/JPG) → OCR
   - Drop a scanned PDF → render pages to canvas → OCR
2. **Player**
   - Play / pause / stop
   - Speed slider 0.5×–2× (`utterance.rate`)
   - Pitch slider (optional, free)
   - Voice picker (lists all browser voices, defaults to best English neural)
   - Progress indicator (current sentence highlighted)
3. **Long docs**
   - Chunk into sentences, queue them
   - Resume from where you stopped

## Features (v2, later)

- Hebrew support: language detect per paragraph, switch voice automatically
- Per-paragraph play (click any paragraph to jump there)
- Save session (localStorage) — remembers the doc + position
- Export as MP3 (would need a paid API or local model — flag costs at that point)

## File layout

```
read-aloud/
  index.html          # single-page app
  src/
    main.js           # entry, wires everything up
    tts.js            # Web Speech API wrapper
    parsers/
      pdf.js          # pdf.js integration
      docx.js         # mammoth integration
      ocr.js          # Tesseract.js integration
    ui/
      player.js       # play/pause/speed UI
      uploader.js     # drop zone
  vendor/             # pdf.js, mammoth, tesseract (or via CDN)
  PLAN.md             # this file
  README.md
```

Could start as one HTML file + CDN scripts for fastest iteration, refactor if it grows. Recommend that.

## Deployment

- Local: open `index.html` in Edge. Done.
- Optional: GitHub Pages, Vercel, Netlify — all free for a static site.

## Cost summary

**$0/month.** No API keys, no quotas, no surprises. Only a paid path if you later want MP3 export or a custom cloned voice.

## Open questions before I scaffold

1. Want it as a **single HTML file** (fastest, hackable) or a **proper Vite project** (cleaner if it grows)? My pick: single HTML file for v1.
2. Folder name `read-aloud` OK, or want something else?
3. Anything you'd cut from v1 to ship faster — e.g., skip OCR initially and add it once text+PDF+DOCX work?
