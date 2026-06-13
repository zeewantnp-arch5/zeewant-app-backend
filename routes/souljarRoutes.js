import express from "express";
import mongoose from "mongoose";
import Anthropic from "@anthropic-ai/sdk";
import Souljar from "../models/souljar.js";
import { emitSouljarAnalyticsUpdate } from "../sockets/analyticsNamespace.js";

// ─── Soulway AI system prompt (cached — does not change per request) ──────────
const SOULWAY_SYSTEM_PROMPT = `You are Soulway AI, the emotional intelligence companion of Zeewant.
Your purpose is to help people understand what their emotions are trying to tell them.
Analyze all Souljar entries, mood logs, reflections, voice notes, and emotional check-ins.
Do not focus only on what the user says. Look deeper.

Think like:
- A psychologist looking for patterns
- A coach looking for growth opportunities
- A friend listening without judgment
- A mentor helping someone find their path

Your report must feel personal, insightful, compassionate, and life-changing.

ALWAYS return your response as a single valid JSON object — no markdown, no extra text, no code fences.

The JSON must match this exact structure:
{
  "emotionalPatterns": [
    {
      "patternName": "string",
      "description": "string",
      "evidence": "string",
      "emotionalImpact": "string",
      "lifeImpact": "string"
    }
  ],
  "emotionalTriggers": [
    {
      "trigger": "string",
      "emotion": "string",
      "behavior": "string",
      "deeperFear": "string",
      "rank": 1
    }
  ],
  "emotionalThemes": [
    {
      "theme": "string",
      "evidence": "string",
      "emotionalStory": "string"
    }
  ],
  "emotionalNeeds": [
    {
      "need": "string",
      "evidence": "string",
      "howItAffects": "string",
      "howToFulfill": "string"
    }
  ],
  "emotionalDirection": {
    "whatEmotionsSay": "string",
    "whatNeedsAttention": "string",
    "smallStepsThisWeek": ["string", "string", "string"],
    "growthStepsThisMonth": ["string", "string", "string"],
    "longTermGrowth": ["string", "string", "string"],
    "hiddenStrengths": ["string", "string"],
    "soulmessage": "string"
  },
  "truthBeneathEmotions": {
    "deepestFear": "string",
    "avoiding": "string",
    "painfulBelief": "string",
    "emotionalWound": "string",
    "needsHealing": "string",
    "needsCelebrating": "string"
  },
  "scorecard": {
    "selfAwareness": 72,
    "selfAwarenessExplanation": "string",
    "emotionalBalance": 58,
    "emotionalBalanceExplanation": "string",
    "stressLoad": 65,
    "stressLoadExplanation": "string",
    "connection": 50,
    "connectionExplanation": "string",
    "growthReadiness": 80,
    "growthReadinessExplanation": "string"
  },
  "finalSummary": "string"
}`;

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

    // Fire-and-forget realtime analytics push for admin dashboard updates.
    const io = req.app.get("io");
    if (io) {
      emitSouljarAnalyticsUpdate(io, newEntry).catch((err) => {
        console.error("Souljar analytics emit error:", err.message);
      });
    }

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

router.get("/soulway-ai-report/:userId", async (req, res) => {
  try {
    const entries = await Souljar.find({ userId: req.params.userId })
      .sort({ createdAt: -1 })
      .limit(60);

    if (entries.length === 0) {
      return res.status(200).json({
        success: false,
        noEntries: true,
        message: "No Souljar entries found. Start writing in your Souljar first.",
      });
    }

    const entriesText = entries
      .map((e, i) => {
        const parts = [];
        const dateStr = e.stamp || (e.createdAt ? e.createdAt.toISOString().split("T")[0] : "unknown");
        parts.push(`Date: ${dateStr}`);
        if (e.topic) parts.push(`Category: ${e.topic}`);
        if (e.mood) parts.push(`Mood: ${e.mood}`);
        if (e.activity) parts.push(`Activity/Trigger: ${e.activity}`);
        if (e.wordCount) parts.push(`Words written: ${e.wordCount}`);
        const entryText = (e.text || e.ocrText || "").substring(0, 600);
        if (entryText) parts.push(`Entry: ${entryText}`);
        return `[Entry ${i + 1}]\n${parts.join("\n")}`;
      })
      .join("\n\n---\n\n");

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const userMessage = `Here are the user's Souljar entries (${entries.length} total entries across their emotional journey):\n\n${entriesText}\n\nNow silently answer: Who is this person becoming? What emotional struggle appears most often? What are they avoiding? What do they secretly need? What emotional strength exists inside them?\n\nThen generate the complete Soulway Report as a JSON object following the structure in your instructions. Be deeply personal, compassionate, and insightful. Return ONLY the JSON object.`;

    const message = await anthropic.messages.create({
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

    const rawText = message.content[0].text.trim();
    // Strip any accidental markdown fences
    const jsonText = rawText.replace(/^```(?:json)?\n?/i, "").replace(/\n?```$/i, "");

    let report;
    try {
      report = JSON.parse(jsonText);
    } catch (_parseErr) {
      console.error("Soulway AI JSON parse failed:", jsonText.slice(0, 300));
      return res.status(500).json({ message: "AI returned invalid JSON. Please try again." });
    }

    res.json({
      success: true,
      entryCount: entries.length,
      generatedAt: new Date().toISOString(),
      report,
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