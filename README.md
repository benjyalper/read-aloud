# Read Aloud

Personal-use TTS web app. Reads pasted text, PDFs, DOCX, and images (OCR), entirely in the browser. **Zero API costs, no backend.**

Repo: https://github.com/benjyalper/read-aloud

## Run locally

Just open `index.html` in your browser — no install needed.

Or, if you want a local dev server (matches the deployed setup):

```bash
npm install
npm run dev
```

Then visit http://localhost:3000

## Best voice quality

- **Edge on Windows** — ships Microsoft Online Neural voices (Aria, Guy, Jenny). Same quality as paid Azure neural TTS, but free here. **Recommended.**
- **Safari on Mac/iOS** — built-in Siri voices, very good.
- **Chrome on Android** — Google TTS voices, usually good.
- **Chrome on Windows** — older robotic SAPI voices. Use Edge instead.

The voice picker marks high-quality voices with ✨ and defaults to the best English voice it finds.

## Mobile notes

- iOS: tap **Play** at least once per session to unlock audio (browser autoplay policy).
- Speed > ~1.5× pitch-shifts noticeably. Pitch-preserving fast playback would require a paid TTS API.
- OCR downloads ~10 MB of WASM on first use — load on Wi-Fi.

## Deploy to Railway

Railway will auto-detect Node from `package.json` and run `npm start`, which serves the static files.

1. Push this repo to GitHub.
2. On https://railway.app — **New Project → Deploy from GitHub repo → benjyalper/read-aloud**.
3. Railway sets `PORT` automatically; the `start` script binds to it.
4. Once deployed, open the Railway-generated URL on your phone.

**Cost:** Railway no longer has an always-free tier. After the $5 trial credit, the Hobby plan is ~$5/mo minimum. A static site like this only consumes pennies of that, but it isn't $0.

### Free alternatives (recommended for $0/mo)

| Host | Setup |
|---|---|
| **Cloudflare Pages** | New project → connect repo → build command empty, output dir `/`. Free, fast, custom domain. |
| **GitHub Pages** | Repo Settings → Pages → Source: `main` branch, root. URL: `https://benjyalper.github.io/read-aloud/` |
| **Vercel** / **Netlify** | Import repo → no build settings needed. Free hobby tier. |

For any of these, the `package.json` isn't needed — they serve `index.html` directly. Keep it for Railway compatibility.

## What's inside

- `index.html` — the entire app (UI + logic, single file)
- `package.json` — only used when deploying to a Node host like Railway
- Libraries are loaded from CDN (pdf.js, mammoth, tesseract.js)

## Roadmap

- Hebrew support — auto-detect language per paragraph and switch voice
- Click any sentence to jump there
- Save session in localStorage so the doc + position persist
- (Maybe) optional paid-API mode for MP3 export
