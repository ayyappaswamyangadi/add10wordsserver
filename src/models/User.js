// backend/models/User.js
import mongoose from "mongoose";

const userSchema = new mongoose.Schema({
  name: { type: String, required: false, trim: true },
  email: {
    type: String,
    required: true,
    trim: true,
    lowercase: true,
    index: true,
  },
  passwordHash: { type: String, required: true },
  isVerified: { type: Boolean, default: false, index: true },
  verificationToken: { type: String, default: null },
  verificationExpires: { type: Date, default: null },
  createdAt: { type: Date, default: () => new Date() },
});

// Unique email
userSchema.index({ email: 1 }, { unique: true });

const User = mongoose.models?.User || mongoose.model("User", userSchema);
export default User;
