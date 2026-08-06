"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 3001);
const PUBLIC_DIR = path.resolve(__dirname, "../public");
const DB_FILE = path.resolve(__dirname, "../data/db.json");

const sessions = new Map();

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

const ROLE_PERMISSIONS = {
  OWNER: ["CREATE", "SUBMIT", "REVIEW", "APPROVE", "POST", "REJECT", "CANCEL"],
  ACCOUNTANT: ["CREATE", "SUBMIT"],
  CHIEF_ACCOUNTANT: ["REVIEW", "REJECT"],
  FINANCE_MANAGER: ["APPROVE", "POST", "REJECT"]
};

function readDb() {
  return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
}

function writeDb(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), "utf8");
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });

  res.end(JSON.stringify(payload));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";

    req.on("data", chunk => {
      raw += chunk;

      if (raw.length > 2_000_000) {
        reject(new Error("PAYLOAD_TOO_LARGE"));
        req.destroy();
      }
    });

    req.on("end", () => {
      if (!raw) return resolve({});

      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("INVALID_JSON"));
      }
    });

    req.on("error", reject);
  });
}

function getToken(req) {
  const header = req.headers.authorization || "";
  return header.startsWith("Bearer ") ? header.slice(7) : null;
}

function requireAuth(req, res) {
  const token = getToken(req);
  const session = token ? sessions.get(token) : null;

  if (!session) {
    sendJson(res, 401, { error: "UNAUTHORIZED" });
    return null;
  }

  return session;
}

function can(session, permission) {
  return (ROLE_PERMISSIONS[session.role] || []).includes(permission);
}

function requirePermission(session, res, permission) {
  if (!can(session, permission)) {
    sendJson(res, 403, {
      error: "لا تملك صلاحية تنفيذ هذا الإجراء"
    });

    return false;
  }

  return true;
}

function addAudit(db, session, action, entity, entityId, details = {}) {
  db.auditLog.push({
    id: Date.now() + Math.floor(Math.random() * 1000),
    userId: session.userId,
    userName: session.name,
    role: session.role,
    action,
    entity,
    entityId,
    details,
    createdAt: new Date().toISOString()
  });
}

function addWorkflowHistory(entry, session, action, fromStatus, toStatus, note = "") {
  entry.workflowHistory = entry.workflowHistory || [];

  entry.workflowHistory.push({
    action,
    fromStatus,
    toStatus,
    note,
    userId: session.userId,
    userName: session.name,
    role: session.role,
    createdAt: new Date().toISOString()
  });
}

function nextEntryNumber(db) {
  db.sequences = db.sequences || {};
  db.sequences.journalEntry = Number(db.sequences.journalEntry || 0) + 1;

  return `JE-${String(db.sequences.journalEntry).padStart(6, "0")}`;
}

function validateLines(lines) {
  if (!Array.isArray(lines) || lines.length < 2) {
    return "يجب أن يحتوي القيد على سطرين على الأقل";
  }

  let totalDebit = 0;
  let totalCredit = 0;

  for (const line of lines) {
    const debit = Number(line.debit || 0);
    const credit = Number(line.credit || 0);

    if ((debit > 0 && credit > 0) || (debit <= 0 && credit <= 0)) {
      return "كل سطر يجب أن يحتوي مبلغًا مدينًا أو دائنًا فقط";
    }

    totalDebit += debit;
    totalCredit += credit;
  }

  if (Math.abs(totalDebit - totalCredit) > 0.005) {
    return "القيد غير متوازن";
  }

  return null;
}

function findEntry(db, id) {
  return db.journalEntries.find(entry => entry.id === Number(id));
}

