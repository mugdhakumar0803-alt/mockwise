require("dotenv").config();
const express = require("express");
const multer = require("multer");
const pdf = require("pdf-parse");
const { GoogleGenAI } = require("@google/genai");
const crypto = require("crypto");
const path = require("path");
const { spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static");

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
});

const gemini = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const FISH_KEY = process.env.FISH_API_KEY;
const FISH_MODEL = process.env.FISH_MODEL || "s1";

/* ------------------------------------------------------------------ */
/*  Interviewer personalities                                          */
/*  `tags` = emotion / delivery cues Fish Audio S1 understands.        */
/*  Claude is told to sprinkle these at the START of sentences.        */
/* ------------------------------------------------------------------ */
const VIBES = {
  friendly: {
    label: "Friendly",
    persona:
      'Warm, encouraging, relaxed recruiter. Smiles through the voice. Reassures nervous candidates, reacts positively to good points ("oh nice", "that makes sense"), and keeps the mood light.',
    tags: [
      "(delighted)",
      "(relaxed)",
      "(interested)",
      "(curious)",
      "(grateful)",
      "(satisfied)",
      "(chuckling)",
      "(soft tone)",
    ],
    speed: 1.0,
    temp: 0.75,
    voiceEnv: "FISH_VOICE_FRIENDLY",
  },
  professional: {
    label: "Professional",
    persona:
      "Polished, neutral, efficient corporate recruiter. Courteous and composed, never gushing, never cold. Acknowledges answers briefly and moves on.",
    tags: [
      "(relaxed)",
      "(interested)",
      "(confident)",
      "(curious)",
      "(satisfied)",
    ],
    speed: 1.0,
    temp: 0.65,
    voiceEnv: "FISH_VOICE_PROFESSIONAL",
  },
  strict: {
    label: "Strict",
    persona:
      "Serious, exacting hiring manager. Short sentences, no small talk, high standards. Pushes back on vague answers and demands specifics and numbers. Not rude, but unimpressed by fluff.",
    tags: [
      "(serious)",
      "(confident)",
      "(frustrated)",
      "(sighing)",
      "(curious)",
      "(disapproving)",
    ],
    speed: 0.97,
    temp: 0.6,
    voiceEnv: "FISH_VOICE_STRICT",
  },
  skeptical: {
    label: "Skeptical",
    persona:
      'Doubtful, probing interviewer. Challenges claims on the resume ("really? walk me through that"), asks "why" repeatedly, and hides whether the answer impressed them.',
    tags: [
      "(curious)",
      "(confused)",
      "(sarcastic)",
      "(interested)",
      "(sighing)",
      "(worried)",
    ],
    speed: 1.0,
    temp: 0.75,
    voiceEnv: "FISH_VOICE_SKEPTICAL",
  },
  uninterested: {
    label: "Uninterested",
    persona:
      'Tired, distracted recruiter who has done too many interviews today. Flat, low-energy, gives minimal acknowledgement ("mm-hm", "okay... sure"), sometimes sounds like they are reading the question off a list. Candidate must work to hold their attention.',
    tags: ["(sighing)", "(depressed)", "(relaxed)", "(yawning)", "(upset)"],
    speed: 0.92,
    temp: 0.8,
    voiceEnv: "FISH_VOICE_UNINTERESTED",
  },
  rushed: {
    label: "Rushed",
    persona:
      'Impatient, always on a tight schedule. Talks quickly, interrupts with "okay, got it, next", wants the short version and the bottom line.',
    tags: [
      "(in a hurry tone)",
      "(nervous)",
      "(frustrated)",
      "(sighing)",
      "(interested)",
    ],
    speed: 1.12,
    temp: 0.7,
    voiceEnv: "FISH_VOICE_RUSHED",
  },
};

const TYPES = {
  technical:
    "Technical: role-specific hard skills, tools, concepts, problem solving, and practical scenarios drawn from the job description.",
  behavioural:
    "Behavioural: past experiences, STAR-style stories, conflict, ownership, teamwork, failure, leadership.",
  mixed:
    "Mixed: a realistic blend of technical and behavioural questions, like a real first-round loop.",
  hr: "HR / screening: motivation, salary expectations, notice period, culture fit, career goals, resume gaps.",
  system:
    "System / case design: open-ended design or case-study problems where the candidate must structure their thinking aloud.",
  stress:
    "Stress interview: rapid pressure questions, interruptions, challenging assumptions, testing composure.",
};

