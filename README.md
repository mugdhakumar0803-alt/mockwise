# Mock Interview Room

Upload resume, paste job description, choose interview type and interviewer vibe, then answer spoken questions. A scored report comes at the end.

## Run it
1. Install Node 18 or newer.
2. In this folder: `npm install`
3. Copy `.env.example` to `.env` and fill in:
   - `ANTHROPIC_API_KEY` (writes questions and the report)
   - `FISH_API_KEY` (interviewer voice + transcribing your answers)
   - `FISH_VOICE_DEFAULT` (a voice ID from fish.audio; the ID is the end of the voice page URL)
4. `npm start`, then open http://localhost:3000 in Chrome or Edge.

## How the voice sounds human
- Claude writes each line the way a recruiter talks: contractions, "So,", "Alright,", "mm-hm", short sentences.
- Each line gets Fish Audio S1 emotion tags at the start of sentences, chosen per vibe, e.g. `(curious)`, `(delighted)`, `(sighing)`, `(serious)`, `(in a hurry tone)`, plus `(break)` for natural pauses. See `VIBES` in `server.js` to edit the tags.
- Tags are whitelisted in `server.js` (`ALLOWED_TAGS`) so a made-up tag is never read aloud. If Fish rejects tags, the server retries without them.
- Each vibe has its own speed and temperature, and can have its own voice (`FISH_VOICE_STRICT`, etc.).
- Tags only work with `FISH_MODEL=s1`. On older models they would be spoken, so keep `s1`.

## Flow
`/api/start` reads the resume (PDF/text) and creates the session and first question.
`/api/tts` turns a line into speech.
`/api/turn` transcribes your recorded answer (Fish ASR), then the interviewer reacts, asks a follow-up or the next question.
`/api/report` scores the whole session and adds delivery stats (pace, filler words).

## Notes
- Sessions live in memory; restart the server and they are gone. Swap the `sessions` Map for a database before going public.
- If transcription fails on browser audio, check the Fish ASR docs for accepted formats; the fix is converting webm to wav/mp3 with ffmpeg in `fishASR()`.
- Add authentication and rate limits before deploying, since every request spends your credits.
