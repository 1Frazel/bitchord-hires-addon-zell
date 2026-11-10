# Zell Private Hi-Res Vault — BitChord Addon Source

A private, zero-database, ultra-lightweight **Lossless FLAC & Hi-Res Audio Addon Source** for [BitChord](https://github.com/kushagrasinghx/BitChord), backed by **Cloudflare R2 (10 GB Free Tier)** and built for **Vercel**.

---

## ✨ Features

- **100% BitChord Addon Protocol Compliant**:
  - `GET /manifest.json` & `GET /:secret/manifest.json`
  - `GET /search?q={query}` & `GET /:secret/search?q={query}`
  - `GET /stream/{id}` & `GET /:secret/stream/{id}`
  - `GET /file/{id}` & `GET /art/{id}`
- **Private Web Management Dashboard (`/`)**:
  - **Drag-and-Drop `.flac` Binary Parser**: Automatically reads FLAC `STREAMINFO`, `VORBIS_COMMENT`, and `PICTURE` blocks in the browser in milliseconds—extracting **Title**, **Artist**, **Album**, **Exact Duration (seconds)**, **Sample Rate (Hz)**, **Bit Depth (16/24-bit)**, **ISRC**, and **Embedded Cover Art**.
  - **Direct Browser-to-R2 Uploads**: Uses S3 Presigned `PUT` URLs (with automatic CORS configuration and proxy fallback) so you can upload 30–150 MB `.flac` files directly to Cloudflare R2 without hitting Vercel's 4.5 MB serverless limit.
  - **Zero External Database**: Stores your song index as `catalog.json` inside the exact same Cloudflare R2 bucket alongside your `.flac` files, with in-memory caching for `<5ms` BitChord lookups.
  - **Built-in BitChord `TrackMatcher` Simulator**: Test any YouTube Music song title/artist in the dashboard to verify how BitChord's quality upgrade engine matches your vault tracks.

---

## 🚀 Deploying to Vercel

1. Import this repository (`1Frazel/bitchord-hires-addon-zell`) into **[Vercel](https://vercel.com/new)**.
2. In **Vercel Project Settings → Environment Variables**, add:

| Variable | Value | Description |
| :--- | :--- | :--- |
| `R2_ACCOUNT_ID` | `9320408c0a85e91646716a015a3f9b60` | *(Pre-configured by default)* |
| `R2_ENDPOINT` | `https://9320408c0a85e91646716a015a3f9b60.r2.cloudflarestorage.com` | *(Pre-configured by default)* |
| `R2_ACCESS_KEY_ID` | `your_r2_access_key_id` | From **Cloudflare Dashboard → R2 → Manage R2 API Tokens** (*Object Read & Write* or *Admin Read & Write*) |
| `R2_SECRET_ACCESS_KEY` | `your_r2_secret_access_key` | From **Cloudflare Dashboard → R2 → Manage R2 API Tokens** |
| `R2_BUCKET_NAME` | `bitchord-hires` | Your R2 bucket name (auto-detected if left blank) |
| `ADMIN_PASSWORD` | `your_strong_password` | Password for logging into the Web Dashboard (defaults to `admin123` if unset) |
| `ADDON_SECRET` | `zell-private` | Secret path slug for your private BitChord link |

3. Click **Deploy**!

*(Tip: You can also enter and test your R2 Access Key ID & Secret Access Key directly inside the **Cloudflare R2 Storage** tab of the Web Dashboard!)*

---

## 📱 Connecting to BitChord

1. Open your deployed Vercel URL (`https://your-project.vercel.app`) and log in to the Private Dashboard.
2. Upload your `.flac` songs in the **Songs Library** tab.
3. Click **Copy for BitChord** at the top of the dashboard to copy your private Manifest URL:
   ```text
   https://your-project.vercel.app/zell-private/manifest.json
   ```
4. In the **BitChord** app, go to **Settings → Sources / Addons → Add Source**, paste the URL, and save!
5. Whenever you play a song on BitChord that exists in your vault, BitChord will automatically match it and upgrade playback to your **Lossless / Hi-Res `.flac`** copy.

---

## 💻 Running Locally

```bash
npm start
# Open http://localhost:3000
```

Run the automated verification suite:
```bash
npm test
```
