import { webcrypto } from 'node:crypto';
if (!globalThis.crypto) globalThis.crypto = webcrypto;

import express from 'express';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';

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
  req.on('close', () => {
    closed = true;
    try { activeTts?.close(); } catch {}
  });

  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Disposition', `inline; filename="read-aloud.mp3"`);

  const chunks = chunkBySentence(trimmed, CHUNK_SIZE);
  try {
    for (const chunk of chunks) {
      if (closed) break;
      activeTts = new MsEdgeTTS();
      try {
        await activeTts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
        const { audioStream } = activeTts.toStream(chunk, { rate: rateStr });
        await new Promise((resolve, reject) => {
          audioStream.on('data', d => { if (!closed) res.write(d); });
          audioStream.on('end', resolve);
          audioStream.on('error', reject);
          audioStream.on('close', resolve);
        });
      } finally {
        try { activeTts.close(); } catch {}
        activeTts = null;
      }
    }
    if (!closed) res.end();
  } catch (err) {
    console.error('tts error', err);
    if (!res.headersSent) res.status(500).json({ error: String(err.message || err) });
    else res.end();
    try { activeTts?.close(); } catch {}
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Read Aloud server listening on :${PORT}`);
});
