import { Router, type IRouter } from "express";
import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import {
  AcknowledgeAlertResponse,
  ExportAuditLogResponse,
  GetSecurityStatusResponse,
  ListAlertsResponse,
  ListOperatorsResponse,
  SetEmergencyPauseBody,
  SetEmergencyPauseResponse,
  SetOperatorRoleBody,
  SetOperatorRoleResponse,
  SetSecurityLimitsBody,
  SetSecurityLimitsResponse,
} from "@workspace/api-zod";
import {
  alertsTable,
  auditEventsTable,
  db,
  operatorsTable,
  type SecurityControls,
} from "@workspace/db";
import { auditSafe, verifyAuditChain } from "../lib/audit";
import { isOperatorRole, requireFreshAuth, requireOperator } from "../lib/auth";
import {
  getSecurityControls,
  setEmergencyPause,
  setSecurityLimits,
} from "../lib/security-controls";
import { logActivity } from "../lib/state";

const router: IRouter = Router();

function serializeControls(controls: SecurityControls) {
  return {
    pauseActive: controls.pauseActive,
    pauseReason: controls.pauseReason,
    pauseActivatedAt: controls.pauseActivatedAt ? controls.pauseActivatedAt.toISOString() : null,
    pauseRevision: controls.pauseRevision,
    maxPerWithdrawalUsdc: controls.maxPerWithdrawalUsdc,
    maxWallet24hUsdc: controls.maxWallet24hUsdc,
    maxGlobal24hUsdc: controls.maxGlobal24hUsdc,
  };
}

// Public read: the UI banner and withdrawal form need the pause state and
// limits before sign-in. Contains no secrets.
router.get("/treasury/security", requireOperator(), async (req, res): Promise<void> => {
  const controls = await getSecurityControls(req.operator!.treasuryId);
  res.json(GetSecurityStatusResponse.parse(serializeControls(controls)));
});

router.post(
  "/treasury/security/pause",
  requireOperator(["guardian"]),
  async (req, res, next): Promise<void> => {
    try {
      const parsed = SetEmergencyPauseBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "A pause state and a reason (4-300 chars) are required" });
        return;
      }
      const operator = req.operator!;
      // Anyone with guardian+ can PULL the brake instantly; RELEASING it is
      // admin-only and requires a recent sign-in (step-up).
      if (!parsed.data.active) {
        if (operator.role !== "admin") {
          res.status(403).json({ error: "Only an admin can deactivate the emergency pause." });
          return;
        }
        if (Date.now() - operator.sessionCreatedAt.getTime() > 15 * 60_000) {
          res.status(401).json({
            error: "Deactivating the pause requires a recent sign-in. Sign in again and retry.",
            code: "stale_session",
          });
          return;
        }
      }
      const updated = await setEmergencyPause({
        treasuryId: operator.treasuryId,
        active: parsed.data.active,
        reason: parsed.data.reason,
        actorWallet: operator.wallet,
        actorRole: operator.role,
      });
      const controls = updated ?? (await getSecurityControls(operator.treasuryId));
      if (updated) {
        await logActivity(
          operator.treasuryId,
          parsed.data.active ? "EMERGENCY PAUSE ACTIVATED" : "Emergency pause lifted",
          parsed.data.active
            ? `Withdrawals, approvals, and mode changes are blocked. Reason: ${parsed.data.reason}`
            : `Normal operation resumed. Reason: ${parsed.data.reason}`,
          parsed.data.active ? "alert" : "verified",
        );
      }
      res.json(SetEmergencyPauseResponse.parse(serializeControls(controls)));
    } catch (error) {
      next(error);
    }
  },
);

router.put(
  "/treasury/security/limits",
  requireOperator(["admin"]),
  requireFreshAuth,
  async (req, res, next): Promise<void> => {
    try {
      const parsed = SetSecurityLimitsBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "All three limits must be positive numbers" });
        return;
      }
      const { maxPerWithdrawalUsdc, maxWallet24hUsdc, maxGlobal24hUsdc } = parsed.data;
      if (maxPerWithdrawalUsdc > maxWallet24hUsdc || maxWallet24hUsdc > maxGlobal24hUsdc) {
        res.status(400).json({
          error:
            "Limits must be ordered: per-withdrawal ≤ per-wallet 24h ≤ global 24h.",
        });
        return;
      }
      const operator = req.operator!;
      const updated = await setSecurityLimits({
        treasuryId: operator.treasuryId,
        maxPerWithdrawalUsdc,
        maxWallet24hUsdc,
        maxGlobal24hUsdc,
        actorWallet: operator.wallet,
        actorRole: operator.role,
      });
      res.json(SetSecurityLimitsResponse.parse(serializeControls(updated)));
    } catch (error) {
      next(error);
    }
  },
);

