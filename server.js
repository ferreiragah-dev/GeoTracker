require("dotenv").config();

const path = require("path");
const crypto = require("crypto");
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

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return String(value).trim();
    }
  }
  return null;
}

function getDbConfig() {
  const connectionString = firstDefined(
    process.env.DATABASE_URL,
    process.env.DB_URL,
    process.env.POSTGRES_URL,
    process.env.POSTGRESQL_URL
  );

  const sslFromUrl = /sslmode=require/i.test(connectionString || "");
  const sslEnabled = parseBool(process.env.DB_SSL, sslFromUrl);

  if (connectionString) {
    return {
      connectionString,
      ssl: sslEnabled ? { rejectUnauthorized: false } : false,
    };
  }

  const host = firstDefined(process.env.DB_HOST);
  const user = firstDefined(process.env.DB_USER);
  const password = firstDefined(process.env.DB_PASSWORD);
  const database = firstDefined(process.env.DB_NAME);
  const missing = [];

  if (!host) missing.push("DB_HOST");
  if (!user) missing.push("DB_USER");
  if (!password) missing.push("DB_PASSWORD");
  if (!database) missing.push("DB_NAME");

  if (missing.length > 0) {
    throw new Error(
      `Database env missing: ${missing.join(", ")}. Configure DATABASE_URL or DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME.`
    );
  }

  return {
    host,
    port: Number(process.env.DB_PORT || 5432),
    user,
    password,
    database,
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

function mapCircle(row, currentUserId) {
  return {
    id: row.id,
    name: row.name,
    inviteCode: row.invite_code,
    ownerUserId: row.owner_user_id,
    memberCount: Number(row.member_count || 0),
    createdAt: row.created_at,
    isOwner: Number(row.owner_user_id) === Number(currentUserId),
  };
}

function generateInviteCode() {
  return crypto.randomBytes(16).toString("hex");
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

    CREATE TABLE IF NOT EXISTS circles (
      id SERIAL PRIMARY KEY,
      name VARCHAR(120) NOT NULL,
      owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      invite_code VARCHAR(64) UNIQUE NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS circle_members (
      circle_id INTEGER NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role VARCHAR(20) NOT NULL DEFAULT 'member',
      joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY(circle_id, user_id)
    );

    CREATE INDEX IF NOT EXISTS idx_circle_members_user_id ON circle_members(user_id);
    CREATE INDEX IF NOT EXISTS idx_locations_user_tracked_at ON locations(user_id, tracked_at DESC);
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

// Create circle
app.post("/api/circles", authMiddleware, async (req, res) => {
  const name = String(req.body.name || "").trim();

  if (!name) {
    return res.status(400).json({ error: "Circle name is required." });
  }

  if (name.length > 120) {
    return res.status(400).json({ error: "Circle name must have at most 120 chars." });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const inviteCode = generateInviteCode();
    const circleResult = await client.query(
      `
        INSERT INTO circles (name, owner_user_id, invite_code)
        VALUES ($1, $2, $3)
        RETURNING id, name, owner_user_id, invite_code, created_at
      `,
      [name, req.auth.userId, inviteCode]
    );

    const circle = circleResult.rows[0];

    await client.query(
      `
        INSERT INTO circle_members (circle_id, user_id, role)
        VALUES ($1, $2, 'owner')
      `,
      [circle.id, req.auth.userId]
    );

    await client.query("COMMIT");

    return res.status(201).json({
      circle: {
        ...mapCircle(circle, req.auth.userId),
        memberCount: 1,
      },
    });
  } catch (_error) {
    await client.query("ROLLBACK");
    return res.status(500).json({ error: "Failed to create circle." });
  } finally {
    client.release();
  }
});

// Join circle via invite code
app.post("/api/circles/join", authMiddleware, async (req, res) => {
  const inviteCode = String(req.body.inviteCode || "").trim();

  if (!inviteCode) {
    return res.status(400).json({ error: "Invite code is required." });
  }

  try {
    const circleResult = await pool.query(
      `
        SELECT id, name, owner_user_id, invite_code, created_at
        FROM circles
        WHERE invite_code = $1
      `,
      [inviteCode]
    );

    if (!circleResult.rows[0]) {
      return res.status(404).json({ error: "Invite link is invalid." });
    }

    const circle = circleResult.rows[0];

    await pool.query(
      `
        INSERT INTO circle_members (circle_id, user_id, role)
        VALUES ($1, $2, 'member')
        ON CONFLICT (circle_id, user_id) DO NOTHING
      `,
      [circle.id, req.auth.userId]
    );

    const countResult = await pool.query(
      `
        SELECT COUNT(*)::int AS member_count
        FROM circle_members
        WHERE circle_id = $1
      `,
      [circle.id]
    );

    return res.json({
      circle: {
        ...mapCircle(
          {
            ...circle,
            member_count: countResult.rows[0].member_count,
          },
          req.auth.userId
        ),
      },
    });
  } catch (_error) {
    return res.status(500).json({ error: "Failed to join circle." });
  }
});

// List circles for current user
app.get("/api/circles", authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `
        SELECT
          c.id,
          c.name,
          c.owner_user_id,
          c.invite_code,
          c.created_at,
          COUNT(cm2.user_id)::int AS member_count
        FROM circle_members cm
        JOIN circles c ON c.id = cm.circle_id
        LEFT JOIN circle_members cm2 ON cm2.circle_id = c.id
        WHERE cm.user_id = $1
        GROUP BY c.id
        ORDER BY c.created_at DESC
      `,
      [req.auth.userId]
    );

    return res.json({
      circles: rows.map((row) => mapCircle(row, req.auth.userId)),
    });
  } catch (_error) {
    return res.status(500).json({ error: "Failed to list circles." });
  }
});

// Circle members + last known locations
app.get("/api/circles/:id/members/locations", authMiddleware, async (req, res) => {
  const circleId = Number(req.params.id);

  if (!Number.isInteger(circleId)) {
    return res.status(400).json({ error: "Invalid circle id." });
  }

  try {
    const membershipCheck = await pool.query(
      `
        SELECT 1
        FROM circle_members
        WHERE circle_id = $1 AND user_id = $2
      `,
      [circleId, req.auth.userId]
    );

    if (!membershipCheck.rows[0]) {
      return res.status(403).json({ error: "You are not a member of this circle." });
    }

    const circleResult = await pool.query(
      `
        SELECT
          c.id,
          c.name,
          c.owner_user_id,
          c.invite_code,
          c.created_at,
          COUNT(cm.user_id)::int AS member_count
        FROM circles c
        LEFT JOIN circle_members cm ON cm.circle_id = c.id
        WHERE c.id = $1
        GROUP BY c.id
      `,
      [circleId]
    );

    if (!circleResult.rows[0]) {
      return res.status(404).json({ error: "Circle not found." });
    }

    const membersResult = await pool.query(
      `
        SELECT
          u.id AS user_id,
          u.first_name,
          u.last_name,
          u.email,
          cm.role,
          l.lat,
          l.lng,
          l.accuracy,
          l.tracked_at
        FROM circle_members cm
        JOIN users u ON u.id = cm.user_id
        LEFT JOIN LATERAL (
          SELECT lat, lng, accuracy, tracked_at
          FROM locations
          WHERE user_id = cm.user_id
          ORDER BY tracked_at DESC
          LIMIT 1
        ) l ON TRUE
        WHERE cm.circle_id = $1
        ORDER BY cm.joined_at ASC
      `,
      [circleId]
    );

    const members = membersResult.rows.map((row) => ({
      userId: row.user_id,
      firstName: row.first_name,
      lastName: row.last_name,
      email: row.email,
      role: row.role,
      initials: buildUserInitials(row.first_name, row.last_name, row.email),
      lastLocation: row.lat === null
        ? null
        : {
            lat: Number(row.lat),
            lng: Number(row.lng),
            accuracy: row.accuracy === null ? null : Number(row.accuracy),
            timestamp: row.tracked_at,
          },
    }));

    return res.json({
      circle: mapCircle(circleResult.rows[0], req.auth.userId),
      members,
    });
  } catch (_error) {
    return res.status(500).json({ error: "Failed to fetch circle members." });
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

app.get(["/", "/login", "/register", "/join/:inviteCode([a-f0-9]{32})"], (_req, res) => {
  return res.sendFile(path.join(__dirname, "index.html"));
});

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
