import express from "express";
import SoulMeterReading from "../models/SoulMeterReading.js";

const router = express.Router();

const EMOTIONS = ["stress", "anxiety", "sadness", "happiness", "neutral", "fatigue"];

function normalizeScores(rawScores = {}) {
  const clamped = {};

  for (const emotion of EMOTIONS) {
    const value = Number(rawScores[emotion]);
    clamped[emotion] = Number.isFinite(value)
      ? Math.min(100, Math.max(0, value))
      : 0;
  }

  const total = EMOTIONS.reduce((sum, key) => sum + clamped[key], 0);
  if (total <= 0) {
    const even = Number((100 / EMOTIONS.length).toFixed(2));
    const fallback = {};
    for (const emotion of EMOTIONS) {
      fallback[emotion] = even;
    }
    return fallback;
  }

  const normalized = {};
  for (const emotion of EMOTIONS) {
    normalized[emotion] = Number(((clamped[emotion] / total) * 100).toFixed(2));
  }

  return normalized;
}

router.post("/records", async (req, res) => {
  const {
    userId,
    primaryEmotion,
    scores,
    confidence,
    quality = {},
    detectedAt,
    consentToStore,
    source,
  } = req.body || {};

  if (!userId || typeof userId !== "string") {
    return res.status(400).json({ error: "userId is required." });
  }

  if (!consentToStore) {
    return res
      .status(400)
      .json({ error: "Consent is required before storing SoulMeter records." });
  }

  if (!EMOTIONS.includes(primaryEmotion)) {
    return res.status(400).json({ error: "primaryEmotion is invalid." });
  }

  const normalizedScores = normalizeScores(scores);

  try {
    const doc = await SoulMeterReading.create({
      userId: userId.trim(),
      primaryEmotion,
      scores: normalizedScores,
      confidence: Number.isFinite(Number(confidence))
        ? Math.min(1, Math.max(0, Number(confidence)))
        : 0.5,
      quality: {
        lowLight: Boolean(quality.lowLight),
        faceCount: Number.isFinite(Number(quality.faceCount))
          ? Math.max(0, Number(quality.faceCount))
          : 1,
        inferenceVersion:
          typeof quality.inferenceVersion === "string" &&
          quality.inferenceVersion.trim().length > 0
            ? quality.inferenceVersion.trim()
            : "mlkit-heuristic-v1",
      },
      source:
        typeof source === "string" && source.trim().length > 0
          ? source.trim()
          : "mobile-realtime",
      detectedAt: detectedAt ? new Date(detectedAt) : new Date(),
      consentToStore: true,
    });

    return res.status(201).json({
      id: doc._id,
      userId: doc.userId,
      primaryEmotion: doc.primaryEmotion,
      scores: doc.scores,
      confidence: doc.confidence,
      quality: doc.quality,
      detectedAt: doc.detectedAt,
      createdAt: doc.createdAt,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

router.get("/records/:userId", async (req, res) => {
  const { userId } = req.params;
  const limitParam = Number.parseInt(String(req.query.limit ?? "20"), 10);
  const limit = Number.isFinite(limitParam)
    ? Math.min(100, Math.max(1, limitParam))
    : 20;

  try {
    const docs = await SoulMeterReading.find({ userId })
      .sort({ detectedAt: -1 })
      .limit(limit)
      .lean();

    return res.status(200).json(docs);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

export default router;
