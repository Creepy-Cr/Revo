---
name: Proposal response shape is shared with the drill
description: Why the proposal `status` field must stay an open string in the API spec, and what breaks the moment it is tightened.
---

The proposals list endpoint serves two unrelated things through one response
schema: real rows from the database, and the in-memory safety drill, which is
synthesised per request and prepended to the array.

**Rule: do not model proposal `status` as an enum in the OpenAPI spec.**

**Why:** the drill reports its own display-only phases in a different case
convention from the database statuses. They are not proposal states at all -
they describe how far the drill animation has progressed, and the ids they
carry belong to no row, so they can never be approved or rejected. Adding an
enum looks like a tidy contract improvement and passes every test, then returns
a validation failure for the whole endpoint the moment an operator starts a
drill. The generated zod validates the outgoing response, so this fails on the
server, not the client, and it takes the real proposals down with it.

**How to apply:** when tightening any field on the proposal response, check
what the drill puts in that field first. The same caution applies to making a
new field required: the drill payload is built by hand and will not have it.
There is a contract test pinning the drill's phases against the generated
response schema - keep it passing rather than deleting it.

The mirror-image trap: making the drill conform by lowercasing its phases is
worse than the enum. The console keys its approve and reject buttons off the
status string, so a conforming drill would render live action buttons on a
proposal that does not exist.
