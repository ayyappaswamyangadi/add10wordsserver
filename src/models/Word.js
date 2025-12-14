// backend/models/Word.js
import mongoose from "mongoose";

const wordSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  word: { type: String, required: true },
  wordLower: { type: String, required: true },
  addedAt: { type: Date, default: () => new Date() },
  learned: { type: Boolean, default: false },
  notes: { type: String, default: "" },
});

// GLOBAL uniqueness — no two documents may have the same wordLower.
wordSchema.index({ wordLower: 1 }, { unique: true });

const Word = mongoose.models?.Word || mongoose.model("Word", wordSchema);
export default Word;