function transitionEntry({
  db,
  entry,
  session,
  permission,
  allowedStatuses,
  newStatus,
  action,
  note = ""
}) {
  if (!can(session, permission)) {
    return {
      status: 403,
      error: "لا تملك صلاحية تنفيذ هذا الإجراء"
    };
  }

  if (!allowedStatuses.includes(entry.status)) {
    return {
      status: 409,
      error: `لا يمكن تنفيذ الإجراء عندما تكون حالة القيد ${entry.status}`
    };
  }

  const previousStatus = entry.status;
  const now = new Date().toISOString();

  entry.status = newStatus;

  if (newStatus === "SUBMITTED") {
    entry.submittedAt = now;
    entry.submittedBy = session.userId;
  }

  if (newStatus === "REVIEWED") {
    entry.reviewedAt = now;
    entry.reviewedBy = session.userId;
  }

  if (newStatus === "APPROVED") {
    entry.approvedAt = now;
    entry.approvedBy = session.userId;
  }

  if (newStatus === "POSTED") {
    entry.postedAt = now;
    entry.postedBy = session.userId;
  }

  if (newStatus === "REJECTED") {
    entry.rejectedAt = now;
    entry.rejectedBy = session.userId;
    entry.rejectionReason = note || "لم يحدد سبب";
  }

  if (newStatus === "CANCELLED") {
    entry.cancelledAt = now;
    entry.cancelledBy = session.userId;
  }

  addWorkflowHistory(
    entry,
    session,
    action,
    previousStatus,
    newStatus,
    note
  );

  addAudit(
    db,
    session,
    action,
    "JOURNAL_ENTRY",
    entry.id,
    {
      number: entry.number,
      fromStatus: previousStatus,
      toStatus: newStatus,
      note
    }
  );

  writeDb(db);

  return {
    status: 200,
    entry
  };
}

