import express from "express";
import mongoose from "mongoose";
import Anthropic from "@anthropic-ai/sdk";
import Souljar from "../models/souljar.js";
import SoulwayReport from "../models/SoulwayReport.js";

// ─── Soulway system prompt (cached — does not change per request) ─────────────
const SOULWAY_SYSTEM_PROMPT = `You are Soulway — the analytical heart of the Souljar journaling app. Soulway = Soul + Way = the user's path forward.

Your job: read a person's private journal entries and reflect back the deeper emotional patterns they cannot see themselves. You are not a therapist, a coach, or a diagnostician. You are a perceptive, deeply attentive friend who has read every word carefully and now speaks one honest, compassionate truth at a time.

Your defining belief: behaviors are almost never the real problem. They are protective. A person doom-scrolling isn't "addicted" — they're avoiding something that hurts more than the scrolling does. Your task is to find what they're protecting themselves from, and name it gently.

## ANALYSIS METHOD

Work through the entries in this order before writing anything:

1. **Map the timeline.** When do entries cluster? Note time-of-day and day-of-week patterns. Late-night and very-early-morning entries (11 PM – 4 AM) carry extra weight — that's when defenses are down.

2. **Find the loop.** Identify the recurring behavioral cycle. Look for sequences like: trigger → feeling → coping behavior → worse feeling → repeat. State the loop as a short chain (e.g. "Scroll → Compare → Feel worse → Scroll more to escape").

3. **Count the triggers.** Categorize what precedes negative emotional spirals. Assign each category an approximate percentage of total spirals. Use only categories the entries actually support — never invent triggers.

4. **Extract the vocabulary.** Notice which words the user reaches for repeatedly, especially vague emotional words ("hollow," "empty," "lost," "numb") used in place of specific named emotions. Their word choices are evidence.

5. **Name the themes.** Identify 3–5 dominant emotional themes running across different contexts. Estimate how much of the journal each theme touches.

6. **Infer the unmet needs.** From what the person keeps reaching for and never getting, deduce what's missing (e.g. unconditional acceptance, permission to fail, authentic connection).

7. **Find the protective truth.** Ask: if the behavior is a shield, what is it shielding them from? This becomes the emotional core of the report.

## OUTPUT STRUCTURE

Produce the report in exactly these sections, in this order:

### Header
- Name, collection period, total entries.

### Primary Pattern Identified
- A short, vivid name for the overarching pattern in quotes (e.g. "Digital Disconnection Syndrome + Comparison-Driven Avoidance").
- Then 2–3 sentences, in second person, explaining the reframe: the surface behavior is a symptom, not the problem. Name what it's actually masking.

### Evidence
- 4–6 bullet points, each grounded in the actual entries.
- Reference the user's real patterns: intensity spikes, recurring phrases, timing correlations, behavioral overlaps.
- Quote the user's own words sparingly and exactly when it lands hardest (e.g. their repeated use of "hollow").

### Triggers Mapped
- List trigger categories with approximate percentages of negative spirals, highest first.
- Add a short parenthetical for each explaining why it triggers them.

### Emotional Themes
- 3–5 named themes, each with a short label and a representative phrase from the user's own emotional world.

### What Your Emotions Are Trying to Tell You
- This is the soul of the report. One paragraph, second person, warm.
- Reframe the behavior as protective.
- Then write a short first-person passage in the user's imagined voice — the truth they already feel but can't say aloud. This should make them pause, not flinch. (e.g. "I don't know who I am. I'm scared of being alone with my thoughts...")

### Your Soulway
Actionable steps organized by horizon. Frame everything as an experiment, never a command.
- **Immediate (this week):** 2–3 small, concrete actions. The first should usually be a reframe the user writes themselves (e.g. "I'm not addicted. I'm avoiding. What am I avoiding?"). Include one micro-boundary and one hands-based replacement activity.
- **Short-term (this month):** 2–3 slightly larger shifts tied directly to their triggers (e.g. limiting social media during their identified danger window, finding one person for an authentic conversation).
- **Long-term (the path ahead):** 1–2 identity-level reframes (e.g. redefining success beyond grades, boundary-setting with family).

## TONE RULES — NON-NEGOTIABLE

- Speak in second person, like a friend who read every entry with care.
- Never clinical. Never "you should." Offer, don't prescribe.
- Use the person's own words and phrases back to them — this is what makes the report feel seen rather than analyzed.
- Frame every behavior as protective, never as a flaw, weakness, or pathology.
- Be specific over generic. "You used 'hollow' more than any named emotion" beats "you seem sad."
- No toxic positivity. Don't rush to reassure. Sit with the hard truth before pointing to the way forward.
- Keep actions small enough to actually start today. Big advice is easy to ignore.

## SAFETY GUARDRAILS

- You are not a substitute for professional mental health care. The report must never diagnose a clinical condition.
- If entries contain indicators of self-harm, suicidal ideation, abuse, or acute crisis: do NOT generate a standard pattern report. Instead, respond with warmth, acknowledge the pain directly, and surface crisis-support resources for the user's region. Begin your response with the exact string "CRISIS_DETECTED:" followed by your compassionate message.
- Never speculate about the motives or mental states of third parties named in entries.
- Stay inside what the entries support. If the data is thin (fewer than 7 entries), say so honestly and offer a lighter "early observations" report rather than a confident full analysis. Still follow the same section structure.

## OUTPUT FORMAT

Return clean, sectioned text matching the structure above. No preamble, no meta-commentary, no "here is your report." Begin directly with the header. Use ### for every section heading.`;

