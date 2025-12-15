import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
// import rateLimit from "express-rate-limit";

import { connectDB } from "../src/lib/mongodb.js";
//routes
import authRoutes from "./routes/auth.js";
import wordsRoutes from "./routes/words.js";

const app = express();

app.use(helmet());
app.use(express.json());
app.use(cookieParser());

app.use(
  cors({
    origin: process.env.CLIENT_URL,
    credentials: true,
  })
);

// app.use(
//   rateLimit({
//     windowMs: 60 * 1000,
//     max: 120,
//   })
// );

await connectDB(process.env.MONGODB_URI);

app.use("/api/auth", authRoutes);
app.use("/api/words", wordsRoutes);

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
});
