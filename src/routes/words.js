// backend/routes/words.js
import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cookie from "cookie";
import jwt from "jsonwebtoken";

import Word from "../models/Word.js";
import User from "../models/User.js";

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error("Missing JWT_SECRET in environment");
}

/**
 * Module-level flag to avoid re-running index creation on every invocation
 */
let indexEnsured = false;
async function ensureWordLowerIndexOnce() {
  if (indexEnsured) return;
  try {
    await Word.collection.createIndex({ wordLower: 1 }, { unique: true });
    indexEnsured = true;
  } catch (e) {
    console.warn(
      "Could not create unique index on wordLower (continuing):",
      e?.message || e
    );
  }
}

// --------------------
// Helpers
// --------------------
async function getUserFromReq(req) {
  const cookies = req.headers.cookie ? cookie.parse(req.headers.cookie) : {};
  const token = cookies.token;
  if (!token) return null;
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    return { id: payload.sub, email: payload.email, name: payload.name };
  } catch {
    return null;
  }
}

function normalizeList(items = []) {
  const cleaned = Array.isArray(items)
    ? items.map((s) => String(s || "").trim()).filter(Boolean)
    : [];
  const lowers = cleaned.map((s) => s.toLowerCase());
  return { cleaned, lowers };
}

function conflictsObj(db = [], inBatch = []) {
  return {
    db: Array.from(new Set(db.map((s) => s.toLowerCase()))),
    inBatch: Array.from(new Set(inBatch.map((s) => s.toLowerCase()))),
  };
}

// --------------------
// Auth middleware
// --------------------
router.use(async (req, res, next) => {
  try {
    ensureWordLowerIndexOnce().catch(() => {});
  } catch (err) {
    console.error("DB connection failed:", err);
    return res.status(500).json({ error: "DB connection failed" });
  }

  const user = await getUserFromReq(req);
  if (!user) {
    return res.status(401).json({ error: "Missing token" });
  }

  req.user = user;
  next();
});

// =====================================================
// POST /api/words
// - validate or submit words
// =====================================================
router.post("/", async (req, res) => {
  const action = String(req.query?.action ?? "").toLowerCase();
  const items = Array.isArray(req.body?.words) ? req.body.words : [];

  const { cleaned, lowers } = normalizeList(items);

  if (cleaned.length !== 10) {
    return res.status(400).json({
      error: `Exactly 10 words required. Received ${cleaned.length}.`,
      conflicts: conflictsObj([], []),
    });
  }

  // in-batch duplicates
  const counts = new Map();
  lowers.forEach((l) => counts.set(l, (counts.get(l) || 0) + 1));
  const inBatch = [...counts.entries()]
    .filter(([, c]) => c > 1)
    .map(([k]) => k);

  // check DB conflicts
  let existingLower = [];
  try {
    const found = await Word.find(
      { wordLower: { $in: lowers } },
      { wordLower: 1 }
    ).lean();
    existingLower = [...new Set(found.map((d) => d.wordLower.toLowerCase()))];
  } catch (err) {
    console.error("DB fetch failed:", err);
    return res.status(500).json({ error: "DB fetch failed" });
  }

  // VALIDATE ONLY
  if (action === "validate") {
    if (existingLower.length === 0 && inBatch.length === 0) {
      return res.json({
        ok: true,
        message: "No conflicts",
        conflicts: conflictsObj([], []),
      });
    }
    return res.json({
      ok: false,
      message: "Conflicts found",
      conflicts: conflictsObj(existingLower, inBatch),
    });
  }

  // SUBMIT
  if (existingLower.length > 0 || inBatch.length > 0) {
    return res.status(409).json({
      error: "Conflicts found. Fix duplicates before submitting.",
      conflicts: conflictsObj(existingLower, inBatch),
    });
  }

  const docs = cleaned.map((w) => ({
    userId: req.user.id,
    word: w,
    wordLower: w.toLowerCase(),
    addedAt: new Date(),
  }));

  try {
    const inserted = await Word.insertMany(docs, { ordered: true });
    return res.json({ added: inserted.length });
  } catch (err) {
    console.error("Insert failed:", err);
    if (err.code === 11000) {
      const nowExisting = await Word.find(
        { wordLower: { $in: lowers } },
        { wordLower: 1 }
      ).lean();
      return res.status(409).json({
        error: "One or more words already exist",
        conflicts: conflictsObj(
          nowExisting.map((d) => d.wordLower),
          []
        ),
      });
    }
    return res.status(500).json({ error: "Insert failed" });
  }
});

// =====================================================
// GET /api/words
// - return mine + all
// =====================================================
router.get("/", async (req, res) => {
  const { sort = "date-desc", from, to, q = "" } = req.query;

  const mineFilter = { userId: req.user.id };
  if (from)
    mineFilter.addedAt = { ...mineFilter.addedAt, $gte: new Date(from) };
  if (to)
    mineFilter.addedAt = {
      ...mineFilter.addedAt,
      $lte: new Date(`${to}T23:59:59`),
    };
  if (q) mineFilter.wordLower = { $regex: q.toLowerCase(), $options: "i" };

  const globalFilter = {};
  if (q) globalFilter.wordLower = { $regex: q.toLowerCase(), $options: "i" };

  let sortSpec = { addedAt: -1 };
  if (sort === "date-asc") sortSpec = { addedAt: 1 };
  if (sort === "alpha-asc") sortSpec = { wordLower: 1 };
  if (sort === "alpha-desc") sortSpec = { wordLower: -1 };

  try {
    const [mineDocs, allDocs] = await Promise.all([
      Word.find(mineFilter).sort(sortSpec).limit(2000).lean(),
      Word.find(globalFilter).sort(sortSpec).limit(5000).lean(),
    ]);

    const userIds = [
      ...new Set(allDocs.map((w) => String(w.userId)).filter(Boolean)),
    ];

    let ownerMap = {};
    if (userIds.length > 0) {
      const owners = await User.find(
        { _id: { $in: userIds } },
        { name: 1, email: 1 }
      ).lean();

      ownerMap = Object.fromEntries(
        owners.map((u) => [String(u._id), u.name?.trim() || u.email])
      );
    }

    const attachOwner = (docs) =>
      docs.map((d) => ({
        _id: String(d._id),
        word: d.word,
        wordLower: d.wordLower,
        userId: d.userId ? String(d.userId) : undefined,
        addedAt: d.addedAt ? new Date(d.addedAt).toISOString() : null,
        ownerName: ownerMap[String(d.userId)] || "Unknown",
      }));

    res.json({
      mine: attachOwner(mineDocs),
      all: attachOwner(allDocs),
    });
  } catch (err) {
    console.error("Fetch failed:", err);
    res.status(500).json({ error: "Fetch failed" });
  }
});

export default router;