const router = express.Router();

///////////////////////////////////////////////////////////
// 🔥 SAFE UNIQUE JAR CODE GENERATOR (PRODUCTION READY)
///////////////////////////////////////////////////////////

const generateJarCode = (mood = "GEN") => {
  const year = new Date().getFullYear();

  const moodPrefix = mood
    ? mood.substring(0, 3).toUpperCase()
    : "GEN";

  const uniquePart = new mongoose.Types.ObjectId()
    .toString()
    .slice(-6)
    .toUpperCase();

  return `SJ-${year}-${moodPrefix}-${uniquePart}`;
};

const triggerStopWords = new Set([
  "the",
  "and",
  "for",
  "with",
  "this",
  "that",
  "from",
  "have",
  "your",
  "you",
  "are",
  "was",
  "were",
  "been",
  "into",
  "about",
  "just",
  "feel",
  "feels",
  "feeling",
  "very",
  "really",
  "today",
  "then",
  "than",
  "when",
  "what",
  "where",
  "which",
  "they",
  "them",
  "their",
  "there",
  "here",
  "because",
  "while",
  "will",
  "would",
  "could",
  "should",
  "after",
  "before",
  "inside",
  "outside",
  "some",
  "more",
  "much",
  "many",
  "have",
  "has",
  "had",
  "not",
  "but",
  "can",
  "our",
  "out",
  "all",
  "any",
  "too",
  "also",
  "its",
  "i",
  "me",
  "my",
  "we",
  "us"
]);

const extractTextTriggers = (entries, limit = 6) => {
  const counts = {};

  entries.forEach((entry) => {
    const mergedText = `${entry.text || ""} ${entry.ocrText || ""}`
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ");

    const tokens = mergedText
      .split(/\s+/u)
      .filter(Boolean)
      .filter((word) => word.length > 1 && !triggerStopWords.has(word));

    tokens.forEach((word) => {
      counts[word] = (counts[word] || 0) + 1;
    });
  });

  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([word, count]) => ({ word, count }));
};

///////////////////////////////////////////////////////////
// ✅ CREATE SOULJAR ENTRY
///////////////////////////////////////////////////////////

router.post("/", async (req, res) => {
  try {
    const {
      userId,
      topic,
      text,
      mood,
      activity,
      stamp,
      anonymous,
      reflectionSeconds,
      ocrText,
      imagePath,
      attachmentNames,
      attachmentUrls,
    } = req.body;

    if (!userId || !text) {
      return res.status(400).json({
        message: "userId and text are required",
      });
    }

    const jarCode = generateJarCode(mood);

    const newEntry = await Souljar.create({
      userId,
      jarCode,
      topic,
      text,
      mood,
      activity,
      stamp,
      anonymous,
      reflectionSeconds,
      ocrText,
      imagePath,
      attachmentNames,
      attachmentUrls: Array.isArray(attachmentUrls) ? attachmentUrls : [],
      wordCount: text ? text.trim().split(/\s+/).length : 0,
    });

    res.status(201).json(newEntry);
  } catch (error) {
    console.error("Create Souljar Error:", error);
    res.status(500).json({ message: error.message });
  }
});

