import mongoose from "mongoose";

mongoose.connection.on("disconnected", () =>
  console.warn("[MongoDB] disconnected — will auto-reconnect")
);
mongoose.connection.on("reconnected", () =>
  console.log("[MongoDB] reconnected")
);
mongoose.connection.on("error", (err) =>
  console.error("[MongoDB] error:", err.message)
);

const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, {
      maxPoolSize: 10,          // max concurrent connections
      minPoolSize: 2,           // keep 2 warm to avoid cold-connection latency
      serverSelectionTimeoutMS: 10000,
      connectTimeoutMS: 10000,
      socketTimeoutMS: 45000,
      heartbeatFrequencyMS: 10000,
    });
    console.log("MongoDB connected successfully");
  } catch (error) {
    console.error("MongoDB connection failed:", error.message);
    process.exit(1);
  }
};

export default connectDB;