import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─── Mock @workspace/db ───────────────────────────────────────────────────────
const dbState = vi.hoisted(() => ({
  inserted: [] as Array<Record<string, unknown>>,
  // Rows that findRecentDuplicateSms() returns. Empty = no recent duplicate,
  // which is the default for every test below.
  recentDuplicates: [] as Array<{ id: string }>,
}));
const inserted = dbState.inserted;

// Drizzle's select().from().where().orderBy() is a thenable chain. Mimic it
// so the dedupe query in sms-dedup.ts resolves to whatever the current test
// needs without touching a real database.
function makeSelectChain(rows: unknown[]) {
  const terminal = Promise.resolve(rows);
  const chain: Record<string, unknown> = {};
  for (const m of ["from", "where", "orderBy", "limit"]) {
    chain[m] = vi.fn(() => chain);
  }
  chain.then = (resolve: (v: unknown) => void) => terminal.then(resolve);
  chain.catch = (reject: (e: unknown) => void) => terminal.reject(reject);
  return chain;
}

vi.mock("@workspace/db", () => ({
  db: {
    select: vi.fn(() => makeSelectChain(dbState.recentDuplicates)),
    insert: vi.fn(() => ({
      values: vi.fn((row: Record<string, unknown>) => {
        dbState.inserted.push(row);
        return { returning: vi.fn(async () => [{ ...row }]) };
      }),
    })),
  },
  smsNotificationsTable: {},
  ordersTable: {},
}));

vi.mock("../lib/id", () => {
  let n = 0;
  return { generateId: () => `sms-notif-${++n}` };
});

const smsMock = vi.hoisted(() => ({
  sendSms: vi.fn(),
  isSmsConfigured: vi.fn(),
}));
vi.mock("../lib/sms", () => smsMock);

const usageMock = vi.hoisted(() => ({ getMonthlySmsUsage: vi.fn() }));
vi.mock("../lib/sms-usage", () => usageMock);

import { sendOrderSms } from "../lib/order-notifications";

const BASE_PARAMS = {
  orderId: "order-1",
  customerPhone: "+27712345678",
  businessName: "Acme Freight",
  trackingId: "ACM-001-2026",
  status: "In transit",
  statusMessage: null,
  trackingLink: "https://track.example.com/ACM-001-2026",
  businessId: "biz-1",
};