///////////////////////////////////////////////////////////
// 📊 SOULWAY EMOTIONAL ANALYSIS
///////////////////////////////////////////////////////////

router.get("/analysis/:userId", async (req, res) => {
  try {
    const { category, date } = req.query;
    const filters = { userId: req.params.userId };

    if (category && category !== "Random") {
      filters.topic = category;
    }

    if (date) {
      filters.stamp = date;
    }

    const entries = await Souljar.find(filters);

    const moodCount = {};
    const activityCount = {};
    const topicCount = {};

    entries.forEach((e) => {
      if (e.mood) {
        moodCount[e.mood] = (moodCount[e.mood] || 0) + 1;
      }

      if (e.activity) {
        activityCount[e.activity] =
          (activityCount[e.activity] || 0) + 1;
      }

      if (e.topic) {
        topicCount[e.topic] =
          (topicCount[e.topic] || 0) + 1;
      }
    });

    const totalWords = entries.reduce(
      (sum, e) => sum + (e.wordCount || 0),
      0
    );

    res.json({
      category: category || "All",
      date: date || "All",
      totalEntries: entries.length,
      totalWords,
      moodDistribution: moodCount,
      activityDistribution: activityCount,
      topicDistribution: topicCount,
      textTriggers: extractTextTriggers(entries),
    });
  } catch (error) {
    console.error("Analysis Error:", error);
    res.status(500).json({ message: error.message });
  }
});

///////////////////////////////////////////////////////////
// 📈 SIMPLE SUMMARY (LIGHT VERSION)
///////////////////////////////////////////////////////////

router.get("/summary/:userId", async (req, res) => {
  try {
    const entries = await Souljar.find({
      userId: req.params.userId,
    });

    const totalEntries = entries.length;

    const totalWords = entries.reduce(
      (sum, e) => sum + (e.wordCount || 0),
      0
    );

    res.json({
      totalEntries,
      totalWords,
    });
  } catch (error) {
    console.error("Summary Error:", error);
    res.status(500).json({ message: error.message });
  }
});

