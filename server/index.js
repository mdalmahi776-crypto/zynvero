import express from "express";
import dotenv from "dotenv";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";

dotenv.config();

const { Pool } = pg;

const app = express();
const PORT = process.env.PORT || 3000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WEB_DIR = path.join(__dirname, "..", "web");

// ===============================
// DATABASE
// ===============================

if (!process.env.DATABASE_URL) {
  console.warn("WARNING: DATABASE_URL is missing");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL
    ? { rejectUnauthorized: false }
    : false,
});

// ===============================
// TELEGRAM
// ===============================

const BOT_TOKEN = process.env.BOT_TOKEN || "";

const ADMIN_TELEGRAM_ID =
  String(process.env.ADMIN_TELEGRAM_ID || "5624401046");

// Mandatory communities
const REQUIRED_CHATS = [
  {
    id: "-1002094920926",
    username: "@ZynveroCrypto",
    name: "ZYNVERO Announcement",
    url: "https://t.me/ZynveroCrypto",
  },
  {
    id: "-1003976553960",
    username: "@zynveroEcosystem",
    name: "ZYNVERO Ecosystem",
    url: "https://t.me/zynveroEcosystem",
  },
  {
    id: "-1002057176093",
    username: "@zynverohelpdesk",
    name: "ZYNVERO HelpDesk Group",
    url: "https://t.me/zynverohelpdesk",
  },
];

// Optional community
const OPTIONAL_CHAT = {
  id: "@zynverocrypto",
  username: "@zynverocrypto",
  name: "ZYNVERO Crypto",
  url: "https://t.me/zynverocrypto",
};

// ===============================
// EXPRESS
// ===============================

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

app.use(express.static(WEB_DIR));

// ===============================
// TELEGRAM INIT DATA VALIDATION
// ===============================

function validateTelegramInitData(initData) {
  if (!initData || !BOT_TOKEN) {
    return {
      valid: false,
      reason: !initData
        ? "missing initData"
        : "missing BOT_TOKEN",
    };
  }

  try {
    const params = new URLSearchParams(initData);

    const receivedHash = params.get("hash");

    if (!receivedHash) {
      return {
        valid: false,
        reason: "missing hash",
      };
    }

    params.delete("hash");

    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join("\n");

    const secretKey = crypto
      .createHmac("sha256", "WebAppData")
      .update(BOT_TOKEN)
      .digest();

    const calculatedHash = crypto
      .createHmac("sha256", secretKey)
      .update(dataCheckString)
      .digest("hex");

    const receivedBuffer = Buffer.from(receivedHash, "hex");
    const calculatedBuffer = Buffer.from(calculatedHash, "hex");

    if (
      receivedBuffer.length !== calculatedBuffer.length ||
      !crypto.timingSafeEqual(receivedBuffer, calculatedBuffer)
    ) {
      return {
        valid: false,
        reason: "invalid hash",
      };
    }

    const userRaw = params.get("user");

    if (!userRaw) {
      return {
        valid: false,
        reason: "missing Telegram user",
      };
    }

    const user = JSON.parse(userRaw);

    if (!user?.id) {
      return {
        valid: false,
        reason: "invalid Telegram user",
      };
    }

    return {
      valid: true,
      user,
    };
  } catch (error) {
    console.error("Telegram validation error:", error);

    return {
      valid: false,
      reason: "validation error",
    };
  }
}

// ===============================
// TELEGRAM API
// ===============================

async function telegramApi(method, body = {}) {
  if (!BOT_TOKEN) {
    throw new Error("BOT_TOKEN is not configured");
  }

  const response = await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );

  const data = await response.json();

  if (!response.ok || !data.ok) {
    throw new Error(
      data?.description || `Telegram API error: ${response.status}`
    );
  }

  return data.result;
}

// ===============================
// AUTH MIDDLEWARE
// ===============================

function authMiddleware(req, res, next) {
  const initData =
    req.headers["x-telegram-init-data"] ||
    req.body?.initData ||
    req.query?.initData;

  const result = validateTelegramInitData(initData);

  if (!result.valid) {
    return res.status(401).json({
      success: false,
      error: `Authentication failed: ${result.reason}`,
    });
  }

  req.telegramUser = result.user;
  req.initData = initData;

  next();
}

// ===============================
// MEMBERSHIP CHECK
// ===============================

async function checkMember(chatId, telegramUserId) {
  try {
    const member = await telegramApi("getChatMember", {
      chat_id: chatId,
      user_id: telegramUserId,
    });

    const allowedStatuses = [
      "creator",
      "administrator",
      "member",
      "restricted",
    ];

    return allowedStatuses.includes(member.status);
  } catch (error) {
    console.error(
      `Membership check failed for ${chatId}:`,
      error.message
    );

    return false;
  }
}

