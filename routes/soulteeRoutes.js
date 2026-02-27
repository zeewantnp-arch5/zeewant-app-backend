import express from "express";
import Soultee from "../models/Soultee.js";

const router = express.Router();

router.get("/", async (req, res) => {
  try {
    const soultees = await Soultee.find();
    res.json(soultees);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

export default router;