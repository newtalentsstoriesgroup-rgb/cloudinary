// Live HLS scheduler: Cloudinary (storage) + Firestore (schedule) + FFmpeg (HLS)
const express = require('express');
const admin = require('firebase-admin');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// --- Config (environment variables) ---
const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || 'change-me';
const CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || '';
const UPLOAD_PRESET = process.env.CLOUDINARY_UPLOAD_PRESET || ''; // unsigned preset

// Firestore: set GOOGLE_APPLICATION_CREDENTIALS=/path/serviceAccount.json
admin.initializeApp({ credential: admin.credential.applicationDefault() });
const db = admin.firestore();
const videos = db.collection('videos');

const LIVE_DIR = path.join(__dirname, 'public', 'live');
fs.mkdirSync(LIVE_DIR, { recursive: true });

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, file) => {
    if (file.endsWith('.m3u8')) res.setHeader('Cache-Control', 'no-cache');
  },
}));

function requireAdmin(req, res, next) {
  if (req.get('x-admin-key') !== ADMIN_KEY) return res.status(401).json({ error: 'unauthorized' });
  next();
}

// --- API ---
app.get('/api/config', (req, res) => res.json({ cloudName: CLOUD_NAME, uploadPreset: UPLOAD_PRESET }));

// Add a video after it was uploaded to Cloudinary.
// playAt empty/null => play as soon as possible. Otherwise ISO date string.
app.post('/api/videos', requireAdmin, async (req, res) => {
  const { title, url, playAt } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });
  const when = playAt ? new Date(playAt) : new Date();
  const doc = await videos.add({
    title: title || 'Untitled',
    url,
    status: 'scheduled',
    playAt: admin.firestore.Timestamp.fromDate(when),
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  res.json({ id: doc.id });
});

app.get('/api/videos', requireAdmin, async (req, res) => {
  const snap = await videos.orderBy('playAt', 'desc').limit(50).get();
  res.json(snap.docs.map(d => ({ id: d.id, ...d.data(), playAt: d.data().playAt?.toDate() })));
});

app.delete('/api/videos/:id', requireAdmin, async (req, res) => {
  await videos.doc(req.params.id).delete();
  res.json({ ok: true });
});

// --- Scheduler ---
let current = null; // running ffmpeg process

async function nextVideo() {
  const snap = await videos.where('status', '==', 'scheduled').get();
  const now = Date.now();
  return snap.docs
    .filter(d => d.data().playAt.toMillis() <= now)
    .sort((a, b) => a.data().playAt.toMillis() - b.data().playAt.toMillis())[0];
}

function playVideo(doc) {
  const { url, title } = doc.data();
  console.log('Now playing:', title);
  const args = [
    '-re', '-i', url,
    '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,fps=30',
    '-c:v', 'libx264', '-preset', 'veryfast', '-g', '60', '-sc_threshold', '0',
    '-c:a', 'aac', '-ar', '44100', '-b:a', '128k',
    '-f', 'hls', '-hls_time', '4', '-hls_list_size', '6',
    // append_list + omit_endlist keep ONE continuous live playlist across videos
    '-hls_flags', 'delete_segments+append_list+omit_endlist+discont_start',
    '-hls_segment_filename', path.join(LIVE_DIR, 'seg_%d.ts'),
    path.join(LIVE_DIR, 'stream.m3u8'),
  ];
  current = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'inherit'] });
  current.on('close', async code => {
    current = null;
    await doc.ref.update({ status: code === 0 ? 'done' : 'failed' });
    console.log('Finished:', title, 'code', code);
  });
}

async function tick() {
  if (current) return;
  try {
    const doc = await nextVideo();
    if (!doc) return;
    await doc.ref.update({ status: 'playing' });
    playVideo(doc);
  } catch (e) {
    console.error('tick error', e.message);
  }
}

// On restart, reset videos stuck in "playing"
(async () => {
  const stuck = await videos.where('status', '==', 'playing').get();
  await Promise.all(stuck.docs.map(d => d.ref.update({ status: 'scheduled' })));
  setInterval(tick, 3000);
})();

app.listen(PORT, () => console.log('Server on http://localhost:' + PORT));