// ===============================
// HEALTH
// ===============================

app.get("/api/health", async (req, res) => {
  let database = "unknown";

  try {
    await pool.query("SELECT 1");
    database = "connected";
  } catch (error) {
    database = "error";
  }

  res.json({
    success: true,
    app: "ZYNVERO",
    status: "online",
    database,
    telegramBot: BOT_TOKEN ? "configured" : "missing",
  });
});

// ===============================
// CONFIG
// ===============================

app.get("/api/config", (req, res) => {
  res.json({
    success: true,

    app: {
      name: "ZYNVERO",
      supportUrl: "https://t.me/zynverohelpdesk",
    },

    requiredChats: REQUIRED_CHATS.map((chat) => ({
      username: chat.username,
      name: chat.name,
      url: chat.url,
    })),

    optionalChat: {
      username: OPTIONAL_CHAT.username,
      name: OPTIONAL_CHAT.name,
      url: OPTIONAL_CHAT.url,
    },

    signupBonus: 3,
    bonusType: "package_only",
  });
});

// ===============================
// AUTH / REGISTER USER
// ===============================

app.post("/api/auth", authMiddleware, async (req, res) => {
  const telegramUser = req.telegramUser;

  const telegramId = String(telegramUser.id);
  const firstName = telegramUser.first_name || "";
  const lastName = telegramUser.last_name || "";
  const username = telegramUser.username || "";

  const referralCode =
    typeof req.body?.referralCode === "string"
      ? req.body.referralCode.trim()
      : null;

  try {
    // Check whether user already exists
    const existing = await pool.query(
      `
      SELECT
        id,
        telegram_id,
        username,
        first_name,
        last_name,
        main_balance,
        bonus_balance,
        signup_bonus,
        referral_code,
        referred_by,
        status,
        created_at
      FROM users
      WHERE telegram_id = $1
      LIMIT 1
      `,
      [telegramId]
    );

    if (existing.rows.length > 0) {
      const user = existing.rows[0];

      // Update basic Telegram profile data
      await pool.query(
        `
        UPDATE users
        SET
          username = $1,
          first_name = $2,
          last_name = $3,
          updated_at = NOW()
        WHERE telegram_id = $4
        `,
        [
          username,
          firstName,
          lastName,
          telegramId,
        ]
      );

      return res.json({
        success: true,
        newUser: false,
        user: {
          ...user,
          username,
          first_name: firstName,
          last_name: lastName,
        },
      });
    }

    // New user
    const signupBonus = 3.0;

    const generatedReferralCode =
      `ZYN${telegramId}`;

    const result = await pool.query(
      `
      INSERT INTO users (
        telegram_id,
        username,
        first_name,
        last_name,
        main_balance,
        bonus_balance,
        signup_bonus,
        referral_code,
        referred_by,
        status,
        created_at,
        updated_at
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        0.00,
        $5,
        $5,
        $6,
        $7,
        'active',
        NOW(),
        NOW()
      )
      RETURNING *
      `,
      [
        telegramId,
        username,
        firstName,
        lastName,
        signupBonus,
        generatedReferralCode,
        referralCode,
      ]
    );

    const user = result.rows[0];

    return res.json({
      success: true,
      newUser: true,
      message: "Welcome to ZYNVERO",
      user,
    });
  } catch (error) {
    console.error("Auth/register error:", error);

    return res.status(500).json({
      success: false,
      error: "Registration failed",
      details:
        process.env.NODE_ENV === "development"
          ? error.message
          : undefined,
    });
  }
});

// ===============================
// VERIFY MEMBERSHIP
// ===============================

app.post(
  "/api/verify-membership",
  authMiddleware,
  async (req, res) => {
    const telegramUserId = req.telegramUser.id;

    try {
      const results = [];

      for (const chat of REQUIRED_CHATS) {
        const joined = await checkMember(
          chat.id,
          telegramUserId
        );

        results.push({
          name: chat.name,
          username: chat.username,
          url: chat.url,
          joined,
          required: true,
        });
      }

      const allJoined = results.every(
        (item) => item.joined === true
      );

      return res.json({
        success: true,
        allJoined,
        communities: results,
      });
    } catch (error) {
      console.error(
        "Membership verification error:",
        error
      );

      return res.status(500).json({
        success: false,
        error: "Membership verification failed",
        details:
          process.env.NODE_ENV === "development"
            ? error.message
            : undefined,
      });
    }
  }
);

// ===============================
// PROFILE
// ===============================