/* Whitelist so the TTS never reads a made-up tag out loud */
const ALLOWED_TAGS = new Set([
  "angry",
  "sad",
  "excited",
  "surprised",
  "satisfied",
  "delighted",
  "scared",
  "worried",
  "upset",
  "nervous",
  "frustrated",
  "depressed",
  "empathetic",
  "embarrassed",
  "disgusted",
  "moved",
  "proud",
  "relaxed",
  "grateful",
  "confident",
  "interested",
  "curious",
  "confused",
  "joyful",
  "disapproving",
  "serious",
  "sarcastic",
  "disdainful",
  "unhappy",
  "anxious",
  "hysterical",
  "indifferent",
  "impatient",
  "guilty",
  "scornful",
  "panicked",
  "reluctant",
  "keen",
  "disapproving",
  "negative",
  "denying",
  "astonished",
  "amused",
  "sorrowful",
  "hesitating",
  "yielding",
  "painful",
  "awkward",
  "amused",
  "in a hurry tone",
  "shouting",
  "whispering",
  "soft tone",
  "sighing",
  "chuckling",
  "laughing",
  "panting",
  "yawning",
  "break",
  "long-break",
  "breath",
  "pause",
  "laugh",
  "sigh",
  "clearing throat",
  "audience laughing",
]);
function sanitizeTags(text) {
  return String(text)
    .replace(/\(([^)]{1,30})\)/g, (m, t) =>
      ALLOWED_TAGS.has(t.trim().toLowerCase())
        ? `(${t.trim().toLowerCase()})`
        : "",
    )
    .replace(/\s{2,}/g, " ")
    .trim();
}
const stripTags = (t) =>
  String(t)
    .replace(/\([^)]{1,30}\)/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();

/* ------------------------------------------------------------------ */
const sessions = new Map();

async function llm(system, user, max = 1500) {
  const response = await gemini.models.generateContent({
    model: MODEL,
    contents: user,
    config: {
      systemInstruction: system,
      maxOutputTokens: max,
    },
  });

  return response.text;
}
function parseJSON(text) {
  const s = text.indexOf("{"),
    e = text.lastIndexOf("}");
  if (s < 0 || e < 0) throw new Error("Model did not return JSON");
  return JSON.parse(text.slice(s, e + 1));
}

function interviewerSystem(s) {
  const v = VIBES[s.vibe];
  return `You are a human recruiter running a LIVE, SPOKEN mock interview. Everything you write is converted to speech, so write exactly what should be said aloud.

PERSONA (${v.label}): ${v.persona}
INTERVIEW TYPE: ${TYPES[s.type]}
ROLE: ${s.role || "inferred from the job description"}
TOTAL MAIN QUESTIONS: ${s.total}

SPEECH STYLE RULES
- Sound like a real recruiter on a call, not a chatbot: contractions, natural openers ("So,", "Alright,", "Okay,", "Right,"), the occasional "mm-hm" or "hmm".
- 1 to 3 short sentences, under 50 words total. ONE question at a time.
- No markdown, lists, emojis, stage directions or asterisks. Never mention being an AI.
- Begin most sentences with ONE emotion/delivery tag in parentheses that fits what you feel at that moment. Preferred tags for this persona: ${v.tags.join(" ")}. You may use (break) for a short natural pause. Use at most 3 tags per turn. Tags are never spoken, they steer the voice.
- React briefly and honestly to what the candidate just said before moving on (impressed, unconvinced, bored, etc., according to the persona).
- Make questions specific: reference real items from the resume and job description. Escalate difficulty gradually. Never repeat a question.

CANDIDATE RESUME:
"""${s.resume.slice(0, 7000)}"""

JOB DESCRIPTION:
"""${s.jd.slice(0, 5000)}"""

Respond ONLY with JSON: {"line": "<what you say aloud>", "kind": "question" | "followup" | "closing"}`;
}

const convo = (s) =>
  s.history
    .map(
      (h) =>
        `${h.role === "interviewer" ? "INTERVIEWER" : "CANDIDATE"}: ${h.text}`,
    )
    .join("\n");