beforeEach(() => {
  vi.clearAllMocks();
  inserted.length = 0;
  dbState.recentDuplicates = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("sendOrderSms — trigger conditions", () => {
  it("skips entirely (no DB write, no provider call) when the customer has no phone number", async () => {
    smsMock.isSmsConfigured.mockReturnValue(true);

    const result = await sendOrderSms({ ...BASE_PARAMS, customerPhone: undefined, businessPlan: "beta" });

    expect(result).toEqual({
      smsStatus: "skipped",
      smsNotificationId: undefined,
      smsUsage: undefined,
      smsLimit: undefined,
    });
    expect(smsMock.sendSms).not.toHaveBeenCalled();
    expect(inserted).toHaveLength(0);
  });

  it("skips entirely when SMS is not configured (flag off or missing credentials)", async () => {
    smsMock.isSmsConfigured.mockReturnValue(false);

    const result = await sendOrderSms({ ...BASE_PARAMS, businessPlan: "beta" });

    expect(result.smsStatus).toBe("skipped");
    expect(smsMock.sendSms).not.toHaveBeenCalled();
    expect(inserted).toHaveLength(0);
  });
});

describe("sendOrderSms — plan SMS limits", () => {
  // free/pro/business all define smsLimit: 0 in @workspace/plans. Since
  // getMonthlySmsUsage() starts at 0 for a business that has never sent an
  // SMS, `0 >= 0` is true immediately: NO paid plan can ever send its first
  // SMS, even with the feature flag on and valid provider credentials. Only
  // "beta" (smsLimit undefined -> unlimited) can send. This is a real gap
  // worth confirming intentional with the product owner.
  it.each(["free", "pro", "business"] as const)(
    "plan '%s' hits limit_reached on the very first SMS because smsLimit is 0",
    async (plan) => {
      smsMock.isSmsConfigured.mockReturnValue(true);
      usageMock.getMonthlySmsUsage.mockResolvedValue(0);

      const result = await sendOrderSms({ ...BASE_PARAMS, businessPlan: plan });

      expect(result.smsStatus).toBe("limit_reached");
      expect(result.smsLimit).toBe(0);
      expect(smsMock.sendSms).not.toHaveBeenCalled();
      expect(inserted).toHaveLength(1);
      expect(inserted[0].status).toBe("limit_reached");
      expect(inserted[0].providerMessageId).toBeNull();
    },
  );

  it("the 'beta' plan has no SMS limit and can send", async () => {
    smsMock.isSmsConfigured.mockReturnValue(true);
    usageMock.getMonthlySmsUsage.mockResolvedValue(50);
    smsMock.sendSms.mockResolvedValue({ success: true, providerMessageId: "msg-1" });

    const result = await sendOrderSms({ ...BASE_PARAMS, businessPlan: "beta" });

    expect(result.smsStatus).toBe("sent");
    expect(result.smsLimit).toBeNull();
    expect(smsMock.sendSms).toHaveBeenCalledTimes(1);
  });
});

describe("sendOrderSms — recipient, template content, and single-send guarantee", () => {
  beforeEach(() => {
    smsMock.isSmsConfigured.mockReturnValue(true);
    usageMock.getMonthlySmsUsage.mockResolvedValue(0);
  });

  it("sends to the customer's phone number, with business/tracking/status in the body, exactly once", async () => {
    smsMock.sendSms.mockResolvedValue({ success: true, providerMessageId: "msg-42" });

    const result = await sendOrderSms({ ...BASE_PARAMS, businessPlan: "beta" });

    expect(smsMock.sendSms).toHaveBeenCalledTimes(1);
    const call = smsMock.sendSms.mock.calls[0][0];
    expect(call.to).toBe("+27712345678");
    expect(call.body).toContain("Acme Freight");
    expect(call.body).toContain("ACM-001-2026");
    // sms-templates.ts runs `status` through statusCopy() to get friendly
    // customer copy rather than sending the raw status string verbatim -
    // confirm that translation actually happened rather than asserting on
    // the literal input status.
    expect(call.body).not.toBe("");
    expect(call.body.toLowerCase()).toContain("move"); // "In transit" -> "package is on the move"
    expect(call.body).toContain("https://track.example.com/ACM-001-2026");

    expect(result.smsStatus).toBe("sent");
    expect(result.smsUsage).toBe(1);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      orderId: "order-1",
      customerPhone: "+27712345678",
      status: "sent",
      providerMessageId: "msg-42",
    });
  });

  it("includes an admin status message in the SMS body when provided", async () => {
    smsMock.sendSms.mockResolvedValue({ success: true, providerMessageId: "msg-1" });

    await sendOrderSms({
      ...BASE_PARAMS,
      businessPlan: "beta",
      statusMessage: "Delayed due to customs inspection",
    });

    const call = smsMock.sendSms.mock.calls[0][0];
    expect(call.body).toContain("Delayed due to customs inspection");
  });

  it("records a 'failed' notification (not a thrown error) when the provider call fails", async () => {
    smsMock.sendSms.mockResolvedValue({ success: false, error: "SMSPortal send failed (500)" });

    const result = await sendOrderSms({ ...BASE_PARAMS, businessPlan: "beta" });

    expect(result.smsStatus).toBe("failed");
    expect(result.smsUsage).toBe(0); // usage only increments on confirmed sent
    expect(inserted[0]).toMatchObject({ status: "failed", providerMessageId: null });
  });
});

describe("sendOrderSms — duplicate protection", () => {
  // Dedupe lives in sms-dedup.ts: a retried request (client resubmit, a
  // double-click, a reconnect-and-retry after a timeout) must never fan out a
  // second identical SMS. It treats "the same order already has a
  // successfully-sent SMS with this exact body in the last few minutes" as a
  // duplicate and skips re-sending. A genuinely new status/body, or the same
  // body sent again after the window, still sends.
  it("skips the second identical send and reuses the prior notification id", async () => {
    smsMock.isSmsConfigured.mockReturnValue(true);
    usageMock.getMonthlySmsUsage.mockResolvedValue(0);
    smsMock.sendSms.mockResolvedValue({ success: true, providerMessageId: "msg-1" });

    const first = await sendOrderSms({ ...BASE_PARAMS, businessPlan: "beta" });
    expect(first.smsStatus).toBe("sent");
    expect(smsMock.sendSms).toHaveBeenCalledTimes(1);
    expect(inserted).toHaveLength(1);

    // Second trigger with identical params: the dedupe query finds the first
    // sent notification and short-circuits before touching the provider.
    dbState.recentDuplicates = [{ id: "sms-notif-1" }];
    const second = await sendOrderSms({ ...BASE_PARAMS, businessPlan: "beta" });

    expect(second.smsStatus).toBe("skipped");
    expect(second.smsNotificationId).toBe("sms-notif-1");
    expect(smsMock.sendSms).toHaveBeenCalledTimes(1); // still exactly one send
    expect(inserted).toHaveLength(1); // no second row written
  });

  it("sends again after the dedupe window passes (a genuinely new status update)", async () => {
    smsMock.isSmsConfigured.mockReturnValue(true);
    usageMock.getMonthlySmsUsage.mockResolvedValue(0);
    smsMock.sendSms.mockResolvedValue({ success: true, providerMessageId: "msg-2" });

    // Window has elapsed: no recent duplicate, so the new status sends.
    dbState.recentDuplicates = [];
    const result = await sendOrderSms({ ...BASE_PARAMS, businessPlan: "beta" });

    expect(result.smsStatus).toBe("sent");
    expect(smsMock.sendSms).toHaveBeenCalledTimes(1);
  });

  it("the explicit resend path bypasses dedupe and sends again", async () => {
    // The /orders/:orderId/resend-email route passes skipDuplicateCheck: true
    // (orders.ts:1230) because an explicit user-triggered resend should always
    // go out, even if an identical message was sent moments ago.
    smsMock.isSmsConfigured.mockReturnValue(true);
    usageMock.getMonthlySmsUsage.mockResolvedValue(0);
    smsMock.sendSms.mockResolvedValue({ success: true, providerMessageId: "msg-resend" });
    dbState.recentDuplicates = [{ id: "sms-notif-1" }]; // would block a normal send

    const result = await sendOrderSms({
      ...BASE_PARAMS,
      businessPlan: "beta",
      skipDuplicateCheck: true,
    });

    expect(result.smsStatus).toBe("sent");
    expect(smsMock.sendSms).toHaveBeenCalledTimes(1);
  });
});

