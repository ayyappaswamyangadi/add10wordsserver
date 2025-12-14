import dotenv from "dotenv";
dotenv.config();

import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import cookie from "cookie";
import nodemailer from "nodemailer";
//import file
import User from "../models/User.js";

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  throw new Error("JWT_SECRET is not set");
}

const COOKIE_NAME = "token";
const COOKIE_MAX_AGE = 7 * 24 * 60 * 60;

function setTokenCookie(res, token) {
  res.setHeader(
    "Set-Cookie",
    cookie.serialize(COOKIE_NAME, token, {
      httpOnly: true,
      //   secure: true,
      sameSite: "none",
      maxAge: COOKIE_MAX_AGE,
      path: "/",
    })
  );
}

function clearTokenCookie(res) {
  res.setHeader(
    "Set-Cookie",
    cookie.serialize(COOKIE_NAME, "", {
      httpOnly: true,
      //   secure: true,
      sameSite: "none",
      expires: new Date(0),
      path: "/",
    })
  );
}

const SMTP_HOST = process.env.SMTP_HOST || "smtp.gmail.com";
const SMTP_PORT = Number(process.env.SMTP_PORT || 465);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const FROM_EMAIL = process.env.FROM_EMAIL || SMTP_USER;
const FRONTEND_BASE = process.env.CLIENT_URL || "http://localhost:5173";

function createTransport() {
  if (!SMTP_USER || !SMTP_PASS) return null;
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS,
    },
  });
}

async function sendVerificationEmail({ to, token, name }) {
  const transport = createTransport();
  if (!transport) return;

  const verifyUrl = `${FRONTEND_BASE.replace(
    /\/+$/,
    ""
  )}/verify-email?token=${encodeURIComponent(token)}`;

  await transport.sendMail({
    from: FROM_EMAIL,
    to,
    subject: "Verify your email",
    html: `
      <p>Hello ${name || to},</p>
      <p>Please verify your email:</p>
      <p><a href="${verifyUrl}">Verify email</a></p>
    `,
  });
}

// POST /auth/signup
router.post("/signup", async (req, res) => {
  const { email, password, name } = req.body;

  if (!email || !password || !name) {
    return res.status(400).json({ error: "Missing fields" });
  }

  const lowerEmail = email.toLowerCase();
  const existing = await User.findOne({ email: lowerEmail });
  if (existing) {
    return res.status(409).json({ error: "Email already registered" });
  }

  const passwordHash = await bcrypt.hash(password, 10);

  const verificationToken = jwt.sign(
    { email: lowerEmail, name, passwordHash },
    JWT_SECRET,
    { expiresIn: "24h" }
  );

  await sendVerificationEmail({
    to: lowerEmail,
    token: verificationToken,
    name,
  });

  res.json({
    ok: true,
    message: "Check your email to verify your account",
  });
});

// GET /auth/verify-email?token=...
router.get("/verify-email", async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).json({ error: "Token required" });

  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch {
    return res.status(400).json({ error: "Invalid or expired token" });
  }

  const { email, name, passwordHash } = payload;
  const lowerEmail = email.toLowerCase();

  let user = await User.findOne({ email: lowerEmail });

  if (!user) {
    user = await User.create({
      email: lowerEmail,
      name,
      passwordHash,
      isVerified: true,
    });
  } else {
    user.isVerified = true;
    await user.save();
  }

  const jwtToken = jwt.sign(
    {
      sub: user._id.toString(),
      email: user.email,
      name: user.name,
    },
    JWT_SECRET,
    { expiresIn: "7d" }
  );

  setTokenCookie(res, jwtToken);

  res.json({
    ok: true,
    user: {
      id: user._id.toString(),
      email: user.email,
      name: user.name,
    },
  });
});

// POST /auth/login
router.post("/login", async (req, res) => {
  const { email, password } = req.body;

  const user = await User.findOne({ email: email.toLowerCase() });
  if (!user) return res.status(401).json({ error: "Invalid credentials" });

  if (!user.isVerified) {
    return res.status(403).json({ error: "Email not verified" });
  }

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: "Invalid credentials" });

  const token = jwt.sign(
    {
      sub: user._id.toString(),
      email: user.email,
      name: user.name,
    },
    JWT_SECRET,
    { expiresIn: "7d" }
  );

  setTokenCookie(res, token);

  res.json({
    user: {
      id: user._id.toString(),
      email: user.email,
      name: user.name,
    },
  });
});

// GET /auth/me
router.get("/me", async (req, res) => {
  const cookies = req.headers.cookie ? cookie.parse(req.headers.cookie) : {};
  const token = cookies[COOKIE_NAME];

  if (!token) return res.json({ user: null });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = await User.findById(payload.sub).lean();

    if (!user) return res.json({ user: null });

    res.json({
      user: {
        id: user._id.toString(),
        email: user.email,
        name: user.name,
        isVerified: user.isVerified,
      },
    });
  } catch {
    clearTokenCookie(res);
    res.json({ user: null });
  }
});

// POST /auth/logout
router.post("/logout", (req, res) => {
  clearTokenCookie(res);
  res.json({ ok: true });
});

export default router;
