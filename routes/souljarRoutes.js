import express from "express";
import mongoose from "mongoose";
import Souljar from "../models/souljar.js";

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
    const { period = "daily", date, category } = req.query;

    const makeStartOfUtcDay = (d) => {
      const day = new Date(d);
      day.setUTCHours(0, 0, 0, 0);
      return day;
    };

    const parsedDate = date ? new Date(`${date}T00:00:00.000Z`) : new Date();
    const anchor = Number.isNaN(parsedDate.getTime()) ? new Date() : parsedDate;

    let start;
    let end;
    let slots;

    if (period === "weekly") {
      const dayOfWeek = anchor.getUTCDay();
      const daysSinceMonday = (dayOfWeek + 6) % 7;
      start = makeStartOfUtcDay(anchor);
      start.setUTCDate(start.getUTCDate() - daysSinceMonday);
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
      start = makeStartOfUtcDay(anchor);
      end = new Date(start);
      end.setUTCDate(end.getUTCDate() + 1);

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
      const timestamp = new Date(entry.createdAt);
      let slotIndex;

      if (period === "weekly") {
        slotIndex = (timestamp.getUTCDay() + 6) % 7;
      } else {
        slotIndex = timestamp.getUTCHours();
      }

      if (slots[slotIndex]) {
        slots[slotIndex].entries += 1;
        slots[slotIndex].words += entry.wordCount || 0;
      }
    });

    const totalEntries = entries.length;
    const totalWords = entries.reduce((sum, e) => sum + (e.wordCount || 0), 0);

    res.json({
      userId,
      period,
      category: category || "All",
      rangeStart: start.toISOString(),
      rangeEnd: end.toISOString(),
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

export default router;