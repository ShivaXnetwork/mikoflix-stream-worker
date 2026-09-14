# ⚡ Mikoflix Ultra Edge Streaming & Playlist Proxy (Cloudflare Worker)

An ultra-fast, serverless Cloudflare Edge Worker designed for **Mikoflix Cinema Streaming**. It handles upstream stream scraping, real-time HLS `.m3u8` manifest rewriting, referer-authenticated video proxying, and direct high-bitrate MP4 partial-content (`206 Range`) streaming.

---

## 🚀 Features

- **🌐 Movie Streams Scraping Engine (`/api/movies/streams/:tmdbId`)**:
  - Dynamically extracts all working streams (`Singularity`, `Delta Hindi`, `Delta English`, `Pulsar Tamil`, `Pulsar Telugu`, `Quantum 4K`, `Magnetar HD`, `Cygnus`, `Nova`).
  - Automatically structures multi-language subtitles (`English`, `Hindi`, `Arabic`, `Spanish`, `French`, `Indonesian`, `Malay`, etc.).
- **⚡ Real-Time M3U8 Playlist Rewriter (`/api/movies/proxy/master.m3u8`)**:
  - Injects required upstream referers (`https://embed.filmu.in/`).
  - Rewrites all child playlists, segments, and `#EXT-X-KEY` URIs on the fly to route via Cloudflare's global edge network.
- **🛡️ 403 Forbidden Segment Bypass (`/api/movies/proxy/segment`)**:
  - Delivers `.ts` video chunks by stripping unwanted referer headers that cause upstream CDN blocks.
- **🚀 NetMirror MP4 Direct Streaming (`/api/movies/proxy/stream.mp4`)**:
  - Full support for `HTTP 206 Partial Content` and `Range` headers (`bytes=...`) for instant seeking without buffering.
- **🌍 Global Wildcard CORS**:
  - Seamless in-browser video playback with `Access-Control-Allow-Origin: *`.

---

## 📦 How to Push to GitHub & Deploy to Cloudflare

### Step 1: Open Terminal in this Directory
```bash
cd mikoflix-stream-worker
```

### Step 2: Initialize Git & Push to your new GitHub Repo
```bash
git init
git add .
git commit -m "Initial commit: Mikoflix Ultra Stream Worker"
git branch -M main
git remote add origin https://github.com/YOUR_GITHUB_USERNAME/YOUR_REPO_NAME.git
git push -u origin main
```

### Step 3: Deploy to Cloudflare Workers

#### Option A: 1-Command CLI Deployment (Fastest)
```bash
npm install
npx wrangler deploy
```

#### Option B: Deploy via Cloudflare Dashboard
1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com/) ➔ **Workers & Pages**.
2. Click **Create Application** ➔ **Create Worker**.
3. Link your newly pushed GitHub Repository.
4. Set Build command: `npm run deploy` (or deploy directly).

---

## 🔗 Endpoints Reference

| Endpoint | Method | Description |
| :--- | :--- | :--- |
| `GET /` | `GET` | Health status and available edge routes |
| `GET /api/movies/streams/:tmdbId` | `GET` | Get all extracted streams, servers & subtitles |
| `GET /api/movies/proxy/master.m3u8?url=...` | `GET` | HLS Master Playlist Proxy & Rewriter |
| `GET /api/movies/proxy/segment?url=...` | `GET` | Binary `.ts` video segment delivery |
| `GET /api/movies/proxy/stream.mp4?url=...` | `GET` | Direct MP4 stream with Range support |

---

## 🛠️ Connecting to Mikoflix Frontend
Once deployed, your Cloudflare Worker URL will look like:
`https://mikoflix-stream-worker.<your-subdomain>.workers.dev`

In your Mikoflix Next.js frontend `.env.local`:
```env
NEXT_PUBLIC_STREAM_WORKER_URL=https://mikoflix-stream-worker.<your-subdomain>.workers.dev
```
