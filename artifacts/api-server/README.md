# API Server - SMS notifications

This document describes the order-status SMS notification path in the Express API
server, the SMSPortal provider contract, and the phone-number normalization that
happens at the provider boundary.

## Flow

1. The admin UI (`artifacts/olyxee-admin/src/pages/order-detail.tsx`) triggers
   `useUpdateOrderStatus` (`artifacts/olyxee-admin/src/hooks/use-supabase-queries.ts:672`).
2. It sends `POST /api/orders/:orderId/status` with `status`, `message`, and
   `notifyCustomer`. The phone number is **not** sent — the backend looks it up.
3. The route handler (`src/routes/orders.ts:912`) joins `orders.customerId` to
   `customers.id` and passes `customer.phone` into `sendOrderSms`.
4. `sendOrderSms` (`src/lib/order-notifications.ts`) builds the message body and
   calls `sendSms` (`src/lib/sms.ts`).
5. `sendSms` normalizes the phone number, then hands the payload to the active
   provider, which posts to SMSPortal's `/BulkMessages` endpoint.

## Phone-number normalization

SMSPortal requires international numbers in E.164 format. Customer records may
still contain common South African local or formatted values, so conversion
happens here at the provider boundary rather than changing the customer schema
or the admin form.

`normalisePhoneNumber` (`src/lib/sms.ts:42`):

| Input | Output |
| --- | --- |
| `0821234567` | `+27821234567` |
| `+27821234567` | `+27821234567` |
| `27821234567` | `+27821234567` |
| `082 123 4567` | `+27821234567` |
| `+27 (82) 123-4567` | `+27821234567` |

Invalid, incomplete, empty, or malformed values (`   `, `123`, `082123`,
`not-a-number`, a `+` that is not leading) are rejected **before** any provider
request. Rejected destinations produce a controlled failure and masked
diagnostic logging — the full phone number is never logged.

## Provider contract

- Auth: `GET https://rest.smsportal.com/Authentication` with HTTP Basic
  (`SMSPORTAL_CLIENT_ID` / `SMSPORTAL_API_SECRET`), returns a bearer token.
- Send: `POST https://rest.smsportal.com/BulkMessages` with
  `Authorization: Bearer <token>` and a JSON body:
  ```json
  {
    "messages": [
      { "content": "Your order has shipped", "destination": "+27821234567" }
    ],
    "sendOptions": { "senderId": "Acme" }
  }
  ```
- `SMS_SENDER_ID` is optional. The token is cached and refreshed one minute early;
  a 401 on the send triggers one re-auth and retry.

## Safety gates

- `featureFlags.smsNotifications` is the hard gate. It is `false` in
  `lib/plans/src/index.ts:169`, so production SMS sending is intentionally
  disabled unless an authorized test/deployment environment enables it.
- `NODE_ENV === "test"` forces the no-op provider, so automated tests can never
  reach a real SMS gateway.
- An unrecognized `SMS_PROVIDER` value falls back to the safe no-op provider
  instead of SMSPortal.
- **Dedupe** (`src/lib/sms-dedup.ts`): a retried request (client resubmit, a
  double-click, a reconnect-and-retry after a timeout) must never fan out a
  second identical SMS. A send is treated as a duplicate when the same order
  already has a successfully-sent SMS with this exact body within the last
  5 minutes. The automatic status-change path checks this; the explicit resend
  path (`POST /orders/:orderId/resend-email`, `orders.ts:1230`) bypasses it
  with `skipDuplicateCheck: true` because a user-triggered resend should always
  go out. Known gap: dedupe is a read-then-write, not a transactional lock, so
  two genuinely concurrent requests for the same order can still double-send.

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `SMS_PROVIDER` | no | `smsportal` (default) or `noop`. Forced to `noop` in tests. |
| `SMSPORTAL_CLIENT_ID` | for SMSPortal | SMSPortal REST API Client ID |
| `SMSPORTAL_API_SECRET` | for SMSPortal | SMSPortal REST API Secret |
| `SMS_SENDER_ID` | no | Registered sender ID / branded sender name |

## Tests

- `src/__tests__/sms.test.ts` — phone validation, flag gating, provider
  selection, and the SMSPortal HTTP contract (25 tests).
- `src/__tests__/sms-provider.test.ts` — SMSPortal provider integration with a
  mocked `fetch`: auth caching, 401 retry, error mapping, sender ID, and
  destination normalization (26 tests).
- `src/__tests__/order-sms-notifications.test.ts` — the `sendOrderSms`
  orchestrator: trigger conditions, plan SMS limits, template content, dedupe
  behavior, and concurrent double-send gap (16 tests).

Run them with `pnpm --filter @workspace/api-server test`, or directly:

```bash
cd artifacts/api-server
./node_modules/.bin/vitest run src/__tests__/sms.test.ts src/__tests__/sms-provider.test.ts
```