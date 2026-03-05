require("dotenv").config();

const path = require("path");
const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");

const app = express();
const PORT = Number(process.env.PORT || 8080);
const JWT_SECRET = process.env.JWT_SECRET || "change_this_secret";

function parseBool(value, fallback = false) {
  if (value === undefined) return fallback;
  return String(value).toLowerCase() === "true";
}

function getDbConfig() {
  const sslEnabled = parseBool(process.env.DB_SSL, false);

  if (process.env.DATABASE_URL) {
    return {
      connectionString: process.env.DATABASE_URL,
      ssl: sslEnabled ? { rejectUnauthorized: false } : false,
    };
  }

  return {
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: sslEnabled ? { rejectUnauthorized: false } : false,
  };
}

const pool = new Pool(getDbConfig());

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false }));

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function mapUser(row) {
  return {
    id: row.id,
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function buildUserInitials(firstName, lastName, email) {
  const first = String(firstName || "").trim().charAt(0);
  const last = String(lastName || "").trim().charAt(0);
  if (first || last) return `${first}${last}`.toUpperCase() || "GS";

  const localPart = normalizeEmail(email).split("@")[0];
  return (localPart.slice(0, 2) || "GS").toUpperCase();
}

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization || "";

  if (!authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing or invalid auth token." });
  }

  const token = authHeader.slice(7);

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.auth = {
      userId: Number(payload.sub),
      email: payload.email,
    };
    return next();
  } catch (_error) {
    return res.status(401).json({ error: "Token expired or invalid." });
  }
}

function createToken(user) {
  return jwt.sign(
    {
      sub: String(user.id),
      email: user.email,
    },
    JWT_SECRET,
    { expiresIn: "7d" }
  );
}

async function ensureSchema() {
  const sql = `
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      first_name VARCHAR(120) NOT NULL,
      last_name VARCHAR(120) NOT NULL,
      email VARCHAR(255) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS locations (
      id BIGSERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      lat DOUBLE PRECISION NOT NULL,
      lng DOUBLE PRECISION NOT NULL,
      accuracy DOUBLE PRECISION,
      tracked_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `;

  await pool.query(sql);
}

async function createUser({ firstName, lastName, email, password }) {
  const normalizedEmail = normalizeEmail(email);

  if (!firstName || !lastName || !normalizedEmail || !password) {
    const error = new Error("Missing required fields.");
    error.status = 400;
    throw error;
  }

  if (!isValidEmail(normalizedEmail)) {
    const error = new Error("Invalid email format.");
    error.status = 400;
    throw error;
  }

  if (String(password).length < 6) {
    const error = new Error("Password must have at least 6 characters.");
    error.status = 400;
    throw error;
  }

  const passwordHash = await bcrypt.hash(password, 10);

  try {
    const { rows } = await pool.query(
      `
        INSERT INTO users (first_name, last_name, email, password_hash)
        VALUES ($1, $2, $3, $4)
        RETURNING id, first_name, last_name, email, created_at, updated_at
      `,
      [String(firstName).trim(), String(lastName).trim(), normalizedEmail, passwordHash]
    );

    return rows[0];
  } catch (error) {
    if (error.code === "23505") {
      const duplicate = new Error("Email already registered.");
      duplicate.status = 409;
      throw duplicate;
    }

    throw error;
  }
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

// Create user (Cadastro)
app.post("/api/users", async (req, res) => {
  try {
    const created = await createUser(req.body);
    const user = mapUser(created);
    return res.status(201).json({
      user: {
        ...user,
        initials: buildUserInitials(user.firstName, user.lastName, user.email),
      },
    });
  } catch (error) {
    const status = error.status || 500;
    return res.status(status).json({ error: error.message || "Failed to create user." });
  }
});

// Login real
app.post("/api/auth/login", async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const password = String(req.body.password || "");

  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required." });
  }

  try {
    const { rows } = await pool.query(
      `
        SELECT id, first_name, last_name, email, password_hash, created_at, updated_at
        FROM users
        WHERE email = $1
      `,
      [email]
    );

    if (!rows[0]) {
      return res.status(401).json({ error: "Invalid credentials." });
    }

    const match = await bcrypt.compare(password, rows[0].password_hash);

    if (!match) {
      return res.status(401).json({ error: "Invalid credentials." });
    }

    const user = mapUser(rows[0]);
    const token = createToken(user);

    return res.json({
      token,
      user: {
        ...user,
        initials: buildUserInitials(user.firstName, user.lastName, user.email),
      },
    });
  } catch (error) {
    return res.status(500).json({ error: "Failed to login." });
  }
});

app.get("/api/auth/me", authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `
        SELECT id, first_name, last_name, email, created_at, updated_at
        FROM users
        WHERE id = $1
      `,
      [req.auth.userId]
    );

    if (!rows[0]) {
      return res.status(404).json({ error: "User not found." });
    }

    const user = mapUser(rows[0]);
    return res.json({
      user: {
        ...user,
        initials: buildUserInitials(user.firstName, user.lastName, user.email),
      },
    });
  } catch (_error) {
    return res.status(500).json({ error: "Failed to fetch current user." });
  }
});

