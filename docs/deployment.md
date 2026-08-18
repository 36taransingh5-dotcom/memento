# Deploying Memento

Memento is a standard Next.js `standalone` build with no stateful local storage — every durable byte lives in CockroachDB. Any container platform works; this guide covers **AWS App Runner** (simplest) and **ECS Fargate** (more control), both alongside **CockroachDB Cloud**.

## 1. CockroachDB Cloud

1. Create a cluster (Serverless is fine for demo traffic; Dedicated for production).
2. Create the `memento` database and a SQL user, or let `npm run db:migrate` create the database if your role has `CREATEDB`.
3. Copy the connection string from **Connect → General connection string** — it already includes `sslmode=verify-full`.
4. From a machine that can reach the cluster:
   ```bash
   DATABASE_URL="<cloud connection string>" npm run db:migrate
   DATABASE_URL="<cloud connection string>" npm run db:seed
   ```
5. Confirm the vector index is active:
   ```bash
   DATABASE_URL="<cloud connection string>" npm run db:health
   ```
   If `feature.vector_index.enabled` isn't exposed on your tier, the migration skips gracefully and semantic search still works via an exact scan — nothing else to configure.

## 2. Amazon Bedrock model access

In the Bedrock console, open a model (Model catalog → the model card → Playground) in the region you'll deploy to. AWS retired the old checkbox-based "Model access" request page — serverless models now activate on first successful invoke, account-wide.

Three things that will trip you up on a fresh AWS account, in the order you're likely to hit them:

1. **Billing.** Bedrock model invocation (any model) requires a valid payment method on the AWS account, checked independently of whether the model itself is "available." A missing/declined card surfaces as `INVALID_PAYMENT_INSTRUMENT` on invoke — fix it under **Billing → Payment preferences**, then wait ~5 minutes.
2. **The newest Claude generation needs AWS Sales approval.** Sonnet 5, Opus 4.8, and Opus 4.7 are served via Bedrock's Mantle endpoint and return `permission_error` ("not available for this account") on a standard self-service account, even with billing fixed and even after a successful console Playground click-through. This isn't a self-service toggle — see the message for AWS Sales contact details. `BEDROCK_MODEL_ID` therefore defaults to the newest *generally available* model instead (see `.env.example`).
3. **On-demand invocation needs an inference-profile ID.** The bare model ID that works in the console Playground (`anthropic.claude-sonnet-4-5-20250929-v1:0`) 400s over the API with "on-demand throughput isn't supported." Prefix it with the region-group code — `us.anthropic.claude-sonnet-4-5-20250929-v1:0` from a US region — which is what actually needs `bedrock:InvokeModel` permission.

For the embedding model, same idea: try `amazon.titan-embed-text-v2:0` in the Playground once billing is fixed; it typically doesn't need the Mantle-gated approval that the newest Claude models do.

If none of the above resolves it before a deadline, Memento degrades gracefully — the deterministic policy engine still produces real, auditable decisions with no LLM reasoning layer, and semantic memory falls back to a local lexical hash. Nothing crashes; `ALLOW_DEGRADED_AI=true` (the default) is what makes that safe.

## 3. IAM permissions

The compute role needs `bedrock:InvokeModel` scoped to the two model ARNs:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "bedrock:InvokeModel",
      "Resource": [
        "arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-5",
        "arn:aws:bedrock:*::foundation-model/amazon.titan-embed-text-v2:0"
      ]
    }
  ]
}
```

No static AWS keys — the app resolves credentials via the default SDK chain, which App Runner and Fargate satisfy automatically through the instance/task role.

## 4a. AWS App Runner (simplest)

1. Push the repo to a connected source (GitHub) or build and push an image to ECR:
   ```bash
   docker build -t memento .
   aws ecr create-repository --repository-name memento
   docker tag memento:latest <account>.dkr.ecr.<region>.amazonaws.com/memento:latest
   docker push <account>.dkr.ecr.<region>.amazonaws.com/memento:latest
   ```
2. Create an App Runner service from that image.
   - Port: `3000`
   - Start command: `node server.js` (the `standalone` output's entrypoint)
3. Attach an instance role with the IAM policy above.
4. Set environment variables (App Runner → Configuration → Environment variables): `DATABASE_URL`, `AWS_REGION`, `BEDROCK_MODEL_ID`, `BEDROCK_EMBEDDING_MODEL_ID`, `EMBEDDING_DIMENSIONS=1024`, `NEXT_PUBLIC_APP_URL` (the App Runner URL once assigned).
5. Deploy. Run `npm run db:migrate && npm run db:seed` once, from anywhere that can reach the cluster, before first traffic.

A minimal `Dockerfile` for the standalone output:

```dockerfile
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine AS run
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
EXPOSE 3000
CMD ["node", "server.js"]
```

## 4b. ECS Fargate (more control)

1. Build and push the same image to ECR as above.
2. Create a Fargate task definition: 0.5 vCPU / 1 GB is enough for demo traffic; the container port is `3000`.
3. Task role: the IAM policy above. Task execution role: standard `AmazonECSTaskExecutionRolePolicy` plus ECR pull.
4. Environment variables: same list as App Runner, injected via the task definition or Secrets Manager for `DATABASE_URL`.
5. Put an Application Load Balancer in front, target group health check on `/`.
6. Run the same one-time migrate/seed step before routing traffic.

## 5. Production startup checklist

- [ ] `DATABASE_URL` points at CockroachDB Cloud with `sslmode=verify-full`
- [ ] `npm run db:migrate` has been run against that cluster
- [ ] `npm run db:seed` has been run (or your own data loaded)
- [ ] Bedrock model access approved for both models in the target region
- [ ] Compute role has `bedrock:InvokeModel` on both model ARNs
- [ ] `ALLOW_DEGRADED_AI=false` if a Bedrock outage should fail loudly rather than degrade
- [ ] `NEXT_PUBLIC_APP_URL` set to the real public URL

## Notes

- **No secrets in the image.** Everything sensitive is an environment variable resolved at runtime; nothing is baked into the Docker build.
- **Stateless compute.** Any number of instances can run concurrently — CockroachDB is the only shared state, and its SERIALIZABLE isolation with automatic client-side retry (`src/lib/db/client.ts`) handles the concurrent-write contention that implies.
- **Scaling the database**, not the app, is what matters under load: CockroachDB's distributed C-SPANN index scales the vector search horizontally as memory volume grows — see the [C-SPANN blog post](https://www.cockroachlabs.com/blog/cspann-real-time-indexing-billions-vectors/) for how it holds up at billions of vectors.
