# Turborepo for Cloud(gate) -- work in progress

#### What is gate (`packages/gate`)?
Gate is a cloudflare worker service responsible for creating and verifying unique API keys.

#### Note
You must have a workers paid plan in order to use durable objects.

#### Why?
- Cheap and intended to be self-hosted
- Powered by durable objects
  - Strongly consistent storage
  - Data is replicated across cloudflares global network, resulting in very low latency during key verification.
- Features
  - [ ] Per-object rate limiting 
  - [x] Per-object number of uses before being destroyed
  - [x] Per-object expiration before being destroyed

