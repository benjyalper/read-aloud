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

// msedge-tts drops the text into SSML without escaping, so a raw & or <
// produces invalid XML and Edge returns ZERO audio (a silent 0-byte file).
// Escape the XML-significant characters before synthesis.
function escapeForSsml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

app.use(express.json({ limit: '30mb' }));
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
      const { audioStream } = activeTts.toStream(escapeForSsml(chunks[i]), { rate: rateStr });
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
const COVER_DIR = path.join(DATA_DIR, 'covers');
const CAPTIONS_DIR = path.join(DATA_DIR, 'captions');
const JOBS_DIR = path.join(DATA_DIR, 'jobs');
const INDEX_FILE = path.join(DATA_DIR, 'index.json');
const APP_PASSPHRASE = process.env.APP_PASSPHRASE || '';
const LIB_ENABLED = !!APP_PASSPHRASE;
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

let libReady = false;
async function ensureLibDirs() {
  if (libReady) return;
  await fsp.mkdir(AUDIO_DIR, { recursive: true });
  await fsp.mkdir(COVER_DIR, { recursive: true });
  await fsp.mkdir(CAPTIONS_DIR, { recursive: true });
  await fsp.mkdir(JOBS_DIR, { recursive: true });
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

// Upload an MP3 (raw body). Accept any content type so an unexpected
// Content-Type can never cause a silent "empty upload" rejection.
app.post('/api/lib/audio/:id', checkPass, express.raw({ type: () => true, limit: '80mb' }), async (req, res) => {
  try {
    const id = req.params.id;
    if (!SAFE_ID.test(id)) { console.warn('[lib] upload bad id', JSON.stringify(id)); return res.status(400).json({ error: 'Bad id.' }); }
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
    await fsp.rm(path.join(AUDIO_DIR, id + '.mp3'), { force: true });
    await fsp.rm(path.join(CAPTIONS_DIR, id + '.json'), { force: true });
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
    if (!SAFE_ID.test(id)) { console.warn('[lib] stream bad id', JSON.stringify(id)); return res.status(400).json({ error: 'Bad id.' }); }
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

// Caption/timing sidecar for a recording (word-level timings, if generated with captions).
app.get('/api/lib/captions/:id', checkPass, async (req, res) => {
  try {
    const id = req.params.id;
    if (!SAFE_ID.test(id)) return res.status(400).json({ error: 'Bad id.' });
    let raw;
    try { raw = await fsp.readFile(path.join(CAPTIONS_DIR, id + '.json'), 'utf8'); }
    catch { return res.status(404).json({ error: 'Not found.' }); }
    res.setHeader('Cache-Control', 'no-store');
    res.type('application/json').send(raw);
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: String(err.message || err) });
  }
});

// Upload a cover image (raw body, any content-type; client sends a small JPEG/PNG).
app.post('/api/lib/cover/:id', checkPass, express.raw({ type: () => true, limit: '8mb' }), async (req, res) => {
  try {
    const id = req.params.id;
    if (!SAFE_ID.test(id)) { console.warn('[lib] cover bad id', JSON.stringify(id)); return res.status(400).json({ error: 'Bad id.' }); }
    if (!req.body || !req.body.length) return res.status(400).json({ error: 'Empty upload.' });
    await ensureLibDirs();
    await fsp.writeFile(path.join(COVER_DIR, id + '.img'), req.body);
    res.json({ ok: true, size: req.body.length });
  } catch (err) {
    console.error('[lib] cover upload', err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

// Delete a cover image.
app.delete('/api/lib/cover/:id', checkPass, async (req, res) => {
  try {
    const id = req.params.id;
    if (!SAFE_ID.test(id)) return res.status(400).json({ error: 'Bad id.' });
    await fsp.rm(path.join(COVER_DIR, id + '.img'), { force: true });
    res.json({ ok: true });
  } catch (err) {
    console.error('[lib] cover delete', err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

// Stream a cover image (content-type sniffed from magic bytes).
app.get('/api/lib/cover/:id', checkPass, async (req, res) => {
  try {
    const id = req.params.id;
    if (!SAFE_ID.test(id)) return res.status(400).json({ error: 'Bad id.' });
    const file = path.join(COVER_DIR, id + '.img');
    let buf;
    try { buf = await fsp.readFile(file); }
    catch { return res.status(404).json({ error: 'Not found.' }); }
    const isPng = buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50;
    res.setHeader('Content-Type', isPng ? 'image/png' : 'image/jpeg');
    res.setHeader('Cache-Control', 'no-store');
    res.send(buf);
  } catch (err) {
    console.error('[lib] cover stream', err);
    if (!res.headersSent) res.status(500).json({ error: String(err.message || err) });
  }
});

/* ===================== Background generation jobs ===================== */
// The browser hands us the parts' text and walks away. The server generates
// every MP3 (using its own always-on internet) and drops them straight into
// the library, so the user's device is free to disconnect in between.
const randomId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

// Synthesize an entire part to a single MP3 Buffer, capturing word-level
// timings for captions. Returns { buffer, captions: [[absMs, word], ...] }.
// Note: Edge sends WordBoundary metadata but the library only ends the AUDIO
// stream on turn-end (not the metadata one), so we collect via a 'data'
// listener and never await the metadata stream's end.
const TICKS_PER_MS = 10000;
const MP3_BYTES_PER_SEC = 6000; // 48 kbps CBR -> 6000 bytes/sec, for chunk offset math
async function generateMp3Buffer(text, voice, ratePct) {
  const rateStr = `${ratePct >= 0 ? '+' : ''}${ratePct}%`;
  const chunks = chunkBySentence(String(text || '').trim(), CHUNK_SIZE);
  const tts = new MsEdgeTTS();
  await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3, { wordBoundaryEnabled: true });
  const bufs = [];
  const words = []; // [absMs, word]
  let baseMs = 0;    // cumulative audio time of chunks already written
  try {
    for (const ch of chunks) {
      const { audioStream, metadataStream } = tts.toStream(escapeForSsml(ch), { rate: rateStr });
      const chunkWords = [];
      if (metadataStream) {
        metadataStream.on('data', (c) => {
          try {
            const obj = JSON.parse(c.toString());
            for (const m of (obj.Metadata || [])) {
              if (m.Type === 'WordBoundary' && m.Data) {
                const w = (m.Data.text && m.Data.text.Text) || '';
                if (w) chunkWords.push([m.Data.Offset / TICKS_PER_MS, w]);
              }
            }
          } catch {}
        });
      }
      let chunkBytes = 0;
      for await (const data of audioStream) { bufs.push(data); chunkBytes += data.length; }
      await new Promise(r => setImmediate(r)); // flush buffered metadata 'data' events
      for (const [offMs, w] of chunkWords) words.push([Math.round(baseMs + offMs), w]);
      baseMs += (chunkBytes / MP3_BYTES_PER_SEC) * 1000;
    }
  } finally { try { tts.close(); } catch {} }
  return { buffer: Buffer.concat(bufs), captions: words };
}

// Serialized read-modify-write of index.json (shares writeChain with saves).
function mutateIndex(fn) {
  writeChain = writeChain.then(async () => {
    let data;
    try { data = JSON.parse(await fsp.readFile(INDEX_FILE, 'utf8')); }
    catch { data = { ebooks: [], tracks: [] }; }
    await fn(data);
    const tmp = INDEX_FILE + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(data), 'utf8');
    await fsp.rename(tmp, INDEX_FILE);
  }).catch(err => console.error('[lib] mutateIndex failed', err));
  return writeChain;
}

const jobs = {};
function jobSummary(j) {
  return {
    id: j.id, ebookId: j.ebookId, title: j.title, status: j.status,
    total: j.parts.length, done: j.done.length, failed: j.failed,
    currentLabel: j.currentLabel || '', error: j.error || '', updatedAt: j.updatedAt,
  };
}
async function persistJob(job) {
  job.updatedAt = Date.now();
  try { await fsp.writeFile(path.join(JOBS_DIR, job.id + '.json'), JSON.stringify(job), 'utf8'); } catch {}
}
async function removeJobFile(id) { try { await fsp.rm(path.join(JOBS_DIR, id + '.json'), { force: true }); } catch {} }

async function runJob(job) {
  job.status = 'running';
  await persistJob(job);
  for (; job.cursor < job.parts.length; job.cursor++) {
    if (job.cancelled) { job.status = 'cancelled'; job.currentLabel = ''; await persistJob(job); return; }
    const p = job.parts[job.cursor];
    job.currentLabel = p.label || p.filename || `part ${job.cursor + 1}`;
    await persistJob(job);
    try {
      const { buffer: buf, captions } = await generateMp3Buffer(p.text, job.voice, job.rate);
      if (!buf.length) { job.failed.push(job.currentLabel + ' (empty)'); continue; }
      const tid = randomId();
      await fsp.writeFile(path.join(AUDIO_DIR, tid + '.mp3'), buf);
      let hasCaptions = false;
      if (captions && captions.length) {
        try { await fsp.writeFile(path.join(CAPTIONS_DIR, tid + '.json'), JSON.stringify({ v: 1, words: captions })); hasCaptions = true; } catch {}
      }
      await mutateIndex(d => {
        d.tracks.push({
          id: tid, ebookId: job.ebookId, filename: p.filename || (job.currentLabel + '.mp3'),
          fromPage: p.fromPage ?? null, toPage: p.toPage ?? null, chapter: p.chapter || null,
          label: p.label || p.filename || job.currentLabel, sizeBytes: buf.length, hasCaptions, addedAt: Date.now(),
        });
        const eb = d.ebooks.find(e => e.id === job.ebookId);
        if (eb) eb.updatedAt = Date.now();
      });
      job.done.push(p.filename || job.currentLabel);
    } catch (err) {
      console.error('[job] part failed', err.message);
      job.failed.push(job.currentLabel + ': ' + (err.message || err));
    }
    await persistJob(job);
  }
  job.status = 'done';
  job.currentLabel = '';
  await persistJob(job);
}

async function loadJobsOnStartup() {
  try {
    await fsp.mkdir(JOBS_DIR, { recursive: true });
    const files = await fsp.readdir(JOBS_DIR);
    const cutoff = Date.now() - 24 * 3600 * 1000;
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      let j;
      try { j = JSON.parse(await fsp.readFile(path.join(JOBS_DIR, f), 'utf8')); } catch { continue; }
      // Drop stale finished jobs; resume interrupted ones.
      if ((j.status === 'done' || j.status === 'cancelled') && (j.updatedAt || 0) < cutoff) { await removeJobFile(j.id); continue; }
      jobs[j.id] = j;
      if (j.status === 'running' || j.status === 'queued') { j.cancelled = false; runJob(j).catch(e => { j.status = 'error'; j.error = String(e.message || e); persistJob(j); }); }
    }
  } catch (err) { console.error('[job] startup load failed', err); }
}

function jobsActive() { return Object.values(jobs).some(j => j.status === 'running' || j.status === 'queued'); }

// Find audio/cover files on the volume that no library entry references.
async function scanOrphans() {
  await ensureLibDirs();
  let index;
  try { index = JSON.parse(await fsp.readFile(INDEX_FILE, 'utf8')); }
  catch { index = { ebooks: [], tracks: [] }; }
  const trackIds = new Set((index.tracks || []).map(t => t.id));
  const ebookIds = new Set((index.ebooks || []).map(e => e.id));
  const orphans = [];
  let bytes = 0;
  const sweep = async (dir, ext, refSet) => {
    let files = [];
    try { files = await fsp.readdir(dir); } catch { return; }
    for (const f of files) {
      if (!f.endsWith(ext)) continue;
      const id = f.slice(0, -ext.length);
      if (refSet.has(id)) continue;
      let sz = 0;
      try { sz = (await fsp.stat(path.join(dir, f))).size; } catch {}
      orphans.push({ dir, file: f, bytes: sz });
      bytes += sz;
    }
  };
  await sweep(AUDIO_DIR, '.mp3', trackIds);
  await sweep(COVER_DIR, '.img', ebookIds);
  await sweep(CAPTIONS_DIR, '.json', trackIds);
  return { orphans, bytes };
}

// Preview orphaned files (dry run).
app.get('/api/lib/cleanup', checkPass, async (_req, res) => {
  try {
    const { orphans, bytes } = await scanOrphans();
    res.json({
      count: orphans.length, bytes,
      audio: orphans.filter(o => o.dir === AUDIO_DIR).length,
      covers: orphans.filter(o => o.dir === COVER_DIR).length,
      captions: orphans.filter(o => o.dir === CAPTIONS_DIR).length,
    });
  } catch (err) { res.status(500).json({ error: String(err.message || err) }); }
});

// Delete orphaned files.
app.post('/api/lib/cleanup', checkPass, async (_req, res) => {
  try {
    if (jobsActive()) return res.status(409).json({ error: 'Generation in progress — try again once jobs finish.' });
    const { orphans, bytes } = await scanOrphans();
    let deleted = 0;
    for (const o of orphans) {
      try { await fsp.rm(path.join(o.dir, o.file), { force: true }); deleted++; } catch {}
    }
    res.json({ deleted, bytes });
  } catch (err) { res.status(500).json({ error: String(err.message || err) }); }
});

// Create a background generation job.
app.post('/api/lib/jobs', checkPass, async (req, res) => {
  try {
    const { ebookId, title, voice, rate = 0, parts } = req.body || {};
    if (!Array.isArray(parts) || !parts.length) return res.status(400).json({ error: 'No parts.' });
    if (!VOICES.find(v => v.id === voice)) return res.status(400).json({ error: 'Unknown voice.' });
    await ensureLibDirs();
    let ebId = ebookId;
    if (ebId) {
      if (!SAFE_ID.test(ebId)) return res.status(400).json({ error: 'Bad ebook id.' });
    } else {
      ebId = randomId();
      await mutateIndex(d => { d.ebooks.push({ id: ebId, title: (title || 'Generated audiobook').slice(0, 200), createdAt: Date.now(), updatedAt: Date.now() }); });
    }
    const ratePct = Math.max(-50, Math.min(100, Math.round(Number(rate) || 0)));
    const job = { id: randomId(), ebookId: ebId, title: title || '', voice, rate: ratePct, parts, done: [], failed: [], cursor: 0, status: 'queued', cancelled: false, createdAt: Date.now() };
    jobs[job.id] = job;
    await persistJob(job);
    runJob(job).catch(e => { job.status = 'error'; job.error = String(e.message || e); persistJob(job); });
    res.json({ jobId: job.id, ebookId: ebId, total: parts.length });
  } catch (err) {
    console.error('[job] create', err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.get('/api/lib/jobs', checkPass, (_req, res) => {
  res.json(Object.values(jobs).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).map(jobSummary));
});
app.get('/api/lib/jobs/:id', checkPass, (req, res) => {
  const j = jobs[req.params.id];
  if (!j) return res.status(404).json({ error: 'Not found.' });
  res.json(jobSummary(j));
});
// Cancel a running job, or dismiss a finished one.
app.delete('/api/lib/jobs/:id', checkPass, async (req, res) => {
  const j = jobs[req.params.id];
  if (j) {
    if (j.status === 'running' || j.status === 'queued') j.cancelled = true;
    else { delete jobs[j.id]; await removeJobFile(j.id); }
  }
  res.json({ ok: true });
});

// Resume a stopped/errored job from where it left off.
app.post('/api/lib/jobs/:id/resume', checkPass, (req, res) => {
  const j = jobs[req.params.id];
  if (!j) return res.status(404).json({ error: 'Not found.' });
  if (j.status === 'running' || j.status === 'queued') return res.json({ ok: true });
  if (j.cursor >= j.parts.length) return res.json({ ok: true, done: true });
  j.cancelled = false;
  j.error = '';
  runJob(j).catch(e => { j.status = 'error'; j.error = String(e.message || e); persistJob(j); });
  res.json({ ok: true });
});

app.listen(PORT, '0.0.0.0', () => {
  loadJobsOnStartup();
  console.log(`Read Aloud server listening on :${PORT}  (library ${LIB_ENABLED ? 'enabled' : 'disabled'})`);
});