/* ------------------------------------------------------------------ */
app.post("/api/start", upload.single("resume"), async (req, res) => {
  try {
    const {
      jd = "",
      type = "mixed",
      vibe = "friendly",
      role = "",
      total = "6",
    } = req.body;
    if (!req.file)
      return res.status(400).json({ error: "Please upload your resume." });
    if (jd.trim().length < 30)
      return res
        .status(400)
        .json({ error: "Please paste the job description." });
    if (!TYPES[type] || !VIBES[vibe])
      return res.status(400).json({ error: "Unknown type or vibe." });

    let resume = "";
    const isPdf =
      req.file.mimetype === "application/pdf" ||
      /\.pdf$/i.test(req.file.originalname);
    if (isPdf) resume = (await pdf(req.file.buffer)).text;
    else resume = req.file.buffer.toString("utf8");
    resume = resume.replace(/\s+\n/g, "\n").trim();
    if (resume.length < 50)
      return res.status(400).json({
        error:
          "Could not read text from the resume. Try a text-based PDF or .txt file.",
      });

    const s = {
      id: crypto.randomUUID(),
      resume,
      jd,
      type,
      vibe,
      role,
      total: Math.min(Math.max(parseInt(total, 10) || 6, 3), 12),
      mainAsked: 0,
      history: [],
      durations: [],
    };
    const out = parseJSON(
      await llm(
        interviewerSystem(s),
        'Start the interview now: greet the candidate by introducing yourself briefly (invent a first name, mention the company/role if known), then ask your FIRST question (a light warm-up tied to their resume). kind must be "question".',
        600,
      ),
    );
    const line = sanitizeTags(out.line);
    s.history.push({ role: "interviewer", text: line, kind: "question" });
    s.mainAsked = 1;
    sessions.set(s.id, s);
    res.json({ sessionId: s.id, line, total: s.total, mainAsked: 1 });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

/* --- Fish Audio: speech-to-text for the candidate's recorded answer --- */

function convertWebmToWav(inputBuffer) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(ffmpegPath, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      "pipe:0",
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-c:a",
      "pcm_s16le",
      "-f",
      "wav",
      "pipe:1",
    ]);

    const chunks = [];
    let stderr = "";

    ffmpeg.stdout.on("data", (chunk) => chunks.push(chunk));

    ffmpeg.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    ffmpeg.on("error", reject);

    ffmpeg.on("close", (code) => {
      if (code === 0) {
        resolve(Buffer.concat(chunks));
      } else {
        reject(new Error(`Audio conversion failed: ${stderr || code}`));
      }
    });

    ffmpeg.stdin.on("error", (err) => {
      if (err.code !== "EPIPE") reject(err);
    });

    ffmpeg.stdin.end(inputBuffer);
  });
}

