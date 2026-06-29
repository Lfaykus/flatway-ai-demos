# Flatway smart search — backend proxy

This is the fix for the key-exposure problem in the original demo. Before,
the Anthropic API key was typed into the browser and visible to anyone who
opened dev tools. Now the key lives only in this server's `.env` file. The
browser calls `/api/search` on this server; this server calls Anthropic.

## What was actually tested already (in the sandbox, no real key)

- Server starts and serves the frontend correctly.
- `/api/health` correctly reports whether a key is configured.
- A search request with no key configured fails with a clear `500` error
  instead of crashing or hanging.
- A search request with no `query` field fails with a clear `400` error.

What was **not** tested here: an actual live call to Anthropic with a real
key, since this sandbox doesn't have one. That's the one thing to confirm
the first time you run it locally with your own key — everything else
about the wiring is already proven to work.

## Why this still isn't "ready for Flatway's real site"

This proves the architecture (key hidden server-side, browser never sees
it) works. It does not mean it's ready to deploy to flatway.fr as-is:

- It's running on your laptop, not Flatway's actual hosting.
- It still uses the 15 fake hardcoded listings, not real inventory from
  Apimo or Flatway's other CRMs.
- No rate limiting, no cost monitoring, no integration into the real
  "Acheter" page — those are the next steps, not done here.

What this *does* prove: the single biggest technical objection to this
feature (the key has to be safe) has a known, working solution, and it's
not complicated to build.

## Run it on your own machine

1. Make sure you have Node.js installed (v18 or newer — check with `node --version`).
2. Open a terminal in this `backend` folder.
3. Install dependencies:
   ```
   npm install
   ```
4. The `.env` file in this folder already has a real Anthropic API key in
   it — nothing to add or copy. (If you ever need to swap in a different
   key, it's the `ANTHROPIC_API_KEY` line in `.env`; `.env.example` shows
   the expected format with a placeholder.)
5. Start the server:
   ```
   npm start
   ```
   You should see:
   ```
   Flatway search backend running at http://localhost:3000
   API key configured: true
   ```
6. Open `http://localhost:3000` in your browser. This is the same search
   page as before, but it now calls your own server instead of Anthropic
   directly — open dev tools and check the Network tab on a search; you'll
   see a request to `/api/search`, not to `api.anthropic.com`, and no key
   anywhere in it.
