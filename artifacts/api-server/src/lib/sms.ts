import { isFeatureEnabled } from "@workspace/plans";
import { logger } from "./logger";

// ─── SMS: provider-agnostic send path ───────────────────────────────────────
// The application never talks to a specific SMS vendor directly - every call
// site goes through sendSms() below, which is fully gated behind
// featureFlags.smsNotifications: even with valid provider credentials, no SMS
// is ever sent while the flag is false.
//
// Providers implement the small SmsProvider interface so a future vendor
// (or a different one per environment) is a new provider file, not a rewrite
// of every call site.
//
// Env:
//   SMS_PROVIDER          - which provider to use ("smsportal" | "noop").
//                            Defaults to "smsportal". Forced to "noop" whenever
//                            NODE_ENV === "test" so automated tests can never
//                            reach a real SMS gateway, even by mistake.
//   SMSPORTAL_CLIENT_ID   - SMSPortal (https://smsportal.com) REST API Client ID
//   SMSPORTAL_API_SECRET  - SMSPortal REST API Secret
//   SMS_SENDER_ID         - optional registered sender ID (branded sender name)

export interface SendSmsParams {
  to: string;
  body: string;
}

export type SmsResult =
  | { success: true; providerMessageId?: string }
  | { success: false; error: string; skipped?: boolean };

export interface SmsProvider {
  readonly name: string;
  send(params: SendSmsParams): Promise<SmsResult>;
}

// ─── Phone number validation ─────────────────────────────────────────────────
// SMSPortal requires international numbers in E.164 format. Customer records
// may still contain common South African local or formatted values, so those
// are converted here at the provider boundary rather than changing the
// customer schema or the admin form.
export function normalisePhoneNumber(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;

  // Keep a leading plus only; any other plus or non-phone characters makes the
  // value invalid instead of silently turning it into a different number.
  if (value.includes("+") && !value.startsWith("+")) return null;
  const digits = value.replace(/[\s().-]/g, "");
  if (!/^\+?\d+$/.test(digits)) return null;

  if (digits.startsWith("+")) {
    return `+${digits.slice(1)}`;
  }
  if (digits.startsWith("00")) {
    return `+${digits.slice(2)}`;
  }
  if (digits.startsWith("0")) {
    // South African local numbers are ten digits, including the trunk prefix.
    if (digits.length !== 10) return null;
    return `+27${digits.slice(1)}`;
  }

  // An international number without the plus sign, such as 27821234567.
  return `+${digits}`;
}

export function isValidPhoneNumber(raw: string | null | undefined): boolean {
  if (!raw) return false;
  const normalised = normalisePhoneNumber(raw);
  if (!normalised) return false;
  const digits = normalised.slice(1);
  return /^\d{9,15}$/.test(digits);
}

function maskedPhoneNumber(raw: string | null | undefined): string {
  const normalised = raw ? normalisePhoneNumber(raw) : null;
  if (!normalised) return raw?.trim() ? "[invalid]" : "[missing]";
  return `${normalised.slice(0, 3)}***${normalised.slice(-2)}`;
}

// ─── SMSPortal provider ──────────────────────────────────────────────────────
const SMSPORTAL_BASE = "https://rest.smsportal.com";

function hasSmsPortalCredentials(): boolean {
  return (
    Boolean(process.env.SMSPORTAL_CLIENT_ID) &&
    Boolean(process.env.SMSPORTAL_API_SECRET)
  );
}

// SMSPortal issues short-lived bearer tokens from Basic-auth'd /Authentication.
// Cache the token and refresh a minute before expiry.
let cachedToken: { token: string; expiresAt: number } | null = null;