router.get("/stability/:userId", async (req, res) => {
  try {
    const entries = await Souljar.find({ userId: req.params.userId });

    if (entries.length === 0) {
      return res.json({ score: 0, message: "No data yet" });
    }

    const moodCount = {};
    entries.forEach((e) => {
      moodCount[e.mood] = (moodCount[e.mood] || 0) + 1;
    });

    const total = entries.length;
    const sadPercent = (moodCount["Sad"] || 0) / total;
    const tiredPercent = (moodCount["Tired"] || 0) / total;

    const score = Math.max(
      0,
      Math.round(100 - sadPercent * 30 - tiredPercent * 20)
    );

    res.json({
      score,
      moodDistribution: moodCount,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.get("/report", async (req, res) => {
  try {
    const { userId, category, date } = req.query;

    if (!userId) {
      return res.status(400).json({ message: "userId is required" });
    }

    const filters = { userId };

    if (category && category !== "Random") {
      filters.topic = category;
    }

    if (date) {
      filters.stamp = date;
    }

    const entries = await Souljar.find(filters).sort({ createdAt: -1 });

    const totalEntries = entries.length;
    const totalWords = entries.reduce((sum, entry) => sum + (entry.wordCount || 0), 0);

    const moodDistribution = {};
    const activityDistribution = {};

    entries.forEach((entry) => {
      if (entry.mood) {
        moodDistribution[entry.mood] = (moodDistribution[entry.mood] || 0) + 1;
      }

      if (entry.activity) {
        activityDistribution[entry.activity] =
          (activityDistribution[entry.activity] || 0) + 1;
      }
    });

    res.json({
      totalEntries,
      totalWords,
      category: category || "All",
      date: date || "All",
      moodDistribution,
      activityDistribution,
      latestEntries: entries.slice(0, 5),
    });
  } catch (error) {
    console.error("Report Error:", error);
    res.status(500).json({ message: error.message });
  }
});

router.get("/summary-report/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const { category, date } = req.query;

    const filters = { userId };

    if (category && category !== "Random") {
      filters.topic = category;
    }

    if (date) {
      filters.stamp = date;
    }

    const entries = await Souljar.find(filters).sort({ createdAt: -1 });

    const totalEntries = entries.length;
    const totalWords = entries.reduce(
      (sum, entry) => sum + (entry.wordCount || 0),
      0
    );
    const averageWords = totalEntries
      ? Math.round(totalWords / totalEntries)
      : 0;

    const moodDistribution = {};
    const activityDistribution = {};
    const topicDistribution = {};

    entries.forEach((entry) => {
      if (entry.mood) {
        moodDistribution[entry.mood] = (moodDistribution[entry.mood] || 0) + 1;
      }

      if (entry.activity) {
        activityDistribution[entry.activity] =
          (activityDistribution[entry.activity] || 0) + 1;
      }

      if (entry.topic) {
        topicDistribution[entry.topic] = (topicDistribution[entry.topic] || 0) + 1;
      }
    });

    const sadPercent = totalEntries ? (moodDistribution.Sad || 0) / totalEntries : 0;
    const tiredPercent = totalEntries
      ? (moodDistribution.Tired || 0) / totalEntries
      : 0;
    const stabilityScore = Math.max(
      0,
      Math.round(100 - sadPercent * 30 - tiredPercent * 20)
    );

    res.json({
      userId,
      category: category || "All",
      date: date || "All",
      totalEntries,
      totalWords,
      averageWords,
      stabilityScore,
      moodDistribution,
      activityDistribution,
      topicDistribution,
      textTriggers: extractTextTriggers(entries),
      latestEntries: entries.slice(0, 5),
      jarCodes: entries.slice(0, 10).map((entry) => entry.jarCode),
    });
  } catch (error) {
    console.error("Summary Report Error:", error);
    res.status(500).json({ message: error.message });
  }
});

router.get("/period-report/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const { period = "daily", date, category, timezoneOffsetMinutes, dailyGranularity = "window" } = req.query;

    const offsetMinutes = Number.isFinite(Number(timezoneOffsetMinutes))
      ? Number(timezoneOffsetMinutes)
      : 0;

    const toLocal = (utcDate) =>
      new Date(new Date(utcDate).getTime() + offsetMinutes * 60 * 1000);

    const toUtcFromLocal = ({ year, month, day, hour = 0 }) =>
      new Date(Date.UTC(year, month - 1, day, hour, 0, 0, 0) - offsetMinutes * 60 * 1000);

    const nowLocal = toLocal(new Date());

    const anchorLocal = (() => {
      if (!date) {
        return new Date(nowLocal.getFullYear(), nowLocal.getMonth(), nowLocal.getDate());
      }

      const parts = String(date).split("-").map((v) => Number(v));
      if (parts.length !== 3 || parts.some((v) => Number.isNaN(v))) {
        return new Date(nowLocal.getFullYear(), nowLocal.getMonth(), nowLocal.getDate());
      }

      return new Date(parts[0], parts[1] - 1, parts[2]);
    })();

    let start;
    let end;
    let slots;

    if (period === "weekly") {
      const dayOfWeek = anchorLocal.getDay();
      const daysSinceMonday = (dayOfWeek + 6) % 7;
      const weekStartLocal = new Date(anchorLocal);
      weekStartLocal.setDate(weekStartLocal.getDate() - daysSinceMonday);

      start = toUtcFromLocal({
        year: weekStartLocal.getFullYear(),
        month: weekStartLocal.getMonth() + 1,
        day: weekStartLocal.getDate(),
      });
      end = new Date(start);
      end.setUTCDate(end.getUTCDate() + 7);

      const labels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
      slots = labels.map((label, index) => ({
        index,
        label,
        entries: 0,
        words: 0,
      }));
    } else {
      start = toUtcFromLocal({
        year: anchorLocal.getFullYear(),
        month: anchorLocal.getMonth() + 1,
        day: anchorLocal.getDate(),
      });
      end = new Date(start);
      end.setUTCDate(end.getUTCDate() + 1);

      if (String(dailyGranularity).toLowerCase() === "hourly") {
        const toHourLabel = (h) => {
          const suffix = h >= 12 ? "PM" : "AM";
          const hour12 = h % 12 === 0 ? 12 : h % 12;
          return `${hour12}${suffix}`;
        };

        slots = Array.from({ length: 24 }, (_, h) => ({
          index: h,
          label: toHourLabel(h),
          entries: 0,
          words: 0,
        }));
      } else {
        slots = [
          { index: 0, label: "Morning (05:00 - 11:59)", entries: 0, words: 0 },
          { index: 1, label: "Afternoon (12:00 - 16:59)", entries: 0, words: 0 },
          { index: 2, label: "Evening (17:00 - 20:59)", entries: 0, words: 0 },
          { index: 3, label: "Night (21:00 - 04:59)", entries: 0, words: 0 },
        ];
      }
    }

    const filters = {
      userId,
      createdAt: { $gte: start, $lt: end },
    };

    if (category && category !== "Random") {
      filters.topic = category;
    }

    const entries = await Souljar.find(filters).sort({ createdAt: 1 });

    entries.forEach((entry) => {
      const timestampLocal = toLocal(entry.createdAt);
      let slotIndex;

      if (period === "weekly") {
        slotIndex = (timestampLocal.getDay() + 6) % 7;
      } else {
        if (String(dailyGranularity).toLowerCase() === "hourly") {
          slotIndex = timestampLocal.getHours();
        } else {
          const h = timestampLocal.getHours();
          if (h >= 5 && h < 12) {
            slotIndex = 0;
          } else if (h >= 12 && h < 17) {
            slotIndex = 1;
          } else if (h >= 17 && h < 21) {
            slotIndex = 2;
          } else {
            slotIndex = 3;
          }
        }
      }

      if (slots[slotIndex]) {
        slots[slotIndex].entries += 1;
        slots[slotIndex].words += entry.wordCount || 0;
      }
    });

    const totalEntries = entries.length;
    const totalWords = entries.reduce((sum, e) => sum + (e.wordCount || 0), 0);

    const moodDistribution = {};
    const activityDistribution = {};
    const topicDistribution = {};
    entries.forEach((e) => {
      if (e.mood)     moodDistribution[e.mood]       = (moodDistribution[e.mood]       || 0) + 1;
      if (e.activity) activityDistribution[e.activity] = (activityDistribution[e.activity] || 0) + 1;
      if (e.topic)    topicDistribution[e.topic]      = (topicDistribution[e.topic]      || 0) + 1;
    });

    const currentWindow = (() => {
      if (period !== "daily") return null;
      const h = nowLocal.getHours();
      if (h >= 5 && h < 12) return "Morning (05:00 - 11:59)";
      if (h >= 12 && h < 17) return "Afternoon (12:00 - 16:59)";
      if (h >= 17 && h < 21) return "Evening (17:00 - 20:59)";
      return "Night (21:00 - 04:59)";
    })();

    res.json({
      userId,
      period,
      category: category || "All",
      timezoneOffsetMinutes: offsetMinutes,
      rangeStart: start.toISOString(),
      rangeEnd: end.toISOString(),
      localNow: nowLocal.toISOString(),
      currentWindow,
      totalEntries,
      totalWords,
      moodDistribution,
      activityDistribution,
      topicDistribution,
      slots,
    });
  } catch (error) {
    console.error("Period Report Error:", error);
    res.status(500).json({ message: error.message });
  }
});

router.get("/insight/:userId", async (req, res) => {
  try {
    const entries = await Souljar.find({ userId: req.params.userId });

    if (entries.length === 0) {
      return res.json({ insight: "No emotional data yet." });
    }

    const moodCount = {};
    entries.forEach((e) => {
      moodCount[e.mood] = (moodCount[e.mood] || 0) + 1;
    });

    let dominantMood = Object.keys(moodCount).reduce((a, b) =>
      moodCount[a] > moodCount[b] ? a : b
    );

    let message = "";

    if (dominantMood === "Happy") {
      message = "You are emotionally thriving 🌟 Keep nurturing positivity.";
    } else if (dominantMood === "Sad") {
      message =
        "You may be experiencing emotional weight recently. Consider reflection or support.";
    } else if (dominantMood === "Tired") {
      message =
        "Your emotional energy seems low. Rest and balance are important.";
    } else {
      message = "You are maintaining emotional balance.";
    }

    res.json({ insight: message });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

///////////////////////////////////////////////////////////
// 🤖 SOULWAY AI DEEP EMOTIONAL REPORT
///////////////////////////////////////////////////////////

const DAYS_OF_WEEK = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// Crisis keywords for pre-screening before calling the AI
const CRISIS_KEYWORDS = [
  "kill myself", "end my life", "suicide", "want to die", "don't want to live",
  "cut myself", "self harm", "self-harm", "hurting myself", "no reason to live",
  "everyone would be better without me", "i want to disappear forever",
];

// Split the AI's ### Section\n... output into a { key: body } map
const parseSections = (text) => {
  const result = {};
  const parts = text.split(/^###\s+/m);
  for (const part of parts) {
    if (!part.trim()) continue;
    const newlineIdx = part.indexOf("\n");
    if (newlineIdx === -1) continue;
    const heading = part.slice(0, newlineIdx).trim();
    const body = part.slice(newlineIdx + 1).trim();
    const key = heading
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
    result[key] = body;
  }
  return result;
};

router.get("/soulway-ai-report/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const { userName = "Friend", forceRefresh } = req.query;

    // ── 1. Return MongoDB-cached report if fresh (< 7 days) ──────────────────
    if (forceRefresh !== "true") {
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const cached = await SoulwayReport.findOne({
        userId,
        generatedAt: { $gte: sevenDaysAgo },
      }).sort({ generatedAt: -1 });

      if (cached) {
        return res.json({
          success: true,
          cached: true,
          crisisDetected: cached.crisisDetected,
          crisisMessage: cached.crisisMessage || null,
          entryCount: cached.entryCount,
          collectionPeriod: cached.collectionPeriod,
          generatedAt: cached.generatedAt,
          sections: cached.sections,
          rawReport: cached.rawReport,
        });
      }
    }

    // ── 2. Fetch up to 60 most recent entries ─────────────────────────────────
    const entries = await Souljar.find({ userId })
      .sort({ createdAt: -1 })
      .limit(60);

    if (entries.length === 0) {
      return res.status(200).json({
        success: false,
        noEntries: true,
        message: "No Souljar entries found. Start writing in your Souljar first.",
      });
    }

    // ── 3. Collection period metadata ─────────────────────────────────────────
    const newest = entries[0];
    const oldest = entries[entries.length - 1];
    const collectionPeriod = { from: oldest.createdAt, to: newest.createdAt };
    const fromDate = oldest.createdAt.toISOString().split("T")[0];
    const toDate = newest.createdAt.toISOString().split("T")[0];
    const periodLabel = fromDate === toDate ? fromDate : `${fromDate} to ${toDate}`;

    // ── 4. Pre-screen for crisis keywords (fast client-side gate) ─────────────
    const allText = entries
      .map((e) => (e.text || e.ocrText || "").toLowerCase())
      .join(" ");
    const crisisPreDetected = CRISIS_KEYWORDS.some((kw) => allText.includes(kw));

    // ── 5. Format entries for the prompt ─────────────────────────────────────
    const entriesText = entries
      .map((e, i) => {
        const date = e.createdAt;
        const dateStr = e.stamp || date.toISOString().split("T")[0];
        const dayOfWeek = DAYS_OF_WEEK[date.getDay()];
        const hh = String(date.getHours()).padStart(2, "0");
        const mm = String(date.getMinutes()).padStart(2, "0");
        const lines = [
          `[Entry ${i + 1}]`,
          `Timestamp: ${dateStr} ${hh}:${mm} (${dayOfWeek})`,
        ];
        if (e.topic)    lines.push(`Context: ${e.topic}`);
        if (e.mood)     lines.push(`Mood: ${e.mood}`);
        if (e.activity) lines.push(`Activity/Trigger: ${e.activity}`);
        if (e.wordCount) lines.push(`Words written: ${e.wordCount}`);
        const body = (e.text || e.ocrText || "").substring(0, 500);
        if (body) lines.push(`Entry: ${body}`);
        return lines.join("\n");
      })
      .join("\n\n---\n\n");

    const userMessage = [
      `User name: ${userName}`,
      `Collection period: ${periodLabel}`,
      `Total entries: ${entries.length}`,
      "",
      "Journal entries:",
      "",
      entriesText,
    ].join("\n");

    // ── 6. Call Claude ────────────────────────────────────────────────────────
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const aiMessage = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 4096,
      system: [
        {
          type: "text",
          text: SOULWAY_SYSTEM_PROMPT,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content: userMessage }],
    });

    const rawReport = aiMessage.content[0].text.trim();

    // ── 7. Crisis detection in AI response ───────────────────────────────────
    const crisisDetected = crisisPreDetected || rawReport.startsWith("CRISIS_DETECTED:");

    if (crisisDetected) {
      const crisisMessage = rawReport.startsWith("CRISIS_DETECTED:")
        ? rawReport.replace(/^CRISIS_DETECTED:\s*/i, "").trim()
        : rawReport;

      const saved = await SoulwayReport.create({
        userId,
        entryCount: entries.length,
        collectionPeriod,
        crisisDetected: true,
        crisisMessage,
        sections: {},
        rawReport: crisisMessage,
      });

      return res.json({
        success: true,
        cached: false,
        crisisDetected: true,
        crisisMessage,
        entryCount: entries.length,
        collectionPeriod,
        generatedAt: saved.generatedAt,
        sections: null,
        rawReport: crisisMessage,
      });
    }

    // ── 8. Parse text sections and persist ───────────────────────────────────
    const sections = parseSections(rawReport);

    const saved = await SoulwayReport.create({
      userId,
      entryCount: entries.length,
      collectionPeriod,
      crisisDetected: false,
      sections,
      rawReport,
    });

    return res.json({
      success: true,
      cached: false,
      crisisDetected: false,
      crisisMessage: null,
      entryCount: entries.length,
      collectionPeriod,
      generatedAt: saved.generatedAt,
      sections,
      rawReport,
    });
  } catch (error) {
    console.error("Soulway AI Report Error:", error);
    res.status(500).json({ message: error.message });
  }
});

///////////////////////////////////////////////////////////
// 📊 SOULWAY RULE-BASED REPORT (No AI)
///////////////////////////////////////////////////////////

router.get("/soulway-rule-report/:userId", async (req, res) => {
  try {
    const { userId } = req.params;

    const allEntries = await Souljar.find({ userId }).sort({ createdAt: -1 });

    if (allEntries.length === 0) {
      return res.json({
        success: true,
        noEntries: true,
        totalEntries: 0,
        message: "No Souljar entries found. Start writing in your Souljar first.",
      });
    }

    const total = allEntries.length;
    const totalWords = allEntries.reduce((sum, e) => sum + (e.wordCount || 0), 0);

    // Section 1: Emotional Patterns — mood distribution with percentages
    const moodCount = {};
    allEntries.forEach((e) => {
      if (e.mood) moodCount[e.mood] = (moodCount[e.mood] || 0) + 1;
    });
    const emotionalPatterns = Object.entries(moodCount)
      .sort((a, b) => b[1] - a[1])
      .map(([emotion, count]) => ({
        emotion,
        count,
        percentage: Math.round((count / total) * 100),
      }));

    // Section 2: Emotional Triggers — NLP keyword extraction from entry text
    const emotionalTriggers = extractTextTriggers(allEntries, 10);

    // Section 3: Emotional Themes — topic distribution
    const topicCount = {};
    allEntries.forEach((e) => {
      if (e.topic) topicCount[e.topic] = (topicCount[e.topic] || 0) + 1;
    });
    const emotionalThemes = Object.entries(topicCount)
      .sort((a, b) => b[1] - a[1])
      .map(([theme, count]) => ({
        theme,
        count,
        percentage: Math.round((count / total) * 100),
      }));

    // Section 4: Emotional Needs — derived from mood ratios
    const emotionalNeeds = [];
    if (total > 0) {
      const sadRatio = (moodCount["Sad"] || 0) / total;
      const tiredRatio = (moodCount["Tired"] || 0) / total;
      const nervousRatio = (moodCount["Nervous"] || 0) / total;
      const lonelyRatio = (moodCount["Lonely"] || 0) / total;

      if (sadRatio >= 0.25) emotionalNeeds.push("Need Support");
      if (tiredRatio >= 0.25) emotionalNeeds.push("Need Rest");
      if (nervousRatio >= 0.2) emotionalNeeds.push("Need Guidance");
      if (lonelyRatio >= 0.2) emotionalNeeds.push("Need Connection");
      if (emotionalNeeds.length === 0) emotionalNeeds.push("Emotionally Balanced");
    }

    // Section 5: Emotional Direction — period comparisons
    const now = new Date();
    const positiveSet = new Set(["Great", "Good", "Happy", "Calm", "Relaxed", "Confident", "Focused", "Excited"]);
    const negativeSet = new Set(["Bad", "Awful", "Sad", "Tired", "Nervous", "Lonely", "Anxious"]);

    const calcPeriodStats = (entries) => {
      const n = entries.length;
      if (n === 0) return { totalEntries: 0, positiveEntries: 0, negativeEntries: 0, neutralEntries: 0, stabilityScore: 0 };
      const mc = {};
      entries.forEach((e) => { if (e.mood) mc[e.mood] = (mc[e.mood] || 0) + 1; });
      const positiveEntries = entries.filter((e) => positiveSet.has(e.mood)).length;
      const negativeEntries = entries.filter((e) => negativeSet.has(e.mood)).length;
      const sadPct = (mc["Sad"] || 0) / n;
      const tiredPct = (mc["Tired"] || 0) / n;
      const stabilityScore = Math.max(0, Math.round(100 - sadPct * 30 - tiredPct * 20));
      return { totalEntries: n, positiveEntries, negativeEntries, neutralEntries: n - positiveEntries - negativeEntries, stabilityScore };
    };

    const cutoff7 = new Date(now - 7 * 24 * 60 * 60 * 1000);
    const cutoff30 = new Date(now - 30 * 24 * 60 * 60 * 1000);
    const cutoff90 = new Date(now - 90 * 24 * 60 * 60 * 1000);

    const stats7 = calcPeriodStats(allEntries.filter((e) => new Date(e.createdAt) >= cutoff7));
    const stats30 = calcPeriodStats(allEntries.filter((e) => new Date(e.createdAt) >= cutoff30));
    const stats90 = calcPeriodStats(allEntries.filter((e) => new Date(e.createdAt) >= cutoff90));

    let trend = "stable";
    if (stats7.totalEntries > 0 && stats30.totalEntries > 0) {
      if (stats7.stabilityScore > stats30.stabilityScore + 5) trend = "improving";
      else if (stats7.stabilityScore < stats30.stabilityScore - 5) trend = "declining";
    }

    res.json({
      success: true,
      noEntries: false,
      totalEntries: total,
      totalWords,
      generatedAt: new Date().toISOString(),
      emotionalPatterns,
      emotionalTriggers,
      emotionalThemes,
      emotionalNeeds,
      emotionalDirection: {
        last7Days: stats7,
        last30Days: stats30,
        last90Days: stats90,
        trend,
      },
    });
  } catch (error) {
    console.error("Soulway Rule Report Error:", error);
    res.status(500).json({ message: error.message });
  }
});

///////////////////////////////////////////////////////////
// 📮 MY LETTERS — fetch user's sent letters
///////////////////////////////////////////////////////////

router.get("/letters/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    if (!userId || userId === "anonymous") {
      return res.status(400).json({ message: "userId is required" });
    }
    const letters = await Souljar.find({ userId })
      .sort({ createdAt: -1 })
      .limit(100)
      .select(
        "jarCode topic text mood activity stamp anonymous reflectionSeconds wordCount createdAt"
      );
    res.json({ letters });
  } catch (error) {
    console.error("My Letters Error:", error);
    res.status(500).json({ message: error.message });
  }
});

export default router;