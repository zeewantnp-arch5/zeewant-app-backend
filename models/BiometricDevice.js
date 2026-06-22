import mongoose from "mongoose";

const biometricDeviceSchema = new mongoose.Schema(
  {
    firebaseUid: { type: String, required: true, unique: true, index: true },
  },
  { timestamps: true }
);

export default mongoose.model("BiometricDevice", biometricDeviceSchema);