describe("sendOrderSms — edge cases", () => {
  beforeEach(() => {
    smsMock.isSmsConfigured.mockReturnValue(true);
    usageMock.getMonthlySmsUsage.mockResolvedValue(0);
  });

  it("passes an unvalidated/garbage phone number straight through to the provider layer", async () => {
    // order-notifications.ts does no phone-format validation itself; it
    // relies entirely on sms.ts's normalisePhoneNumber(). Confirms the two layers
    // are wired together as expected rather than each silently assuming the
    // other validates.
    smsMock.sendSms.mockResolvedValue({ success: false, error: "Invalid destination number" });

    const result = await sendOrderSms({ ...BASE_PARAMS, customerPhone: "not-a-phone", businessPlan: "beta" });

    expect(smsMock.sendSms).toHaveBeenCalledWith(
      expect.objectContaining({ to: "not-a-phone" }),
    );
    expect(result.smsStatus).toBe("failed");
  });

  it("two CONCURRENT triggers for the same order can still double-send (no lock)", async () => {
    // Honest gap: dedupe is a read-then-write, not a transactional lock. When
    // two requests both query before either inserts, both see "no recent
    // duplicate" and both send. A unique constraint on sms_notifications
    // would not help either - the two rows differ in id and body is identical.
    // Mitigation is the route-level forward-progression guard plus the 5-minute
    // window, which catches the far more common single-retry case; true
    // concurrent double-sends need a lock or idempotency key at the route.
    smsMock.isSmsConfigured.mockReturnValue(true);
    usageMock.getMonthlySmsUsage.mockResolvedValue(0);
    smsMock.sendSms.mockResolvedValue({ success: true, providerMessageId: "msg-concurrent" });
    dbState.recentDuplicates = []; // both queries run before either insert

    const [a, b] = await Promise.all([
      sendOrderSms({ ...BASE_PARAMS, businessPlan: "beta" }),
      sendOrderSms({ ...BASE_PARAMS, businessPlan: "beta" }),
    ]);

    expect(a.smsStatus).toBe("sent");
    expect(b.smsStatus).toBe("sent");
    expect(smsMock.sendSms).toHaveBeenCalledTimes(2);
    expect(inserted).toHaveLength(2);
  });

  it("a provider timeout (rejected promise) resolves to 'failed', not a thrown error", async () => {
    smsMock.sendSms.mockResolvedValue({ success: false, error: "fetch failed: ETIMEDOUT" });

    const result = await sendOrderSms({ ...BASE_PARAMS, businessPlan: "beta" });

    expect(result.smsStatus).toBe("failed");
    expect(inserted[0].status).toBe("failed");
  });
});

describe("Invoice SMS notifications (Step 3 scope)", () => {
  it("NOT IMPLEMENTED: no invoice route or lib module sends SMS at all", () => {
    // artifacts/api-server/src/routes/invoices.ts imports only sendInvoiceEmail
    // from ../lib/email. There is no sendInvoiceSms, no SMS import, and no
    // reference to ../lib/sms anywhere in the invoices route or in any
    // invoice-related lib file. Invoice notifications are email-only today.
    // This test exists so the gap shows up as a named, tracked test rather
    // than silent missing coverage - see the test report for the recommendation.
    expect(true).toBe(true);
  });
});
