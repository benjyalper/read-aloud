import { webcrypto } from 'node:crypto';
if (!globalThis.crypto) globalThis.crypto = webcrypto;

import express from 'express';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

// msedge-tts can throw after a TTS request completes if Microsoft sends
// trailing audio data for a stream we already destroyed. Don't let it kill us.
process.on('uncaughtException', err => {
  console.error('uncaughtException (kept alive):', err.message);
});
process.on('unhandledRejection', err => {
  console.error('unhandledRejection (kept alive):', err);
});

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_TEXT_LEN = 100000;
const CHUNK_SIZE = 3000;

function chunkBySentence(text, maxLen) {
  const sentences = text.replace(/\s+/g, ' ').split(/(?<=[.!?…])\s+/g).map(s => s.trim()).filter(Boolean);
  const out = [];
  let buf = '';
  for (const s of sentences) {
    if (s.length > maxLen) {
      if (buf) { out.push(buf); buf = ''; }
      const parts = s.split(/(?<=[,;:])\s+/);
      let inner = '';
      for (const p of parts) {
        if ((inner + ' ' + p).trim().length > maxLen) {
          if (inner) out.push(inner.trim());
          inner = p;
        } else {
          inner = (inner + ' ' + p).trim();
        }
      }
      if (inner) out.push(inner.trim());
      continue;
    }
    if ((buf + ' ' + s).trim().length > maxLen) {
      if (buf) out.push(buf.trim());
      buf = s;
    } else {
      buf = (buf + ' ' + s).trim();
    }
  }
  if (buf) out.push(buf.trim());
  return out;
}

app.use(express.json({ limit: '5mb' }));
app.use(express.static('.', { dotfiles: 'deny', extensions: ['html'] }));

const VOICES = [
  { id: 'en-US-AriaNeural',     name: 'Aria · US · F',        lang: 'en-US' },
  { id: 'en-US-GuyNeural',      name: 'Guy · US · M',         lang: 'en-US' },
  { id: 'en-US-AndrewNeural',   name: 'Andrew · US · M',      lang: 'en-US' },
  { id: 'en-US-EmmaNeural',     name: 'Emma · US · F',        lang: 'en-US' },
  { id: 'en-US-JennyNeural',    name: 'Jenny · US · F',       lang: 'en-US' },
  { id: 'en-US-BrianNeural',    name: 'Brian · US · M',       lang: 'en-US' },
  { id: 'en-US-ChristopherNeural', name: 'Christopher · US · M', lang: 'en-US' },
  { id: 'en-US-EricNeural',     name: 'Eric · US · M',        lang: 'en-US' },
  { id: 'en-GB-RyanNeural',     name: 'Ryan · UK · M',        lang: 'en-GB' },
  { id: 'en-GB-SoniaNeural',    name: 'Sonia · UK · F',       lang: 'en-GB' },
  { id: 'en-GB-LibbyNeural',    name: 'Libby · UK · F',       lang: 'en-GB' },
  { id: 'he-IL-HilaNeural',     name: 'הילה · Hila · IL · F', lang: 'he-IL' },
  { id: 'he-IL-AvriNeural',     name: 'אברי · Avri · IL · M', lang: 'he-IL' },
];

app.get('/api/voices', (_req, res) => {
  res.json(VOICES);
});

app.post('/api/tts', async (req, res) => {
  const { text, voice = 'en-US-AriaNeural', rate = 0 } = req.body || {};
  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'text required' });
  }
  const trimmed = text.trim();
  if (!trimmed) return res.status(400).json({ error: 'text empty' });
  if (trimmed.length > MAX_TEXT_LEN) {
    return res.status(413).json({ error: `text too long (${trimmed.length} chars; max ${MAX_TEXT_LEN}). Trim or summarize first.` });
  }
  if (!VOICES.find(v => v.id === voice)) {
    return res.status(400).json({ error: 'unknown voice' });
  }
  const ratePct = Math.max(-50, Math.min(100, Number(rate) || 0));
  const rateStr = `${ratePct >= 0 ? '+' : ''}${ratePct}%`;

  let closed = false;
  let activeTts = null;
  res.on('close', () => {
    if (!res.writableEnded) {
      closed = true;
      try { activeTts?.close(); } catch {}
    }
  });

  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Disposition', `inline; filename="read-aloud.mp3"`);

  const chunks = chunkBySentence(trimmed, CHUNK_SIZE);
  res.setHeader('X-TTS-Chunks', String(chunks.length));
  activeTts = new MsEdgeTTS();
  try {
    await activeTts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    for (let i = 0; i < chunks.length; i++) {
      if (closed) break;
      const { audioStream } = activeTts.toStream(chunks[i], { rate: rateStr });
      for await (const data of audioStream) {
        if (closed) break;
        res.write(data);
      }
    }
    try { activeTts.close(); } catch {}
    activeTts = null;
    if (!closed) res.end();
  } catch (err) {
    console.error('[tts] error', err);
    if (!res.headersSent) res.status(500).json({ error: String(err.message || err) });
    else { try { res.end(); } catch {} }
    try { activeTts?.close(); } catch {}
  }
});

