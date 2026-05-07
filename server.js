import { webcrypto } from 'node:crypto';
if (!globalThis.crypto) globalThis.crypto = webcrypto;

import express from 'express';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_TEXT_LEN = 10000;

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

  const tts = new MsEdgeTTS();
  let closed = false;
  req.on('close', () => {
    closed = true;
    try { tts.close(); } catch {}
  });

  try {
    await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    const { audioStream } = tts.toStream(trimmed, { rate: rateStr });

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Disposition', `inline; filename="read-aloud.mp3"`);

    audioStream.on('error', err => {
      console.error('tts stream error', err);
      if (!res.headersSent) res.status(500).json({ error: String(err.message || err) });
      try { tts.close(); } catch {}
    });
    audioStream.once('close', () => { try { tts.close(); } catch {} });
    audioStream.pipe(res);
  } catch (err) {
    console.error('tts setup error', err);
    if (!res.headersSent) res.status(500).json({ error: String(err.message || err) });
    try { tts.close(); } catch {}
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Read Aloud server listening on :${PORT}`);
});