async function getAuthToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now) {
    return cachedToken.token;
  }
  const clientId = process.env.SMSPORTAL_CLIENT_ID ?? "";
  const secret = process.env.SMSPORTAL_API_SECRET ?? "";
  const basic = Buffer.from(`${clientId}:${secret}`).toString("base64");
  const res = await fetch(`${SMSPORTAL_BASE}/Authentication`, {
    method: "GET",
    headers: { Authorization: `Basic ${basic}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `SMSPortal authentication failed (${res.status}): ${text.slice(0, 300)}`,
    );
  }
  const data = (await res.json()) as {
    token?: string;
    expiresInMinutes?: number;
  };
  if (!data.token) {
    throw new Error("SMSPortal authentication response missing token");
  }
  const ttlMinutes = data.expiresInMinutes ?? 20;
  cachedToken = {
    token: data.token,
    // Refresh one minute early to avoid using a token at the expiry edge.
    expiresAt: now + Math.max(ttlMinutes - 1, 1) * 60_000,
  };
  return data.token;
}

// Exposed for tests only - lets a test reset auth-token caching between runs
// without reaching into module internals.
export function _resetSmsPortalTokenCacheForTests(): void {
  cachedToken = null;
}

const smsPortalProvider: SmsProvider = {
  name: "smsportal",
  async send({ to, body }) {
    if (!hasSmsPortalCredentials()) {
      logger.warn(
        "SMS provider not configured (SMSPORTAL_CLIENT_ID / SMSPORTAL_API_SECRET) - SMS not sent",
      );
      return { success: false, error: "SMS provider not configured", skipped: true };
    }

    try {
      const senderId = process.env.SMS_SENDER_ID;
      const message: Record<string, unknown> = { content: body, destination: to };
      const payload: Record<string, unknown> = { messages: [message] };
      if (senderId) {
        payload.sendOptions = { senderId };
      }
      const doSend = async (): Promise<globalThis.Response> => {
        const token = await getAuthToken();
        return fetch(`${SMSPORTAL_BASE}/BulkMessages`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        });
      };
      let res = await doSend();
      if (res.status === 401) {
        // Cached token was likely revoked/expired early - re-authenticate once
        // and retry so a stale token doesn't drop the message.
        cachedToken = null;
        res = await doSend();
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        if (res.status === 401) cachedToken = null;
        logger.error(
          { status: res.status, body: text.slice(0, 500), to },
          "SMSPortal send failed",
        );
        return { success: false, error: `SMSPortal send failed (${res.status})` };
      }
      const data = (await res.json().catch(() => ({}))) as {
        messages?: Array<{ messageId?: string }>;
      };
      const providerMessageId = data.messages?.[0]?.messageId;
      logger.info({ to, providerMessageId }, "SMS sent via SMSPortal");
      return { success: true, providerMessageId };
    } catch (err) {
      logger.error({ err, to }, "SMSPortal send errored");
      return {
        success: false,
        error: err instanceof Error ? err.message : "SMS send failed",
      };
    }
  },
};

// ─── No-op provider (test / explicit local opt-out) ──────────────────────────
// Never touches the network. Used automatically whenever NODE_ENV === "test"
// so the test suite can exercise the full send path without any risk of a
// stray real SMS, and available as an explicit SMS_PROVIDER=noop opt-out for
// local development without provider credentials.
const noopProvider: SmsProvider = {
  name: "noop",
  async send({ to, body }) {
    logger.info(
      { to, bodyLength: body.length },
      "[sms:noop] Simulated SMS send - no message was actually sent",
    );
    return { success: true, providerMessageId: `noop-${Date.now()}` };
  },
};

type SmsProviderId = "smsportal" | "noop";

function resolveProviderId(): SmsProviderId {
  // Hard safety net: automated tests must never be able to dial a real SMS
  // gateway, regardless of what SMS_PROVIDER happens to be set to in the
  // environment they run in.
  if (process.env.NODE_ENV === "test") return "noop";
  const raw = (process.env.SMS_PROVIDER ?? "smsportal").trim().toLowerCase();
  if (raw === "noop") return "noop";
  if (raw === "smsportal") return "smsportal";
  // Unrecognized value (e.g. a typo like "no-op" or "smsprotal"): never let
  // an unknown setting silently fall through to a real provider. Fail safe
  // to noop and log loudly so the misconfiguration is visible instead of
  // silently sending real SMS.
  logger.warn(
    { SMS_PROVIDER: raw },
    "Unrecognized SMS_PROVIDER value - falling back to the safe no-op provider instead of SMSPortal",
  );
  return "noop";
}

function getSmsProvider(): SmsProvider {
  return resolveProviderId() === "noop" ? noopProvider : smsPortalProvider;
}

// Exposed for tests only. The public sendSms() always routes through a safe
// no-op provider when NODE_ENV === "test", so the real SMSPortal HTTP logic
// (auth caching, 401 retry, error mapping) is tested directly against this
// reference instead, with a mocked global.fetch.
export const _smsPortalProviderForTests: SmsProvider = smsPortalProvider;

// True only when BOTH the feature flag is on AND the active provider is ready
// to send (the no-op provider is always "ready"; SMSPortal needs credentials).
// Credentials alone must never activate sending - the flag is the hard gate.
export function isSmsConfigured(): boolean {
  if (!isFeatureEnabled("smsNotifications")) return false;
  return resolveProviderId() === "noop" || hasSmsPortalCredentials();
}

export async function sendSms(params: SendSmsParams): Promise<SmsResult> {
  if (!isFeatureEnabled("smsNotifications")) {
    // Hard gate: the channel is off for this release.
    return { success: false, error: "SMS channel disabled", skipped: true };
  }
  const to = normalisePhoneNumber(params.to);
  if (!to || !isValidPhoneNumber(to)) {
    logger.warn(
      { destination: maskedPhoneNumber(params.to) },
      "SMS send rejected because the destination phone number is invalid",
    );
    return { success: false, error: "Invalid destination phone number" };
  }

  const provider = getSmsProvider();
  return provider.send({ to, body: params.body });
}
