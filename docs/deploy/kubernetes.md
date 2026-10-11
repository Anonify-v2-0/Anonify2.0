# Kubernetes

Use the Helm chart: [deploy/helm/anonify](../../deploy/helm/anonify/README.md)
(#191). It is the reference the other recipes are written against, and the
same on EKS, GKE, AKS, OKE, k3s, OpenShift and on-prem.

**Verified on:** 2026-10-11, kind 1.31 with KEDA 2, Anonify 1.17.0: installed
into a namespace enforcing the `restricted` Pod Security Standard, `helm test`
and `pnpm smoke` passed with the worker woken from zero by KEDA, workers back
to zero after the cooldown, and an upgrade re-ran the migration and kept
`ENCRYPTION_KEY`. CI repeats this on every change to the chart
(`.github/workflows/helm.yml`).

| Section | Where the chart covers it |
| --- | --- |
| Architecture | `Deployment/web` + `Service` + optional `Ingress`; `Deployment/worker` with a headless `Service` for metrics only |
| Prerequisites | Postgres, S3 or Azure Blob, optionally KEDA ([README](../../deploy/helm/anonify/README.md#what-you-need-first)) |
| Database | `database.url`, and `database.workflowUrl` with a pooler ([database.md](./database.md)) |
| Storage | `storage.*`; credentials in the Secret or through workload identity |
| Secrets | `secrets.existingSecret`, or generated once and kept ([README](../../deploy/helm/anonify/README.md#secrets)) |
| Web and worker | `web.*`, `worker.*`; `ANONIFY_CPU_CONCURRENCY` follows the CPU limit |
| Migrations | A pre-install and pre-upgrade hook Job |
| Sweep | Built into the workers; `worker.scheduler: false` runs a CronJob instead |
| Autoscaling | HPA on CPU for web; KEDA on queue depth for workers, to zero; else an HPA from one ([README](../../deploy/helm/anonify/README.md#autoscaling)) |
| Timeouts and progress streams | Ingress annotations per controller ([README](../../deploy/helm/anonify/README.md#ingress-and-progress-streams)) |
| Upgrades | Migrate first, then a one-at-a-time roll with a drain ([README](../../deploy/helm/anonify/README.md#upgrades)) |
| Costs to watch | Worker nodes sized for the worker unit; with KEDA at zero, idle costs only the web pods and the database |

On a managed platform the chart's KEDA mode needs KEDA installed (an add-on
on AKS; a Helm install elsewhere). Without it the workers scale on CPU from
one.