async function handleApi(req, res, url) {
  if (req.method === "POST" && url.pathname === "/api/login") {
    const body = await parseBody(req);
    const db = readDb();

    const user = db.users.find(item =>
      item.active &&
      item.email.toLowerCase() === String(body.email || "").toLowerCase() &&
      item.password === String(body.password || "")
    );

    if (!user) {
      return sendJson(res, 401, {
        error: "بيانات الدخول غير صحيحة"
      });
    }

    const token = crypto.randomBytes(24).toString("hex");

    sessions.set(token, {
      userId: user.id,
      name: user.name,
      email: user.email,
      role: user.role
    });

    return sendJson(res, 200, {
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role
      }
    });
  }

  const session = requireAuth(req, res);
  if (!session) return;

  const db = readDb();

  if (req.method === "GET" && url.pathname === "/api/bootstrap") {
    return sendJson(res, 200, {
      user: session,
      permissions: ROLE_PERMISSIONS[session.role] || [],
      companies: db.companies,
      branches: db.branches,
      fiscalYears: db.fiscalYears,
      costCenters: db.costCenters,
      projects: db.projects
    });
  }

  if (req.method === "GET" && url.pathname === "/api/accounts") {
    return sendJson(res, 200, db.accounts);
  }

  if (req.method === "POST" && url.pathname === "/api/accounts") {
    if (!requirePermission(session, res, "CREATE")) return;

    const body = await parseBody(req);

    if (!body.code || !body.name) {
      return sendJson(res, 400, {
        error: "كود الحساب واسم الحساب مطلوبان"
      });
    }

    if (db.accounts.some(account => account.code === String(body.code))) {
      return sendJson(res, 409, {
        error: "كود الحساب مستخدم مسبقًا"
      });
    }

    const account = {
      id: Date.now(),
      companyId: Number(body.companyId || 1),
      code: String(body.code),
      name: String(body.name),
      parentId: body.parentId ? Number(body.parentId) : null,
      type: body.type === "GROUP" ? "GROUP" : "POSTING",
      nature: body.nature === "CREDIT" ? "CREDIT" : "DEBIT",
      active: true,
      root: false
    };

    db.accounts.push(account);

    addAudit(
      db,
      session,
      "CREATE",
      "ACCOUNT",
      account.id,
      account
    );

    writeDb(db);

    return sendJson(res, 201, account);
  }

  if (req.method === "GET" && url.pathname === "/api/journal-entries") {
    return sendJson(res, 200, db.journalEntries);
  }

  if (req.method === "POST" && url.pathname === "/api/journal-entries") {
    if (!requirePermission(session, res, "CREATE")) return;

    const body = await parseBody(req);
    const validationError = validateLines(body.lines);

    if (validationError) {
      return sendJson(res, 400, {
        error: validationError
      });
    }

    const now = new Date().toISOString();

    const entry = {
      id: Date.now(),
      number: nextEntryNumber(db),
      date: body.date,
      memo: String(body.memo || ""),
      externalReference: String(body.externalReference || ""),
      companyId: Number(body.companyId || 1),
      branchId: Number(body.branchId || 1),
      fiscalYearId: Number(body.fiscalYearId || 1),
      status: "DRAFT",
      createdBy: session.userId,
      createdAt: now,
      updatedAt: now,
      submittedAt: null,
      submittedBy: null,
      reviewedAt: null,
      reviewedBy: null,
      approvedAt: null,
      approvedBy: null,
      postedAt: null,
      postedBy: null,
      rejectedAt: null,
      rejectedBy: null,
      rejectionReason: null,
      cancelledAt: null,
      cancelledBy: null,
      workflowHistory: [],
      lines: body.lines.map(line => ({
        accountId: Number(line.accountId),
        memo: String(line.memo || ""),
        debit: Number(line.debit || 0),
        credit: Number(line.credit || 0),
        costCenterId: line.costCenterId
          ? Number(line.costCenterId)
          : null,
        projectId: line.projectId
          ? Number(line.projectId)
          : null
      }))
    };

    addWorkflowHistory(
      entry,
      session,
      "CREATE",
      null,
      "DRAFT",
      "تم إنشاء مسودة القيد"
    );

    db.journalEntries.push(entry);

    addAudit(
      db,
      session,
      "CREATE",
      "JOURNAL_ENTRY",
      entry.id,
      {
        number: entry.number,
        status: entry.status
      }
    );

    writeDb(db);

    return sendJson(res, 201, entry);
  }

  const actionMatch = url.pathname.match(
    /^\/api\/journal-entries\/(\d+)\/(submit|review|approve|post|reject|cancel)$/
  );

  if (req.method === "POST" && actionMatch) {
    const entry = findEntry(db, actionMatch[1]);

    if (!entry) {
      return sendJson(res, 404, {
        error: "القيد غير موجود"
      });
    }

    const action = actionMatch[2];
    const body = await parseBody(req);

    const configurations = {
      submit: {
        permission: "SUBMIT",
        allowedStatuses: ["DRAFT", "REJECTED"],
        newStatus: "SUBMITTED",
        auditAction: "SUBMIT"
      },
      review: {
        permission: "REVIEW",
        allowedStatuses: ["SUBMITTED"],
        newStatus: "REVIEWED",
        auditAction: "REVIEW"
      },
      approve: {
        permission: "APPROVE",
        allowedStatuses: ["DRAFT"],
        newStatus: "POSTED",
        auditAction: "APPROVE_AND_POST"
      },
      post: {
        permission: "POST",
        allowedStatuses: ["APPROVED"],
        newStatus: "POSTED",
        auditAction: "POST"
      },
      reject: {
        permission: "REJECT",
        allowedStatuses: ["SUBMITTED", "REVIEWED", "APPROVED"],
        newStatus: "REJECTED",
        auditAction: "REJECT"
      },
      cancel: {
        permission: "CANCEL",
        allowedStatuses: [
          "DRAFT",
          "SUBMITTED",
          "REVIEWED",
          "APPROVED",
          "POSTED",
          "REJECTED"
        ],
        newStatus: "CANCELLED",
        auditAction: "CANCEL"
      }
    };

    const config = configurations[action];

    /*
     * القيود اليومية العادية:
     * المحاسب يحفظ القيد كمسودة، ثم يعتمد من الشاشة نفسها.
     * الاعتماد يرحّل القيد آليًا.
     */
    if (action === "approve") {
      config.allowedStatuses = ["DRAFT"];
      config.newStatus = "POSTED";
      config.auditAction = "APPROVE_AND_POST";
    }

    const result = transitionEntry({
      db,
      entry,
      session,
      permission: config.permission,
      allowedStatuses: config.allowedStatuses,
      newStatus: config.newStatus,
      action: config.auditAction,
      note: String(body.note || body.reason || "")
    });

    if (result.error) {
      return sendJson(res, result.status, {
        error: result.error
      });
    }

    return sendJson(res, result.status, result.entry);
  }

  if (req.method === "GET" && url.pathname === "/api/audit-log") {
    return sendJson(res, 200, db.auditLog.slice().reverse());
  }

  return sendJson(res, 404, {
    error: "NOT_FOUND"
  });
}

function serveStatic(req, res, url) {
  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = path.resolve(PUBLIC_DIR, "." + pathname);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      res.writeHead(404, {
        "Content-Type": "text/plain; charset=utf-8"
      });

      return res.end("Not found");
    }

    const extension = path.extname(filePath).toLowerCase();

    res.writeHead(200, {
      "Content-Type":
        MIME_TYPES[extension] || "application/octet-stream",
      "Cache-Control": "no-store"
    });

    res.end(content);
  });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  try {
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
    } else {
      serveStatic(req, res, url);
    }
  } catch (error) {
    console.error(error);

    sendJson(res, 500, {
      error: "INTERNAL_SERVER_ERROR"
    });
  }
}).listen(PORT, "0.0.0.0", () => {
  console.log(
    `Jadrix approval workflow is running on port ${PORT}`
  );
});
