import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

// Known critical columns that previously suffered from schema drift in production
// (e.g. May 18 77x HTTP 500 incidents where Drizzle select() crashed on missing columns).
const CRITICAL_SCHEMA_COLUMNS = [
  { table: "businesses", column: "industry" },
  { table: "businesses", column: "allowed_origins" },
  { table: "businesses", column: "monthly_email_limit" },
  { table: "orders", column: "transport_mode" },
];

router.get("/readyz", async (req, res) => {
  try {
    await db.execute(sql`select 1`);

    // Opt-in schema drift readiness check via query param ?checkSchema=1 or CHECK_SCHEMA_DRIFT=1.
    // Read-only query against information_schema.columns to detect missing columns before traffic.
    // Logs discrepancies clearly without crashing the service or aborting the transaction.
    const shouldCheckSchema =
      req.query.checkSchema === "1" || process.env.CHECK_SCHEMA_DRIFT === "1";

    if (shouldCheckSchema) {
      try {
        const rows = await db.execute<{ table_name: string; column_name: string }>(
          sql`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ('businesses', 'orders')`,
        );
        const existing = new Set(
          (rows.rows || []).map((r) => `${r.table_name}.${r.column_name}`),
        );
        const missing = CRITICAL_SCHEMA_COLUMNS.filter(
          (c) => !existing.has(`${c.table}.${c.column}`),
        );
        if (missing.length > 0) {
          req.log?.warn(
            { missingColumns: missing },
            "Schema drift detected: database lacks columns expected by Drizzle models",
          );
        }
      } catch (schemaErr) {
        req.log?.warn({ err: schemaErr }, "Schema drift inspection query failed");
      }
    }

    const data = HealthCheckResponse.parse({ status: "ok" });
    res.json(data);
  } catch (err) {
    req.log?.error({ err }, "Readiness check failed");
    res.status(503).json({ status: "unavailable" });
  }
});

export default router;
