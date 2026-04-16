# Deployment Guide

The chess server is a Node.js app with a WebSocket. You need a host that:

1. Runs Node.js 18+
2. Keeps a long-lived `wss://` connection open to Otherside
3. Auto-deploys when you push to GitHub

**Do not use CodeSandbox.** They stopped accepting new repo imports on April 1, 2026.

Two good options below. Render is the better default for a chess board that you want to leave live in Otherside; Railway is faster to set up but costs a few dollars a month.

---

## Option 1 — Render (recommended, free tier works)

Render has a persistent free tier. Caveat: **the free instance spins down after 15 minutes of no inbound traffic, and takes about a minute to wake back up on the next connection.** For a chess board that people visit occasionally this is fine — the first person to approach the board in Otherside waits ~60 seconds, then it's live for everyone until idle again. If you want it always-on, upgrade to their $7/mo Starter plan.

### Steps

1. **Push the `chess-mml/` folder into your `ARCADE3` repo on GitHub.** The folder should sit alongside your other arcade projects (e.g., `ARCADE3/chess-mml/package.json`).

2. **Sign in to https://render.com** with GitHub.

3. Click **New → Web Service → Connect your GitHub repo → `jdunk4/ARCADE3`**.

4. Fill in the settings:
   - **Name:** `chess-mml` (anything — this becomes your subdomain)
   - **Region:** pick one close to you
   - **Branch:** `main`
   - **Root Directory:** `chess-mml` ← critical. Tells Render to build only this subfolder.
   - **Runtime:** `Node`
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** `Free`

5. Click **Create Web Service**. First build takes ~2 minutes.

6. When it says "Live", your URLs are:
   - Browser UI: `https://chess-mml.onrender.com/play`
   - **MML for Otherside / Vibe Maker:** `wss://chess-mml.onrender.com/mml`
   - MML Viewer preview: `https://viewer.mml.io/?url=wss://chess-mml.onrender.com/mml`

7. Paste the `wss://` URL into your Otherside MML Object (see README.md → Otherside integration).

### Optional: enable real GLB chess pieces

By default, pieces render as MML primitives (cylinders + spheres). To use the Poly Pizza CC-BY chess GLB set instead:

1. Follow the download steps in `assets/README.md` and commit the 6 GLB files to your repo.
2. In Render → **Settings** → **Environment** → **Add Environment Variable**:
   - `USE_GLB_PIECES` = `true`
   - `PUBLIC_HOST` = `<your-service>.onrender.com` (no `https://`, no trailing slash)
3. Save. Render auto-redeploys. The MML will now reference `https://<your-service>.onrender.com/assets/king.glb` etc.

If you skip this, pieces still render fine as primitives.

### Pushing updates

Every `git push` to `main` redeploys automatically. Watch the **Logs** tab on Render while it builds.

---

## Option 2 — Railway (faster, ~$5/mo)

Railway stopped offering an always-free plan. New accounts get a $5 trial credit, then it's usage-based — a small Node app typically runs $2-5/mo, which is the price to keep your chess board always-on without cold starts.

### Steps

1. Push to GitHub (same as above).

2. Go to **https://railway.app/new** and sign in with GitHub.

3. Click **Deploy from GitHub repo → `jdunk4/ARCADE3`**.

4. Railway will stage a service. Click into it, go to **Settings**:
   - **Root Directory:** `chess-mml`
   - **Start Command:** leave blank (uses `npm start` from `package.json`)

5. Go to **Settings → Networking → Generate Domain**. You'll get something like `chess-mml-production.up.railway.app`.

6. Your URLs:
   - Browser UI: `https://chess-mml-production.up.railway.app/play`
   - **MML for Otherside:** `wss://chess-mml-production.up.railway.app/mml`

### Pushing updates

Same as Render — every push to `main` redeploys.

---

## Option 3 — Run locally with ngrok (for dev only)

If you just want to test quickly without deploying:

```bash
cd chess-mml
npm install
npm start
# in another terminal:
ngrok http 8080
```

ngrok gives you a temporary `https://xxxx.ngrok.app` URL. Your MML URL is `wss://xxxx.ngrok.app/mml`. The URL dies when you close ngrok, so this is for testing only.

---

## Which one should I pick?

| Situation                                         | Pick    |
|---------------------------------------------------|---------|
| Just want to demo it to someone this week         | Render free |
| Leaving the board up permanently for the community | Render $7 Starter |
| Want fastest/least-friction setup, ok paying ~$5 | Railway |
| Just testing on my laptop                         | ngrok   |

---

## Once it's live

The `wss://` URL is what goes into:

- **Otherside Vibe Maker** — MML Object source URL
- **MML Editor** (https://mmleditor.com) — "View URL" field
- **MML Viewer** — `https://viewer.mml.io/?url=<your wss URL>`

All three will show the same board, animated in sync as moves come in from `/play`.

## Troubleshooting

**Render: first load takes 60 seconds.**
That's the free-tier cold start. Upgrade to Starter ($7/mo) to remove it.

**Render: WebSocket disconnects after 5 minutes.**
Old forum posts mention this. It was a bug in 2022, fixed since. If you see it, check their status page and file a ticket. A workaround is to have clients ping the server every 30s.

**Otherside can't load the MML.**
Must be `wss://` (not `ws://`), must be publicly accessible (both Render and Railway URLs are), and the path must be exactly `/mml`.

**Pieces don't appear in 3D.**
They should render by default as primitive chess shapes (cylinders + spheres). If they're missing entirely, confirm the MML URL is correct (`wss://...`, path `/mml`, server logs show the connection).