// Any authenticated operator (including viewers) may export the audit log:
// transparency is the point. Every export is itself audited.
router.get(
  "/treasury/security/audit",
  requireOperator(["viewer", "strategist", "approver", "guardian"]),
  async (req, res, next): Promise<void> => {
    try {
      const [verification, events] = await Promise.all([
        verifyAuditChain(),
        db
          .select()
          .from(auditEventsTable)
          .where(
            or(
              eq(auditEventsTable.treasuryId, req.operator!.treasuryId),
              isNull(auditEventsTable.treasuryId),
            ),
          )
          .orderBy(auditEventsTable.seq),
      ]);
      const actor = req.operator!;
      await auditSafe({
        treasuryId: actor.treasuryId,
        action: "audit.export",
        actorWallet: actor.wallet,
        actorRole: actor.role,
        sessionId: actor.sessionId,
        result: "ok",
        detail: { events: verification.events, verified: verification.brokenAtSeq === null },
      });
      res.json(
        ExportAuditLogResponse.parse({
          verified: verification.brokenAtSeq === null,
          brokenAtSeq: verification.brokenAtSeq,
          exportedAt: new Date().toISOString(),
          events: events.map((e) => ({
            seq: e.seq,
            time: e.time.toISOString(),
            actorWallet: e.actorWallet,
            actorRole: e.actorRole,
            action: e.action,
            resourceId: e.resourceId,
            result: e.result,
            reason: e.reason,
            detail: e.detail === null ? null : JSON.stringify(e.detail),
            prevHash: e.prevHash,
            hash: e.hash,
          })),
        }),
      );
    } catch (error) {
      next(error);
    }
  },
);

router.get(
  "/treasury/security/alerts",
  requireOperator(["viewer", "strategist", "approver", "guardian"]),
  async (req, res, next): Promise<void> => {
    try {
      const alerts = await db
        .select()
        .from(alertsTable)
        .where(
          or(
            eq(alertsTable.treasuryId, req.operator!.treasuryId),
            isNull(alertsTable.treasuryId),
          ),
        )
        .orderBy(desc(alertsTable.time))
        .limit(50);
      res.json(
        ListAlertsResponse.parse(
          alerts.map((a) => ({
            id: a.id,
            time: a.time.toISOString(),
            severity: a.severity,
            kind: a.kind,
            title: a.title,
            detail: a.detail,
            data: a.data === null ? null : JSON.stringify(a.data),
            acknowledgedAt: a.acknowledgedAt ? a.acknowledgedAt.toISOString() : null,
          })),
        ),
      );
    } catch (error) {
      next(error);
    }
  },
);

router.post(
  "/treasury/security/alerts/:alertId/ack",
  requireOperator(["viewer", "strategist", "approver", "guardian"]),
  async (req, res, next): Promise<void> => {
    try {
      const alertId = String(req.params.alertId);
      const actor = req.operator!;
      const [updated] = await db
        .update(alertsTable)
        .set({ acknowledgedAt: new Date() })
        .where(
          and(
            eq(alertsTable.id, alertId),
            isNull(alertsTable.acknowledgedAt),
            or(
              eq(alertsTable.treasuryId, actor.treasuryId),
              isNull(alertsTable.treasuryId),
            ),
          ),
        )
        .returning();
      if (!updated) {
        const [existing] = await db
          .select()
          .from(alertsTable)
          .where(
            and(
              eq(alertsTable.id, alertId),
              or(
                eq(alertsTable.treasuryId, actor.treasuryId),
                isNull(alertsTable.treasuryId),
              ),
            ),
          );
        if (!existing) {
          res.status(404).json({ error: "Alert not found" });
          return;
        }
        // Already acknowledged - idempotent success.
        res.json(
          AcknowledgeAlertResponse.parse({
            id: existing.id,
            time: existing.time.toISOString(),
            severity: existing.severity,
            kind: existing.kind,
            title: existing.title,
            detail: existing.detail,
            data: existing.data === null ? null : JSON.stringify(existing.data),
            acknowledgedAt: existing.acknowledgedAt
              ? existing.acknowledgedAt.toISOString()
              : null,
          }),
        );
        return;
      }
      await auditSafe({
        treasuryId: actor.treasuryId,
        action: "alert.acknowledge",
        actorWallet: actor.wallet,
        actorRole: actor.role,
        sessionId: actor.sessionId,
        resourceId: alertId,
        result: "ok",
      });
      res.json(
        AcknowledgeAlertResponse.parse({
          id: updated.id,
          time: updated.time.toISOString(),
          severity: updated.severity,
          kind: updated.kind,
          title: updated.title,
          detail: updated.detail,
          data: updated.data === null ? null : JSON.stringify(updated.data),
          acknowledgedAt: updated.acknowledgedAt ? updated.acknowledgedAt.toISOString() : null,
        }),
      );
    } catch (error) {
      next(error);
    }
  },
);

