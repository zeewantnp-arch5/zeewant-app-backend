import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import connectDB from "./config/db.js";
import soulteeRoutes from "./routes/soulteeRoutes.js";
import souljarRoutes from "./routes/souljarRoutes.js";
import adminRoutes from "./routes/adminRoutes.js";
import settingsRoutes from "./routes/settingsRoutes.js";
import soulpanaRoutes from "./routes/soulpanaRoutes.js";
import soulteeDashboardRoutes from "./routes/soulteeDashboardRoutes.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

dotenv.config();
connectDB();

const app = express();

app.use(cors());
app.use(express.json());

app.use("/api/souljar", souljarRoutes);
app.use("/api/soultees", soulteeRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/settings", settingsRoutes);
app.use("/api/soulpana", soulpanaRoutes);
app.use("/api/soultee-dashboard", soulteeDashboardRoutes);
app.use(express.static(join(__dirname, "public")));

app.get("/", (req, res) => {
  res.send("Zeewant Backend Running...");
});

const PORT = process.env.PORT || 5000;

app.listen(PORT,"0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`);
});