// READ all users
app.get("/api/users", authMiddleware, async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `
        SELECT id, first_name, last_name, email, created_at, updated_at
        FROM users
        ORDER BY id DESC
      `
    );

    return res.json({ users: rows.map(mapUser) });
  } catch (_error) {
    return res.status(500).json({ error: "Failed to list users." });
  }
});

// READ one user
app.get("/api/users/:id", authMiddleware, async (req, res) => {
  const id = Number(req.params.id);

  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: "Invalid user id." });
  }

  try {
    const { rows } = await pool.query(
      `
        SELECT id, first_name, last_name, email, created_at, updated_at
        FROM users
        WHERE id = $1
      `,
      [id]
    );

    if (!rows[0]) {
      return res.status(404).json({ error: "User not found." });
    }

    return res.json({ user: mapUser(rows[0]) });
  } catch (_error) {
    return res.status(500).json({ error: "Failed to fetch user." });
  }
});

// UPDATE user
app.put("/api/users/:id", authMiddleware, async (req, res) => {
  const id = Number(req.params.id);

  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: "Invalid user id." });
  }

  if (req.auth.userId !== id) {
    return res.status(403).json({ error: "You can only update your own account." });
  }

  const firstName = req.body.firstName ? String(req.body.firstName).trim() : null;
  const lastName = req.body.lastName ? String(req.body.lastName).trim() : null;
  const email = req.body.email ? normalizeEmail(req.body.email) : null;
  const password = req.body.password ? String(req.body.password) : null;

  if (email && !isValidEmail(email)) {
    return res.status(400).json({ error: "Invalid email format." });
  }

  if (password && password.length < 6) {
    return res.status(400).json({ error: "Password must have at least 6 characters." });
  }

  try {
    const currentRes = await pool.query(
      `SELECT id, first_name, last_name, email, password_hash FROM users WHERE id = $1`,
      [id]
    );

    if (!currentRes.rows[0]) {
      return res.status(404).json({ error: "User not found." });
    }

    const current = currentRes.rows[0];
    const nextPasswordHash = password ? await bcrypt.hash(password, 10) : current.password_hash;

    const { rows } = await pool.query(
      `
        UPDATE users
        SET first_name = $1,
            last_name = $2,
            email = $3,
            password_hash = $4,
            updated_at = NOW()
        WHERE id = $5
        RETURNING id, first_name, last_name, email, created_at, updated_at
      `,
      [
        firstName || current.first_name,
        lastName || current.last_name,
        email || current.email,
        nextPasswordHash,
        id,
      ]
    );

    return res.json({ user: mapUser(rows[0]) });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({ error: "Email already in use." });
    }

    return res.status(500).json({ error: "Failed to update user." });
  }
});

// DELETE user
app.delete("/api/users/:id", authMiddleware, async (req, res) => {
  const id = Number(req.params.id);

  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: "Invalid user id." });
  }

  if (req.auth.userId !== id) {
    return res.status(403).json({ error: "You can only delete your own account." });
  }

  try {
    const result = await pool.query("DELETE FROM users WHERE id = $1", [id]);

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "User not found." });
    }

    return res.status(204).send();
  } catch (_error) {
    return res.status(500).json({ error: "Failed to delete user." });
  }
});

// Track location in DB
app.post("/api/location", authMiddleware, async (req, res) => {
  const lat = Number(req.body.lat);
  const lng = Number(req.body.lng);
  const accuracy = req.body.accuracy === undefined ? null : Number(req.body.accuracy);
  const trackedAt = req.body.timestamp ? new Date(req.body.timestamp) : new Date();

  if (Number.isNaN(lat) || Number.isNaN(lng)) {
    return res.status(400).json({ error: "Invalid lat/lng values." });
  }

  if (Number.isNaN(trackedAt.getTime())) {
    return res.status(400).json({ error: "Invalid timestamp value." });
  }

  try {
    await pool.query(
      `
        INSERT INTO locations (user_id, lat, lng, accuracy, tracked_at)
        VALUES ($1, $2, $3, $4, $5)
      `,
      [req.auth.userId, lat, lng, Number.isNaN(accuracy) ? null : accuracy, trackedAt.toISOString()]
    );

    return res.status(201).json({ ok: true });
  } catch (_error) {
    return res.status(500).json({ error: "Failed to save location." });
  }
});

app.use(express.static(path.join(__dirname)));

app.get("*", (req, res) => {
  if (req.path.startsWith("/api/")) {
    return res.status(404).json({ error: "API route not found." });
  }

  return res.sendFile(path.join(__dirname, "index.html"));
});

async function startServer() {
  try {
    await ensureSchema();
    await pool.query("SELECT 1");

    app.listen(PORT, () => {
      // eslint-disable-next-line no-console
      console.log(`GeoTracker running on port ${PORT}`);
    });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("Failed to start server:", error.message);
    process.exit(1);
  }
}

startServer();
