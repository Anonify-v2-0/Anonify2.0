# AWS: ECS on Fargate

> **Draft.** Written from the AWS documentation and the
> [contract](./README.md#the-contract); not yet followed end to end on an AWS
> account. Verification is tracked in #247. Expect to adjust
> details; the contract parts hold everywhere.

**Verified on:** not yet.

## Architecture

```
 browser ─► ALB (HTTPS) ─► ECS service "web" (Fargate, ANONIFY_ROLE=web)
                                                        │
                       RDS Proxy ◄── web               │ starts runs
 RDS / Aurora PostgreSQL ◄─────────── ECS service "worker" (Fargate, ANONIFY_ROLE=worker, no LB)
                                                        │
                                                  S3 bucket (task roles, no keys)
```

## Prerequisites

A VPC with private subnets for the tasks (NAT or VPC endpoints for S3, ECR
or Docker Hub, CloudWatch and Secrets Manager), an RDS or Aurora PostgreSQL
15+ instance, an S3 bucket, and an ECS cluster. The image is pulled from
Docker Hub (`nabeelwasif/anonify2.0`); an ECR pull-through cache avoids
Docker Hub's anonymous rate limit and NAT data charges.

## Database

`DATABASE_URL` may go through **RDS Proxy** for web, which opens many short
connections. The job queue `LISTEN`s, which pins an RDS Proxy session and
gains nothing, so `WORKFLOW_POSTGRES_URL` points at the instance (or the
Aurora writer endpoint) directly ([database.md](./database.md)). Size
`max_connections` for 21 per replica.

## Storage

S3 through the task role, with no keys:

```json
{ "Effect": "Allow",
  "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"],
  "Resource": ["arn:aws:s3:::my-anonify", "arn:aws:s3:::my-anonify/*"] }
```

`STORAGE_DRIVER=s3`, `S3_BUCKET`, `S3_REGION`. For browser uploads straight
to the bucket, `S3_PRESIGNED_UPLOADS=true` and a CORS rule allowing `PUT`
from your origin ([storage.md](../storage.md)); the app checks it at start
(#185).

## Secrets

Secrets Manager or SSM Parameter Store, through the task definition's
`secrets` (`ENCRYPTION_KEY`, `FINGERPRINT_SECRET`, `CRON_SECRET`,
`DATABASE_URL`, `WORKFLOW_POSTGRES_URL`). Make the first three with
`docker run --rm nabeelwasif/anonify2.0 keys`.

## Deploy web

A Fargate service behind an ALB target group on port 3000:

```json
{
  "family": "anonify-web",
  "requiresCompatibilities": ["FARGATE"],
  "networkMode": "awsvpc",
  "cpu": "1024", "memory": "2048",
  "runtimePlatform": { "cpuArchitecture": "ARM64", "operatingSystemFamily": "LINUX" },
  "taskRoleArn": "arn:aws:iam::…:role/anonify-task",
  "containerDefinitions": [{
    "name": "web",
    "image": "nabeelwasif/anonify2.0:1.18.0",
    "command": ["serve"],
    "portMappings": [{ "containerPort": 3000 }],
    "stopTimeout": 120,
    "readonlyRootFilesystem": true,
    "mountPoints": [
      { "sourceVolume": "tmp", "containerPath": "/tmp" },
      { "sourceVolume": "data", "containerPath": "/data" }
    ],
    "environment": [
      { "name": "ANONIFY_ROLE", "value": "web" },
      { "name": "ANONIFY_DRAIN_SECONDS", "value": "110" },
      { "name": "STORAGE_DRIVER", "value": "s3" },
      { "name": "S3_BUCKET", "value": "my-anonify" },
      { "name": "S3_REGION", "value": "eu-west-1" },
      { "name": "ANONIFY_PUBLIC_URL", "value": "https://anonify.example.com" }
    ],
    "secrets": [{ "name": "ENCRYPTION_KEY", "valueFrom": "arn:aws:secretsmanager:…" }],
    "healthCheck": {
      "command": ["CMD", "node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"],
      "interval": 15, "timeout": 5, "retries": 4, "startPeriod": 60
    }
  }],
  "volumes": [{ "name": "tmp" }, { "name": "data" }]
}
```

The target group's health check is `/api/ready`. The image is multi-arch, so
Graviton (`ARM64`) runs it as is and costs less per vCPU.

## Deploy worker

The same task definition with `ANONIFY_ROLE=worker`, no port mapping and no
load balancer, 2 vCPU and 4 GiB per task (one worker unit,
[capacity.md](./capacity.md)), and the same `stopTimeout`.

## Migrations

Before each `update-service`, a one-off task from the new task definition:

```sh
aws ecs run-task --cluster anonify --task-definition anonify-web:42 \
  --launch-type FARGATE --network-configuration "$NETWORK" \
  --overrides '{"containerOverrides":[{"name":"web","command":["migrate"],
    "environment":[{"name":"DATABASE_URL","value":"<direct URL>"}]}]}'
aws ecs wait tasks-stopped --cluster anonify --tasks "$TASK"
# then check its exit code is 0 before rolling out
```

## Sweep

Built into the workers. Or turn it off (`ANONIFY_SCHEDULER=off`) and run
`cleanup` as a task from EventBridge Scheduler every 10 minutes.

## Autoscaling

- **web:** target tracking on `ECSServiceAverageCPUUtilization` at 60, or
  `ALBRequestCountPerTarget`.
- **worker:** step scaling on a CloudWatch metric of queue depth. Publish
  `anonify_queue_jobs_ready` and `anonify_queue_oldest_ready_seconds` from
  `/api/metrics` with the CloudWatch agent's Prometheus scraping or an ADOT
  collector sidecar, and scale out above about 5 ready jobs per task or 60
  seconds of age. **Minimum 1**: nothing watches the queue at zero.

## Timeouts and progress streams

- **ALB idle timeout:** the default 60s is enough. Progress streams send a
  keep-alive comment after 15 quiet seconds (#244), so the ALB never sees
  them idle.
- **Fargate `stopTimeout`:** at most 120s. Set `ANONIFY_DRAIN_SECONDS=110`.
  ECS deregisters a task from the target group first, waits the
  deregistration delay, then sends `SIGTERM`; keep the deregistration delay
  short (30s) so a rollout does not wait twice.

## Upgrades

Migrate (above), then `update-service` with the new task definition. Rolling
updates with `minimumHealthyPercent: 100` and `maximumPercent: 200` keep the
old tasks serving until the new ones pass `/api/ready`.

## Costs to watch

Fargate vCPU and memory hours (Graviton is cheaper), the NAT gateway's
per-GB charge for image pulls and S3 traffic (use VPC endpoints), RDS
instance hours, and RDS Proxy per vCPU of the database.
