import mongoose from "mongoose";
import dns from "dns";

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
  const dnsServers = process.env.MONGO_DNS_SERVERS
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (dnsServers?.length) {
    try {
      dns.setServers(dnsServers);
      console.log(`MongoDB DNS servers: ${dns.getServers().join(", ")}`);
    } catch (dnsError) {
      console.warn("Invalid MONGO_DNS_SERVERS value:", dnsError.message);
    }
  }

  const primaryUri = process.env.MONGO_URI?.trim();
  const fallbackUri = process.env.MONGO_URI_FALLBACK?.trim();
  const retryDelayMs = Number(process.env.MONGO_RETRY_DELAY_MS || 10000);

  if (!primaryUri) {
    console.error("MongoDB connection failed: MONGO_URI is not set");
    process.exit(1);
  }

  const connectOptions = {
    maxPoolSize: 10,          // max concurrent connections
    minPoolSize: 2,           // keep 2 warm to avoid cold-connection latency
    serverSelectionTimeoutMS: 10000,
    connectTimeoutMS: 10000,
    socketTimeoutMS: 45000,
    heartbeatFrequencyMS: 10000,
  };

  while (true) {
    try {
      await mongoose.connect(primaryUri, connectOptions);
      console.log("MongoDB connected successfully");
      return;
    } catch (error) {
      const isSrvDnsFailure =
        primaryUri.startsWith("mongodb+srv://") &&
        /querySrv|ENOTFOUND|ECONNREFUSED/i.test(error.message);

      if (isSrvDnsFailure && fallbackUri) {
        console.warn(
          "MongoDB SRV DNS lookup failed. Retrying with MONGO_URI_FALLBACK..."
        );
        try {
          await mongoose.connect(fallbackUri, connectOptions);
          console.log("MongoDB connected successfully (fallback URI)");
          return;
        } catch (fallbackError) {
          console.error(
            "MongoDB fallback connection failed:",
            fallbackError.message
          );
        }
      }

      console.error("MongoDB connection failed:", error.message);
      if (isSrvDnsFailure && !fallbackUri) {
        console.error(
          "Tip: set MONGO_URI_FALLBACK (mongodb://...) if your network blocks DNS SRV lookups."
        );
      }

      console.warn(`Retrying MongoDB connection in ${retryDelayMs}ms...`);
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
};

export default connectDB;