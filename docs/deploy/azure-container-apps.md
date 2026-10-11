# Azure: Container Apps

> **Draft.** Written from the Azure documentation and the
> [contract](./README.md#the-contract); not yet followed end to end on an
> Azure subscription. Verification is tracked in #247.

**Verified on:** not yet.

## Architecture

```
 browser ─► Container App "anonify-web" (external ingress, HTTP scale rule, ANONIFY_ROLE=web)
                     │ starts runs
 PostgreSQL Flexible Server ◄── Container App "anonify-worker" (no ingress,
   (PgBouncer :6432 for web,       KEDA postgresql scale rule, min 0, ANONIFY_ROLE=worker)
    :5432 direct for the queue)              │
                                   Blob Storage (managed identity, #176)
 Container Apps Job "anonify-migrate" (manual trigger, args: migrate)
```

Container Apps runs KEDA for you, so workers can **scale to zero** on the
queue, as with the Helm chart.

## Prerequisites

A Container Apps environment, an Azure Database for PostgreSQL Flexible
Server (15+) with built-in PgBouncer enabled, a storage account with a
container, a Key Vault, and a user-assigned managed identity with **Storage
Blob Data Contributor** on the storage account and **Key Vault Secrets User**
on the vault.

## Database

- `DATABASE_URL`: port **6432**, the built-in PgBouncer, for the app's
  connections.
- `WORKFLOW_POSTGRES_URL`: port **5432**, direct, for the job queue, which
  `LISTEN`s and needs a session ([database.md](./database.md)).

## Storage

The Azure Blob driver (#176) with the managed identity, no keys:

```
STORAGE_DRIVER=azure-blob
AZURE_STORAGE_ACCOUNT=myanonify
AZURE_STORAGE_CONTAINER=anonify
AZURE_CLIENT_ID=<the identity's client id>
```

Browser uploads use a user delegation SAS, which needs the same role
([storage.md](../storage.md)).

## Secrets

Container App secrets as Key Vault references, read with the identity:

```sh
az containerapp secret set -n anonify-web -g rg \
  --secrets encryption-key=keyvaultref:https://kv.vault.azure.net/secrets/anonify-encryption-key,identityref:$IDENTITY_ID
```

and `--env-vars ENCRYPTION_KEY=secretref:encryption-key …`.

## Deploy web

```sh
az containerapp create -n anonify-web -g rg --environment env \
  --image docker.io/nabeelwasif/anonify2.0:1.18.0 --args serve \
  --ingress external --target-port 3000 \
  --cpu 1 --memory 2Gi --min-replicas 1 --max-replicas 10 \
  --scale-rule-name http --scale-rule-type http --scale-rule-http-concurrency 40 \
  --user-assigned $IDENTITY_ID \
  --env-vars ANONIFY_ROLE=web ANONIFY_DRAIN_SECONDS=120 …
```

Probes and the grace period go in the app's YAML (`az containerapp update
--yaml`): liveness and startup on `/api/health`, readiness on `/api/ready`,
`terminationGracePeriodSeconds: 130`.

## Deploy worker

No ingress, and a KEDA `postgresql` custom scale rule on the queue, the same
query as the Helm chart ([operations.md](../operations.md#autoscaling-workers)):

```yaml
properties:
  configuration:
    ingress: null
    secrets:
      - name: queue-connection
        keyVaultUrl: https://kv.vault.azure.net/secrets/anonify-workflow-url
        identity: <identity resource id>
  template:
    terminationGracePeriodSeconds: 130
    containers:
      - name: worker
        image: docker.io/nabeelwasif/anonify2.0:1.18.0
        args: [serve]
        resources: { cpu: 2, memory: 4Gi }
        env:
          - { name: ANONIFY_ROLE, value: worker }
    scale:
      minReplicas: 0
      maxReplicas: 10
      rules:
        - name: queue
          custom:
            type: postgresql
            metadata:
              query: >-
                SELECT count(*) FROM graphile_worker.jobs
                WHERE task_identifier IN ('workflow_flows', 'workflow_steps')
                  AND (locked_at IS NOT NULL OR (attempts < max_attempts AND run_at <= now()))
              targetQueryValue: "4"
              activationTargetQueryValue: "0"
            auth:
              - secretRef: queue-connection
                triggerParameter: connection
```

With `minReplicas: 0`, the first document after an idle period waits for the
next poll (30s) and a replica to start.

## Migrations

A Container Apps job with a manual trigger, started before each update:

```sh
az containerapp job create -n anonify-migrate -g rg --environment env \
  --trigger-type Manual --replica-timeout 600 --replica-retry-limit 1 \
  --image docker.io/nabeelwasif/anonify2.0:1.18.0 --args migrate \
  --env-vars DATABASE_URL=secretref:workflow-url …
az containerapp job start -n anonify-migrate -g rg
```

## Sweep

Built into the workers, but a worker at zero sweeps nothing. With
`minReplicas: 0`, add a scheduled job running `cleanup` every 10 minutes
(`--trigger-type Schedule --cron-expression "*/10 * * * *" --args cleanup`),
or keep one worker.

## Autoscaling

- **web:** the HTTP rule, 40 concurrent requests per replica.
- **worker:** the KEDA rule above; to zero when the queue is empty.

## Timeouts and progress streams

Container Apps ingress keeps streamed responses open, but check its request
timeout on your environment (240 seconds is the commonly documented
default) against a long OCR step: a cut stream reconnects and resumes, so
the effect is a reconnect, not a failure.

## Upgrades

Start the migrate job and wait for it to succeed, then update both apps.
With single revision mode, a new revision takes traffic once ready, and the
old replicas drain within `terminationGracePeriodSeconds`.

## Costs to watch

vCPU and memory seconds of active replicas (an idle worker at zero costs
nothing), the Flexible Server, and Blob transactions.
