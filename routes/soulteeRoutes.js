import express from "express";
import Soultee from "../models/Soultee.js";
import { getSoulteeDirectory } from "../services/connectionService.js";

const router = express.Router();

// ─── GET /api/soultees  ───────────────────────────────────────────────────────
// Query params: status (online|offline|busy), gender, specialization
router.get("/", async (req, res) => {
  try {
    const filter = {};
    if (req.query.status)         filter.status         = req.query.status;
    if (req.query.gender)         filter.gender         = req.query.gender;
    if (req.query.specialization) filter.specialization = new RegExp(req.query.specialization, "i");

    const soultees = await getSoulteeDirectory(req.query.studentUid, filter);

    res.json(soultees);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ─── GET /api/soultees/:id  ───────────────────────────────────────────────────
router.get("/:id", async (req, res) => {
  try {
    const soultee = await Soultee.findById(req.params.id).select("-__v").lean();
    if (!soultee) return res.status(404).json({ message: "Soultee not found" });
    res.json(soultee);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

export default router;
