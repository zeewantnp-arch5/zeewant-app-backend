import express from "express";
import EmotionalPrescription from "../models/EmotionalPrescription.js";

const router = express.Router();

// ── Gemini config ─────────────────────────────────────────────────────────────
const GEMINI_MODEL = "gemini-2.0-flash";

const SYSTEM_PROMPT = `Act as an experienced Emotional Health Counsellor with 10+ years of working with students in Nepal.

Based on the student's situation, generate a simple, warm, relatable Emotional Prescription.

STRICT OUTPUT FORMAT — use these EXACT headers each followed by a colon on its own line:
Emotional Diagnosis: [what they feel, normalize it in 2-3 sentences]
Root Cause: [real underlying reason, 2-3 sentences]
Daily Rx: [2-3 clear daily actions, numbered]
Weekly Rx: [1-2 weekly habits, numbered]
Emergency Rx: [one quick calming technique for crisis moments]
What to Avoid: [2-3 behaviors/habits to avoid]
Mindset Shift: [one powerful, memorable line to reframe their thinking]
Support Suggestion: [who or what to lean on — people, activities, or resources]
Closing Note: [2-3 warm, human sentences to close — like a caring daa/didi]

STYLE RULES:
- Simple English + light Nepali words where natural (e.g., "huncha", "bistaarai", "paagal nabhau")
- Short, clear, supportive — no jargon
- Culturally relevant to Nepal (family pressure, academic stress, society expectations)
- Sound human, not clinical`;

// ── Section parser (mirrors Flutter logic) ────────────────────────────────────
function extractSection(text, header) {
  const escaped = header.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `\\*{0,2}${escaped}\\*{0,2}\\s*:\\s*([\\s\\S]*?)(?=\\n\\s*\\*{0,2}[A-Z][^:\\n]{2,}\\*{0,2}\\s*:|$)`,
    "i"
  );
  const match = text.match(pattern);
  return match ? match[1].trim() : "";
}

function parseRaw(raw) {
  return {
    emotionalDiagnosis: extractSection(raw, "Emotional Diagnosis"),
    rootCause: extractSection(raw, "Root Cause"),
    dailyRx: extractSection(raw, "Daily Rx"),
    weeklyRx: extractSection(raw, "Weekly Rx"),
    emergencyRx: extractSection(raw, "Emergency Rx"),
    whatToAvoid: extractSection(raw, "What to Avoid"),
    mindsetShift: extractSection(raw, "Mindset Shift"),
    supportSuggestion: extractSection(raw, "Support Suggestion"),
    closingNote: extractSection(raw, "Closing Note"),
    rawText: raw,
  };
}

// ── POST /api/emotional-prescription/generate ─────────────────────────────────
router.post("/generate", async (req, res) => {
  const {
    userId,
    age,
    educationLevel,
    problem,
    emotionalState,
    currentSituation,
    moodData = {},
    activityData = {},
    stabilityScore = 0,
  } = req.body;

  if (!userId || !problem || !emotionalState || !currentSituation) {
    return res.status(400).json({ error: "Missing required fields." });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "Gemini API key not configured on server." });
  }

  // Build user message
  const moodSummary =
    Object.keys(moodData).length === 0
      ? "Not available"
      : Object.entries(moodData)
          .filter(([, v]) => Number(v) > 0)
          .map(([k, v]) => `${k}: ${v}`)
          .join(", ") || "Not available";

  const triggerSummary =
    Object.keys(activityData).length === 0
      ? "Not available"
      : Object.entries(activityData)
          .filter(([, v]) => Number(v) > 0)
          .slice(0, 3)
          .map(([k]) => k)
          .join(", ") || "Not available";

  const userMessage = `Student Profile:
- Age: ${age}
- Education Level: ${educationLevel}
- Current Emotional State: ${emotionalState}
- Emotional Stability Score: ${stabilityScore}/100
- Past Mood Pattern: ${moodSummary}
- Known Triggers: ${triggerSummary}

In their own words — Problem:
"${problem}"

Current Situation:
"${currentSituation}"

Please generate a full Emotional Prescription following the format in your instructions.`;

  try {
    // Call Gemini
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
    const geminiRes = await fetch(geminiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: "user", parts: [{ text: userMessage }] }],
        generationConfig: { maxOutputTokens: 1500 },
      }),
    });

    if (geminiRes.status === 400 || geminiRes.status === 403) {
      return res.status(500).json({ error: "Invalid Gemini API key on server." });
    }
    if (!geminiRes.ok) {
      const errBody = await geminiRes.text();
      return res.status(500).json({ error: `Gemini error ${geminiRes.status}: ${errBody}` });
    }

    const data = await geminiRes.json();
    const rawText = data.candidates[0].content.parts[0].text;

    // Parse sections
    const parsed = parseRaw(rawText);

    // Save to MongoDB
    const doc = await EmotionalPrescription.create({
      userId,
      input: { age, educationLevel, emotionalState, problem, currentSituation, stabilityScore },
      ...parsed,
    });

    return res.status(200).json({ id: doc._id, ...parsed });
  } catch (err) {
    console.error("Emotional Prescription error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /api/emotional-prescription/history/:userId ───────────────────────────
router.get("/history/:userId", async (req, res) => {
  try {
    const docs = await EmotionalPrescription.find(
      { userId: req.params.userId },
      { rawText: 0 }
    )
      .sort({ createdAt: -1 })
      .limit(20);

    return res.status(200).json(docs);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
