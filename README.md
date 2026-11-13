# Cloudinary + Firestore + HLS Live

Admin uploads videos to Cloudinary, schedule is stored in Firestore, and the
server plays them one after another as a single live HLS stream via FFmpeg.

## Setup
1. Install FFmpeg and Node.js 18+ on your server (VPS, not serverless).
2. `npm install`
3. Cloudinary: Settings > Upload > add an **unsigned** upload preset.
4. Firebase: create a service account key (JSON), enable Firestore.
5. Environment variables:

```bash
export GOOGLE_APPLICATION_CREDENTIALS=/path/serviceAccount.json
export CLOUDINARY_CLOUD_NAME=your_cloud
export CLOUDINARY_UPLOAD_PRESET=your_unsigned_preset
export ADMIN_KEY=strong-secret
npm start
```

## Use
- Viewers: `http://SERVER:3000/`
- Admin: `http://SERVER:3000/admin.html` (upload, pick date/time or leave empty to play now)

## Firestore: collection `videos`
| field | type | note |
|---|---|---|
| title | string | |
| url | string | Cloudinary secure_url |
| status | string | scheduled / playing / done / failed |
| playAt | timestamp | when it may start |
| createdAt | timestamp | |

## Notes
- Videos play in `playAt` order; if one is still playing, the next waits.
- Put Cloudflare (or another CDN) in front of `/live` for many viewers.
- Run with pm2 or systemd so it restarts automatically.
