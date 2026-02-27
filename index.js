import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import connectDB from "./config/db.js";
import soulteeRoutes from "./routes/soulteeRoutes.js";
import souljarRoutes from "./routes/souljarRoutes.js";

dotenv.config();
connectDB();

const app = express();

app.use(cors());
app.use(express.json());

app.use("/api/souljar", souljarRoutes);

app.get("/", (req, res) => {
  res.send("Zeewant Backend Running...");
});

app.use("/api/soultees", soulteeRoutes);

const PORT = process.env.PORT || 5000;

app.listen(PORT,"0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`);
});