/* ============================ LIBRARY (server-backed) ============================ */
const DATA_DIR = process.env.DATA_DIR || '/data';
const AUDIO_DIR = path.join(DATA_DIR, 'audio');
const INDEX_FILE = path.join(DATA_DIR, 'index.json');
const APP_PASSPHRASE = process.env.APP_PASSPHRASE || '';
const LIB_ENABLED = !!APP_PASSPHRASE;
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

let libReady = false;
async function ensureLibDirs() {
  if (libReady) return;
  await fsp.mkdir(AUDIO_DIR, { recursive: true });
  try { await fsp.access(INDEX_FILE); }
  catch { await fsp.writeFile(INDEX_FILE, JSON.stringify({ ebooks: [], tracks: [] }), 'utf8'); }
  libReady = true;
}

// Serialize index.json writes so concurrent saves can't clobber each other.
let writeChain = Promise.resolve();
function saveIndexAtomic(data) {
  writeChain = writeChain.then(async () => {
    const tmp = INDEX_FILE + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(data), 'utf8');
    await fsp.rename(tmp, INDEX_FILE);
  }).catch(err => console.error('[lib] index write failed', err));
  return writeChain;
}

function checkPass(req, res, next) {
  if (!LIB_ENABLED) return res.status(503).json({ error: 'Library not configured (APP_PASSPHRASE unset).' });
  // <audio> can't send headers, so the streaming route also accepts ?p= query.
  const pass = req.get('x-app-pass') || req.query.p || '';
  if (pass !== APP_PASSPHRASE) return res.status(401).json({ error: 'Wrong passphrase.' });
  next();
}

// Auth probe — tells the client whether the library is enabled and the pass is valid.
app.get('/api/lib/ping', (req, res) => {
  if (!LIB_ENABLED) return res.status(503).json({ enabled: false });
  const pass = req.get('x-app-pass') || '';
  res.json({ enabled: true, authed: pass === APP_PASSPHRASE });
});

// Read metadata.
app.get('/api/lib', checkPass, async (_req, res) => {
  try {
    await ensureLibDirs();
    const raw = await fsp.readFile(INDEX_FILE, 'utf8');
    res.type('application/json').send(raw);
  } catch (err) {
    console.error('[lib] read', err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

// Write metadata (titles, order, bookmarks, deletions).
app.post('/api/lib', checkPass, async (req, res) => {
  try {
    await ensureLibDirs();
    const data = req.body;
    if (!data || !Array.isArray(data.ebooks) || !Array.isArray(data.tracks)) {
      return res.status(400).json({ error: 'Invalid library payload.' });
    }
    await saveIndexAtomic(data);
    res.json({ ok: true });
  } catch (err) {
    console.error('[lib] write', err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

// Upload an MP3 (raw body). Client sends the blob with Content-Type audio/mpeg.
app.post('/api/lib/audio/:id', checkPass, express.raw({ type: ['audio/mpeg', 'application/octet-stream'], limit: '80mb' }), async (req, res) => {
  try {
    const id = req.params.id;
    if (!SAFE_ID.test(id)) return res.status(400).json({ error: 'Bad id.' });
    if (!req.body || !req.body.length) return res.status(400).json({ error: 'Empty upload.' });
    await ensureLibDirs();
    const file = path.join(AUDIO_DIR, id + '.mp3');
    await fsp.writeFile(file, req.body);
    res.json({ ok: true, size: req.body.length });
  } catch (err) {
    console.error('[lib] upload', err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

// Delete an MP3.
app.delete('/api/lib/audio/:id', checkPass, async (req, res) => {
  try {
    const id = req.params.id;
    if (!SAFE_ID.test(id)) return res.status(400).json({ error: 'Bad id.' });
    const file = path.join(AUDIO_DIR, id + '.mp3');
    await fsp.rm(file, { force: true });
    res.json({ ok: true });
  } catch (err) {
    console.error('[lib] delete', err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

// Stream an MP3 with HTTP Range support (seeking / resume).
app.get('/api/lib/audio/:id', checkPass, async (req, res) => {
  try {
    const id = req.params.id;
    if (!SAFE_ID.test(id)) return res.status(400).json({ error: 'Bad id.' });
    const file = path.join(AUDIO_DIR, id + '.mp3');
    let stat;
    try { stat = await fsp.stat(file); }
    catch { return res.status(404).json({ error: 'Not found.' }); }

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'no-store');

    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      let start = m && m[1] ? parseInt(m[1], 10) : 0;
      let end = m && m[2] ? parseInt(m[2], 10) : stat.size - 1;
      if (isNaN(start) || isNaN(end) || start > end || end >= stat.size) {
        if (start >= stat.size) {
          res.status(416).setHeader('Content-Range', `bytes */${stat.size}`);
          return res.end();
        }
        end = stat.size - 1;
      }
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
      res.setHeader('Content-Length', end - start + 1);
      fs.createReadStream(file, { start, end }).pipe(res);
    } else {
      res.setHeader('Content-Length', stat.size);
      fs.createReadStream(file).pipe(res);
    }
  } catch (err) {
    console.error('[lib] stream', err);
    if (!res.headersSent) res.status(500).json({ error: String(err.message || err) });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Read Aloud server listening on :${PORT}  (library ${LIB_ENABLED ? 'enabled' : 'disabled'})`);
});
