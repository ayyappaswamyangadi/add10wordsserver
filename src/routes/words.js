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
 * Module-level flag to avoid re-running index creation
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

/**
 * Shared validation logic
 */
async function validateWords(words) {
  const { cleaned, lowers } = normalizeList(words);

  if (cleaned.length !== 10) {
    return {
      ok: false,
      status: 400,
      error: `Exactly 10 words required. Received ${cleaned.length}.`,
      conflicts: conflictsObj([], []),
    };
  }

  // in-batch duplicates
  const counts = new Map();
  lowers.forEach((l) => counts.set(l, (counts.get(l) || 0) + 1));
  const inBatch = [...counts.entries()]
    .filter(([, c]) => c > 1)
    .map(([k]) => k);

  // DB conflicts
  const found = await Word.find(
    { wordLower: { $in: lowers } },
    { wordLower: 1 }
  ).lean();

  const existingLower = [
    ...new Set(found.map((d) => d.wordLower.toLowerCase())),
  ];

  if (existingLower.length === 0 && inBatch.length === 0) {
    return {
      ok: true,
      cleaned,
      lowers,
      conflicts: conflictsObj([], []),
    };
  }

  return {
    ok: false,
    conflicts: conflictsObj(existingLower, inBatch),
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
// POST /api/words/validate
// =====================================================
router.post("/validate", async (req, res) => {
  try {
    const result = await validateWords(req.body?.words);
    if (!result.ok) {
      return res.status(result.status || 200).json(result);
    }

    res.json({
      ok: true,
      message: "No conflicts",
      conflicts: result.conflicts,
    });
  } catch (err) {
    console.error("Validation failed:", err);
    res.status(500).json({ error: "Validation failed" });
  }
});

// =====================================================
// POST /api/words
// =====================================================
router.post("/", async (req, res) => {
  try {
    const result = await validateWords(req.body?.words);

    if (!result.ok) {
      return res.status(409).json({
        error: "Conflicts found. Fix duplicates before submitting.",
        conflicts: result.conflicts,
      });
    }

    const docs = result.cleaned.map((w) => ({
      userId: req.user.id,
      word: w,
      wordLower: w.toLowerCase(),
      addedAt: new Date(),
    }));

    const inserted = await Word.insertMany(docs, { ordered: true });
    res.json({ added: inserted.length });
  } catch (err) {
    console.error("Insert failed:", err);

    if (err.code === 11000) {
      return res.status(409).json({
        error: "One or more words already exist",
      });
    }

    res.status(500).json({ error: "Insert failed" });
  }
});

// =====================================================
// GET /api/words
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

    const owners = await User.find(
      { _id: { $in: userIds } },
      { name: 1, email: 1 }
    ).lean();

    const ownerMap = Object.fromEntries(
      owners.map((u) => [String(u._id), u.name?.trim() || u.email])
    );

    const attachOwner = (docs) =>
      docs.map((d) => ({
        _id: String(d._id),
        word: d.word,
        wordLower: d.wordLower,
        userId: String(d.userId),
        addedAt: d.addedAt?.toISOString(),
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
