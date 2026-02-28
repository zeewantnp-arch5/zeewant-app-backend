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
    const entries = await Souljar.find({
      userId: req.params.userId,
    });

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
      totalEntries: entries.length,
      totalWords,
      moodDistribution: moodCount,
      activityDistribution: activityCount,
      topicDistribution: topicCount,
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
      latestEntries: entries.slice(0, 5),
      jarCodes: entries.slice(0, 10).map((entry) => entry.jarCode),
    });
  } catch (error) {
    console.error("Summary Report Error:", error);
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