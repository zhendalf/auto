# Q-14 — Webhook trigger contract and delivery semantics

## Context

Q-03 reserves `webhook` as a trigger kind and Q-07 reserves
`POST /hooks/:trigger_name` as loopback-only ingress exposed through a
path-filtered tunnel. The remaining design work is to define a small generic
contract that is safe for GitHub-shaped HMAC webhooks without baking GitHub
into the supervisor.

A webhook is an observation supplied by a remote system. Receiving one is not
proof that an action succeeded, and providers may retry, duplicate, reorder,
or delay deliveries. The adapter therefore needs explicit authentication,
deduplication, payload, and response semantics before implementation.

## Options

### a) Provider-specific adapters

Add a schema and route implementation for GitHub, Stripe, Slack, and each
future source.

- Pros: excellent provider-specific validation and metadata.
- Cons: grows the trusted HTTP surface for every provider and makes the
  supervisor an integrations framework.

### b) One generic signed-body adapter with a small verifier profile

Each webhook trigger selects an authentication profile, the signature header,
an optional delivery-ID header, accepted content types, and size limit. The
adapter verifies the raw request body, derives bounded metadata, deduplicates
the delivery, and enqueues the existing worker.

- Pros: small control-plane contract; covers GitHub and most HMAC providers;
  provider-specific parsing stays in an isolated worker.
- Cons: sources with unusual signing schemes will need a later profile or a
  dedicated ingress bridge.

### c) Execute an arbitrary verifier function in the server

- Pros: maximum flexibility.
- Cons: untrusted request handling can hang or compromise the supervisor;
  inline code violates the process-isolation decision in Q-02.

## Recommendation

Choose **(b): a generic signed-body adapter with named verifier profiles**.

Example definition:

```ts
{
  kind: "webhook",
  id: "github-release",
  path: "github-release",
  auth: {
    profile: "hmac-sha256",
    secretRef: "github-release-webhook",
    signatureHeader: "x-hub-signature-256",
    signaturePrefix: "sha256=",
  },
  deliveryIdHeader: "x-github-delivery",
  contentTypes: ["application/json"],
  maxBodyBytes: 1_048_576,
  keepPayload: false,
}
```

### Request lifecycle

1. Match exactly one enabled trigger by `path`; trigger paths are globally
   unique even when trigger IDs are only unique within a job.
2. Reject unsupported method, content type, missing length for oversized
   streams, or declared body length over the configured cap before reading the
   body. Enforce the cap again while streaming.
3. Verify the signature over the exact raw bytes using constant-time digest
   comparison. JSON parsing happens only after authentication.
4. Compute a SHA-256 body digest. Use the authenticated provider delivery ID
   when present, otherwise a bounded dedupe key derived from trigger ID and
   digest.
5. Insert a durable delivery receipt before enqueueing. Duplicate accepted
   deliveries return success without enqueueing a second action.
6. Enqueue the normal worker and return `202 Accepted` with an opaque local
   receipt ID. The response does not wait for worker completion.

### Payload and worker contract

- `TRIGGER_META` contains only bounded summaries: contract version, receipt
  ID, delivery ID if present, body digest, content type, byte count, received
  time, and selected allowlisted headers.
- The authenticated body is written to a private temporary payload file for
  the worker and exposed as `TRIGGER_PAYLOAD_PATH`. This file exists even when
  `keepPayload` is false, then is deleted after the terminal run state.
- `keepPayload: true` retains the file under `data/payloads/`; default false.
- Payload paths are never accepted from the request and never included in
  externally visible responses.
- Worker failures do not erase the delivery receipt or automatically rerun the
  action. Provider retries are deduplicated. Retrying a failed action is an
  explicit supervisor operation using the stored payload only when retention
  permits it.

### Authentication and secrets

- V1 supports `hmac-sha256`; `none` is not a production profile.
- Missing `secretRef` degrades only that trigger and prevents route activation.
- Secrets come from the supervisor secret store, are never placed in config or
  trigger metadata, and are included in exact-value run-log redaction.
- The public tunnel must expose only `/hooks/*`, preserve raw request bytes,
  impose its own request/rate limits, and fail closed. The Bun server remains
  bound to loopback.

### Delivery observability

Store a bounded webhook receipt independently of the run:

- receipt ID, trigger ID, delivery ID/digest key;
- received time, accepted/rejected/duplicate/enqueued disposition;
- run ID when enqueued;
- payload retention path when enabled;
- bounded rejection reason, never request bodies or signatures.

Rejected unauthenticated requests should be counted and rate-limited in logs,
not inserted as normal runs.

## Tradeoffs to flag

- **Accepted is not completed.** HTTP 202 means authenticated and durably
  admitted, not that the worker succeeded.
- **No automatic action replay in v1.** This avoids turning provider retries
  into repeated side effects. A later retry command needs an explicit
  idempotency contract.
- **Generic does not mean arbitrary.** Providers with asymmetric signatures,
  timestamp windows, or challenge handshakes require a reviewed verifier
  profile, not user code in the HTTP process.
- **Retained payloads may contain sensitive data.** Retention remains opt-in,
  private, bounded, and covered by cleanup policy.

## Question for reviewer

Should v1 implement one generic `hmac-sha256` webhook trigger with durable
delivery dedupe, ephemeral worker payload files, `202` admission receipts, and
no automatic replay of failed actions?

## User decision

**Accepted on 2026-09-21.** Implement the generic HMAC-SHA256 profile,
durable delivery deduplication, private payload-file handoff, and asynchronous
202 receipt contract.

## Codex verdict

**Verdict:** RECOMMEND

This keeps HTTP handling small and generic, preserves raw-body signature
correctness, and makes duplicate delivery behavior explicit before side
effects enter the picture.