router.get(
  "/treasury/operators",
  requireOperator(["admin"]),
  async (req, res, next): Promise<void> => {
    try {
      const operators = await db
        .select()
        .from(operatorsTable)
        .where(eq(operatorsTable.treasuryId, req.operator!.treasuryId))
        .orderBy(desc(operatorsTable.createdAt));
      res.json(
        ListOperatorsResponse.parse(
          operators.map((op) => ({
            wallet: op.wallet,
            role: op.role,
            addedBy: op.addedBy,
            createdAt: op.createdAt.toISOString(),
          })),
        ),
      );
    } catch (error) {
      next(error);
    }
  },
);

router.put(
  "/treasury/operators/:wallet",
  requireOperator(["admin"]),
  requireFreshAuth,
  async (req, res, next): Promise<void> => {
    try {
      const wallet = String(req.params.wallet).toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(wallet)) {
        res.status(400).json({ error: "Invalid wallet address" });
        return;
      }
      const parsed = SetOperatorRoleBody.safeParse(req.body);
      if (!parsed.success || !isOperatorRole(parsed.data.role)) {
        res.status(400).json({
          error: "Role must be one of: viewer, strategist, approver, guardian, admin",
        });
        return;
      }
      const role = parsed.data.role;
      const actor = req.operator!;

      const result = await db.transaction(async (tx) => {
        // Serialize role changes so two concurrent demotions cannot jointly
        // remove the last admin.
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${`operator-roles:${actor.treasuryId}`}))`,
        );
        const [target] = await tx
          .select()
          .from(operatorsTable)
          .where(
            and(
              eq(operatorsTable.treasuryId, actor.treasuryId),
              eq(operatorsTable.wallet, wallet),
            ),
          );
        if (role !== "admin") {
          const [{ admins }] = await tx
            .select({ admins: sql<number>`count(*)::int` })
            .from(operatorsTable)
            .where(
              and(
                eq(operatorsTable.treasuryId, actor.treasuryId),
                eq(operatorsTable.role, "admin"),
              ),
            );
          if (target?.role === "admin" && admins <= 1) {
            return { kind: "lastAdmin" as const };
          }
        }
        const [row] = target
          ? await tx
              .update(operatorsTable)
              .set({ role, updatedAt: new Date() })
              .where(
                and(
                  eq(operatorsTable.treasuryId, actor.treasuryId),
                  eq(operatorsTable.wallet, wallet),
                ),
              )
              .returning()
          : await tx
              .insert(operatorsTable)
              .values({ wallet, treasuryId: actor.treasuryId, role, addedBy: actor.wallet })
              .onConflictDoNothing({ target: operatorsTable.wallet })
              .returning();
        if (!row) return { kind: "unavailable" as const };
        return { kind: "ok" as const, row };
      });

      if (result.kind === "lastAdmin") {
        res.status(409).json({
          error: "This is the last admin. Assign another admin before changing this role.",
        });
        return;
      }
      if (result.kind === "unavailable") {
        res.status(409).json({ error: "That wallet already belongs to another treasury." });
        return;
      }
      await auditSafe({
        treasuryId: actor.treasuryId,
        action: "operator.role.set",
        actorWallet: actor.wallet,
        actorRole: actor.role,
        sessionId: actor.sessionId,
        resourceId: wallet,
        result: "ok",
        detail: { role },
      });
      res.json(
        SetOperatorRoleResponse.parse({
          wallet: result.row.wallet,
          role: result.row.role,
          addedBy: result.row.addedBy,
          createdAt: result.row.createdAt.toISOString(),
        }),
      );
    } catch (error) {
      next(error);
    }
  },
);

export default router;