app.get(
  "/api/profile",
  authMiddleware,
  async (req, res) => {
    const telegramId = String(req.telegramUser.id);

    try {
      const result = await pool.query(
        `
        SELECT
          id,
          telegram_id,
          username,
          first_name,
          last_name,
          main_balance,
          bonus_balance,
          signup_bonus,
          referral_code,
          referred_by,
          status,
          created_at
        FROM users
        WHERE telegram_id = $1
        LIMIT 1
        `,
        [telegramId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          success: false,
          error: "User not found",
        });
      }

      return res.json({
        success: true,
        user: result.rows[0],
      });
    } catch (error) {
      console.error("Profile error:", error);

      return res.status(500).json({
        success: false,
        error: "Could not load profile",
      });
    }
  }
);

// ===============================
// ADMIN HEALTH
// ===============================

app.get(
  "/api/admin/health",
  authMiddleware,
  async (req, res) => {
    const telegramId = String(req.telegramUser.id);

    if (telegramId !== ADMIN_TELEGRAM_ID) {
      return res.status(403).json({
        success: false,
        error: "Admin access denied",
      });
    }

    let database = "error";

    try {
      await pool.query("SELECT 1");
      database = "connected";
    } catch (error) {
      database = "error";
    }

    return res.json({
      success: true,
      admin: true,
      database,
      telegramBot: BOT_TOKEN
        ? "configured"
        : "missing",
    });
  }
);

// ===============================
// ADMIN PACKAGE SETTINGS
// ===============================

app.get("/api/admin/packages", authMiddleware, async (req, res) => {
  try {
    const telegramId = String(req.telegramUser.id);

    if (telegramId !== ADMIN_TELEGRAM_ID) {
      return res.status(403).json({
        success: false,
        error: "Admin access required",
      });
    }

    const result = await pool.query(`
      SELECT
        id,
        name,
        description,
        price,
        duration_days,
        reward_amount,
        reward_type,
        daily_reward,
        daily_reward_type,
        bonus_eligible,
        image_url,
        active,
        created_at,
        updated_at
      FROM packages
      ORDER BY created_at DESC
    `);

    return res.json({
      success: true,
      packages: result.rows,
    });

  } catch (error) {
    console.error("Admin packages error:", error);

    return res.status(500).json({
      success: false,
      error: "Failed to load admin packages",
    });
  }
});


// Create package
app.post("/api/admin/packages", authMiddleware, async (req, res) => {
  try {
    const telegramId = String(req.telegramUser.id);

    if (telegramId !== ADMIN_TELEGRAM_ID) {
      return res.status(403).json({
        success: false,
        error: "Admin access required",
      });
    }

    const {
      name,
      description = "",
      price,
      duration_days,
      daily_reward = 0,
      daily_reward_type = "percentage",
      image_url = "",
      bonus_eligible = true,
      active = true
    } = req.body;

    if (!name || price === undefined || !duration_days) {
      return res.status(400).json({
        success: false,
        error: "Name, price and duration are required",
      });
    }

    const result = await pool.query(
      `
      INSERT INTO packages (
        name,
        description,
        price,
        duration_days,
        daily_reward,
        daily_reward_type,
        bonus_eligible,
        image_url,
        active
      )
      VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9
      )
      RETURNING *
      `,
      [
        String(name).trim(),
        String(description),
        Number(price),
        Number(duration_days),
        Number(daily_reward),
        String(daily_reward_type),
        Boolean(bonus_eligible),
        String(image_url),
        Boolean(active)
      ]
    );

    return res.json({
      success: true,
      message: "Package created successfully",
      package: result.rows[0],
    });

  } catch (error) {
    console.error("Create package error:", error);

    return res.status(500).json({
      success: false,
      error: "Failed to create package",
    });
  }
});


// Edit package
app.put("/api/admin/packages/:packageId", authMiddleware, async (req, res) => {
  try {
    const telegramId = String(req.telegramUser.id);

    if (telegramId !== ADMIN_TELEGRAM_ID) {
      return res.status(403).json({
        success: false,
        error: "Admin access required",
      });
    }

    const packageId = req.params.packageId;

    const {
      name,
      description = "",
      price,
      duration_days,
      daily_reward = 0,
      daily_reward_type = "percentage",
      image_url = "",
      bonus_eligible = true,
      active = true
    } = req.body;

    const result = await pool.query(
      `
      UPDATE packages
      SET
        name = $1,
        description = $2,
        price = $3,
        duration_days = $4,
        daily_reward = $5,
        daily_reward_type = $6,
        bonus_eligible = $7,
        image_url = $8,
        active = $9,
        updated_at = NOW()
      WHERE id = $10
      RETURNING *
      `,
      [
        String(name).trim(),
        String(description),
        Number(price),
        Number(duration_days),
        Number(daily_reward),
        String(daily_reward_type),
        Boolean(bonus_eligible),
        String(image_url),
        Boolean(active),
        packageId
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: "Package not found",
      });
    }

    return res.json({
      success: true,
      message: "Package updated successfully",
      package: result.rows[0],
    });

  } catch (error) {
    console.error("Update package error:", error);

    return res.status(500).json({
      success: false,
      error: "Failed to update package",
    });
  }
});

