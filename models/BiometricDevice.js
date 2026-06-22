import mongoose from "mongoose";

const biometricDeviceSchema = new mongoose.Schema(
  {
    phone:       { type: String, required: true, unique: true, index: true },
    firebaseUid: { type: String, required: true, index: true },
  },
  { timestamps: true }
);

export default mongoose.model("BiometricDevice", biometricDeviceSchema);