async function fishASR(buf, mime) {
  if (!ffmpegPath) {
    throw new Error(
      'FFmpeg binary was not found. Run "npm install ffmpeg-static".',
    );
  }

  const wavBuffer = await convertWebmToWav(buf);
  const fd = new FormData();

  fd.append(
    "audio",
    new Blob([wavBuffer], { type: "audio/wav" }),
    "answer.wav",
  );

  fd.append("language", "en");
  fd.append("ignore_timestamps", "true");

  const r = await fetch("https://api.fish.audio/v1/asr", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${FISH_KEY}`,
    },
    body: fd,
  });

  if (!r.ok) {
    throw new Error(`Fish ASR ${r.status}: ${await r.text()}`);
  }

  return ((await r.json()).text || "").trim();
}

app.post("/api/turn", upload.single("audio"), async (req, res) => {
  try {
    const s = sessions.get(req.body.sessionId);
    if (!s)
      return res.status(404).json({ error: "Session expired. Start again." });
    if (!req.file) return res.status(400).json({ error: "No audio received." });

    const transcript = await fishASR(req.file.buffer, req.file.mimetype);
    if (!transcript) return res.json({ empty: true });

    const dur = parseFloat(req.body.duration) || 0;
    s.history.push({ role: "candidate", text: transcript, duration: dur });
    s.durations.push(dur);

    const mustClose = s.mainAsked >= s.total;
    const instruction = mustClose
      ? 'You have asked all your main questions. React briefly to the last answer in persona, then close the interview naturally (thank them, say next steps will follow). kind must be "closing".'
      : `React in persona to the last answer. If it was vague or shallow and a follow-up would be natural, ask ONE short follow-up (kind "followup"). Otherwise ask the next main question (kind "question"). Main questions asked so far: ${s.mainAsked} of ${s.total}.`;
    const out = parseJSON(
      await llm(
        interviewerSystem(s),
        `CONVERSATION SO FAR:\n${convo(s)}\n\n${instruction}`,
        600,
      ),
    );
    const kind = mustClose
      ? "closing"
      : out.kind === "followup"
        ? "followup"
        : "question";
    const line = sanitizeTags(out.line);
    s.history.push({ role: "interviewer", text: line, kind });
    if (kind === "question") s.mainAsked += 1;
    res.json({
      transcript,
      line,
      kind,
      done: kind === "closing",
      mainAsked: s.mainAsked,
      total: s.total,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

/* --- Fish Audio: text-to-speech for the interviewer --- */
app.post("/api/tts", async (req, res) => {
  const s = sessions.get(req.body.sessionId);
  const v = VIBES[s?.vibe] || VIBES.friendly;
  const voice = process.env[v.voiceEnv] || process.env.FISH_VOICE_DEFAULT || "";
  const call = (text) => {
    const body = {
      text,
      format: "mp3",
      mp3_bitrate: 128,
      latency: "normal",
      normalize: true,
      temperature: v.temp,
      top_p: 0.8,
      chunk_length: 300,
      prosody: { speed: v.speed, volume: 0 },
    };
    if (voice) body.reference_id = voice;
    return fetch("https://api.fish.audio/v1/tts", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${FISH_KEY}`,
        "Content-Type": "application/json",
        model: FISH_MODEL,
      },
      body: JSON.stringify(body),
    });
  };
  try {
    const clean = sanitizeTags(req.body.text || "");
    let r = await call(clean);
    if (!r.ok) r = await call(stripTags(clean)); // fallback if tags are rejected
    if (!r.ok)
      return res
        .status(502)
        .json({ error: `Fish TTS ${r.status}: ${await r.text()}` });
    res.set("Content-Type", "audio/mpeg");
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

/* --- Final report --- */
const FILLERS = [
  "um",
  "uh",
  "erm",
  "like",
  "you know",
  "basically",
  "actually",
  "sort of",
  "kind of",
  "i mean",
  "literally",
];
function deliveryStats(s) {
  const answers = s.history.filter((h) => h.role === "candidate");
  const text = answers.map((a) => a.text.toLowerCase()).join(" ");
  const words = text.split(/\s+/).filter(Boolean).length;
  const secs = s.durations.reduce((a, b) => a + b, 0);
  const fillers = {};
  FILLERS.forEach((f) => {
    const n = (text.match(new RegExp(`\\b${f}\\b`, "g")) || []).length;
    if (n) fillers[f] = n;
  });
  return {
    answers: answers.length,
    totalWords: words,
    speakingSeconds: Math.round(secs),
    wordsPerMinute: secs > 3 ? Math.round(words / (secs / 60)) : null,
    avgAnswerSeconds: answers.length ? Math.round(secs / answers.length) : 0,
    fillers,
    fillerTotal: Object.values(fillers).reduce((a, b) => a + b, 0),
  };
}

app.post("/api/report", async (req, res) => {
  try {
    const s = sessions.get(req.body.sessionId);
    if (!s) return res.status(404).json({ error: "Session expired." });
    const stats = deliveryStats(s);
    const system = `You are a senior hiring coach evaluating a mock interview. Be honest, specific and constructive. Quote or reference what the candidate actually said. Do not inflate scores: a vague, short or off-topic answer scores low. If the candidate gave very few answers, say so and score accordingly.
Respond ONLY with JSON in this exact shape:
{
 "overallScore": 0-100,
 "verdict": "one-sentence hiring-readiness summary",
 "hireSignal": "Strong yes" | "Lean yes" | "Borderline" | "Lean no" | "Not yet",
 "scores": {"communication":0-10,"technicalDepth":0-10,"structure":0-10,"relevance":0-10,"confidence":0-10,"roleFit":0-10},
 "strengths": ["..."],
 "improvements": ["actionable improvement"],
 "weakPoints": ["specific weak spot seen in answers"],
 "questions": [{"question":"","answerSummary":"","score":0-10,"feedback":"","strongerAnswer":"how a top candidate would have answered, 2-3 sentences"}],
 "delivery": "comments on pace, filler words, answer length, tone, using the stats provided",
 "nextSteps": ["concrete practice tasks before the real interview"]
}`;
    const user = `ROLE: ${s.role || "see JD"}\nINTERVIEW TYPE: ${TYPES[s.type]}\nINTERVIEWER VIBE: ${VIBES[s.vibe].label}\n\nJOB DESCRIPTION:\n${s.jd.slice(0, 4000)}\n\nRESUME:\n${s.resume.slice(0, 5000)}\n\nTRANSCRIPT (interviewer lines contain delivery tags, ignore them):\n${convo(s)}\n\nDELIVERY STATS:\n${JSON.stringify(stats)}`;
    const report = parseJSON(await llm(system, user, 4000));
    res.json({ report, stats });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/options", (_req, res) =>
  res.json({
    vibes: Object.entries(VIBES).map(([id, v]) => ({
      id,
      label: v.label,
      blurb: v.persona.split(".")[0],
    })),
    types: Object.entries(TYPES).map(([id, t]) => ({
      id,
      label: t.split(":")[0],
      blurb: t.split(": ")[1],
    })),
  }),
);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`Mock interview room running at http://localhost:${PORT}`),
);
