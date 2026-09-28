# Protocol and Hub implementation contract

- `@agent-transport/protocol` is the only source of shared wire types and runtime validation.
- Every JSON response uses protocol version `1`; inbox items remain structurally separate from results and errors.
- `workspaceId` plus `internalKey` is accepted only by registration and desktop bootstrap routes. Conversation traffic uses an opaque resume token.
- User messages receive a monotonic conversation sequence and at-least-once delivery. A response and its delivery ACK commit in one SQLite transaction and are idempotent by `responseId`.
- A conversation has at most one active waiter. The Hub never lets a legacy and transport claimant compete for the same conversation.
- Capability requests and results use `requestId` as their durable idempotency key.
- Image payloads are not embedded; messages carry bounded metadata (`id`, MIME, bytes, SHA-256, display name).
- Presence records transport, desktop, listening, working, stalled and closed dimensions independently.
