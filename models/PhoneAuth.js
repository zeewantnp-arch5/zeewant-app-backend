import mongoose from "mongoose";

const phoneAuthSchema = new mongoose.Schema(
  {
    phone:        { type: String, required: true, unique: true, index: true }, // e.g. +9779861174461
    firebaseUid:  { type: String, required: true, index: true },
    passwordHash: { type: String, required: true },
  },
  { timestamps: true }
);

export default mongoose.model("PhoneAuth", phoneAuthSchema);