// ===============================
// PACKAGE API
// ===============================

// Get active packages
app.get("/api/packages", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        id,
        name,
        description,
        price,
        duration_days,
        reward_amount,
        reward_type,
        image_url
      FROM packages
      WHERE active = true
      ORDER BY price ASC, created_at ASC
    `);

    return res.json({
      success: true,
      packages: result.rows,
    });
  } catch (error) {
    console.error("Packages error:", error);

    return res.status(500).json({
      success: false,
      error: "Failed to load packages",
    });
  }
});

// Buy package using main balance or signup bonus
app.post("/api/packages/:packageId/purchase", authMiddleware, async (req, res) => {
  const client = await pool.connect();

  try {
    const telegramId = String(req.telegramUser.id);
    const packageId = req.params.packageId;

    await client.query("BEGIN");

    // Find user
    const userResult = await client.query(
      `
      SELECT
        id,
        telegram_id,
        main_balance,
        bonus_balance,
        status
      FROM users
      WHERE telegram_id = $1
      FOR UPDATE
      `,
      [telegramId]
    );

    if (userResult.rows.length === 0) {
      await client.query("ROLLBACK");

      return res.status(404).json({
        success: false,
        error: "User not found",
      });
    }

    const user = userResult.rows[0];

    if (user.status !== "active") {
      await client.query("ROLLBACK");

      return res.status(403).json({
        success: false,
        error: "Account is not active",
      });
    }

    // Find package
    const packageResult = await client.query(
      `
      SELECT
        id,
        name,
        price,
        duration_days,
        reward_amount,
        reward_type,
        active
      FROM packages
      WHERE id = $1
      LIMIT 1
      `,
      [packageId]
    );

    if (packageResult.rows.length === 0) {
      await client.query("ROLLBACK");

      return res.status(404).json({
        success: false,
        error: "Package not found",
      });
    }

    const pkg = packageResult.rows[0];

    if (!pkg.active) {
      await client.query("ROLLBACK");

      return res.status(400).json({
        success: false,
        error: "Package is not available",
      });
    }

    const price = Number(pkg.price);
    const mainBalance = Number(user.main_balance || 0);
    const bonusBalance = Number(user.bonus_balance || 0);

    let paymentSource = null;

    // Signup bonus can ONLY be used for package purchase.
    if (bonusBalance >= price) {
      paymentSource = "signup_bonus";

      await client.query(
        `
        UPDATE users
        SET
          bonus_balance = bonus_balance - $1,
          updated_at = NOW()
        WHERE id = $2
        `,
        [price, user.id]
      );
    } else if (mainBalance >= price) {
      paymentSource = "main_balance";

      await client.query(
        `
        UPDATE users
        SET
          main_balance = main_balance - $1,
          updated_at = NOW()
        WHERE id = $2
        `,
        [price, user.id]
      );
    } else {
      await client.query("ROLLBACK");

      return res.status(400).json({
        success: false,
        error: "Insufficient balance",
      });
    }

    // Calculate package expiry
    const expiresAt = new Date(
      Date.now() + Number(pkg.duration_days) * 24 * 60 * 60 * 1000
    );

    // Activate package
    const purchaseResult = await client.query(
      `
      INSERT INTO user_packages (
        user_id,
        package_id,
        price_paid,
        payment_source,
        started_at,
        expires_at,
        status
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        NOW(),
        $5,
        'active'
      )
      RETURNING *
      `,
      [
        user.id,
        pkg.id,
        price,
        paymentSource,
        expiresAt,
      ]
    );

    await client.query("COMMIT");

    return res.json({
      success: true,
      message: "Package activated successfully",
      paymentSource,
      package: purchaseResult.rows[0],
    });
  } catch (error) {
    await client.query("ROLLBACK");

    console.error("Package purchase error:", error);

    return res.status(500).json({
      success: false,
      error: "Package purchase failed",
    });
  } finally {
    client.release();
  }
});

// ===============================
// FRONTEND FALLBACK
// ===============================

app.get("*", (req, res) => {
  res.sendFile(
    path.join(WEB_DIR, "index.html")
  );
});

// ===============================
// START SERVER
// ===============================

app.listen(PORT, () => {
  console.log(
    `ZYNVERO running on port ${PORT}`
  );

  console.log(
    `Web directory: ${WEB_DIR}`
  );

  console.log(
    `Telegram bot: ${
      BOT_TOKEN ? "configured" : "MISSING"
    }`
  );

  console.log(
    `Database: ${
      process.env.DATABASE_URL
        ? "configured"
        : "MISSING"
    }`
  );
});
