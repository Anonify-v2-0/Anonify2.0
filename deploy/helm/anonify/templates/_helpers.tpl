{{/* Names */}}
{{- define "anonify.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "anonify.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "anonify.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{ include "anonify.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "anonify.selectorLabels" -}}
app.kubernetes.io/name: {{ include "anonify.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/* Labels for one role: web, worker, migrate, cleanup. */}}
{{- define "anonify.roleLabels" -}}
{{ include "anonify.selectorLabels" .root }}
app.kubernetes.io/component: {{ .role }}
{{- end }}

{{- define "anonify.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "anonify.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/* The image, by digest when one is given. */}}
{{- define "anonify.image" -}}
{{- $tag := default .Chart.AppVersion .Values.image.tag -}}
{{- if .Values.image.digest -}}
{{ .Values.image.repository }}@{{ .Values.image.digest }}
{{- else -}}
{{ .Values.image.repository }}:{{ $tag }}
{{- end -}}
{{- end }}

{{/* The Secret every pod reads its environment from. */}}
{{- define "anonify.secretName" -}}
{{- default (include "anonify.fullname" .) .Values.secrets.existingSecret }}
{{- end }}

{{/*
The key holding a direct database connection: WORKFLOW_POSTGRES_URL when the
chart was given one, else DATABASE_URL. An explicit key wins.
*/}}
{{- define "anonify.directUrlKey" -}}
{{- $explicit := .explicit -}}
{{- if $explicit -}}
{{ $explicit }}
{{- else if .root.Values.database.workflowUrl -}}
WORKFLOW_POSTGRES_URL
{{- else -}}
DATABASE_URL
{{- end -}}
{{- end }}

{{/*
Whole CPUs in a Kubernetes quantity, rounded down and never below one: what
the app itself would count from the cgroup quota (#181). "2" is 2, "1500m"
is 1, "500m" is 1. Empty when there is no limit.
*/}}
{{- define "anonify.cpus" -}}
{{- $limit := "" -}}
{{- with .limits }}{{ with .cpu }}{{ $limit = toString . }}{{ end }}{{ end -}}
{{- if $limit -}}
{{- $cpus := 0 -}}
{{- if hasSuffix "m" $limit -}}
{{- $cpus = div (atoi (trimSuffix "m" $limit)) 1000 -}}
{{- else -}}
{{- $cpus = int (floor (float64 $limit)) -}}
{{- end -}}
{{ max 1 $cpus }}
{{- end -}}
{{- end }}

{{/* KEDA's API, as this cluster serves it. */}}
{{- define "anonify.hasKeda" -}}
{{- if .Capabilities.APIVersions.Has "keda.sh/v1alpha1" -}}true{{- end -}}
{{- end }}

{{/* How the worker scales: keda, hpa or none, with auto resolved. */}}
{{- define "anonify.workerScaling" -}}
{{- $mode := .Values.worker.autoscaling.mode -}}
{{- if eq $mode "auto" -}}
{{- if include "anonify.hasKeda" . }}keda{{ else }}hpa{{ end -}}
{{- else if has $mode (list "keda" "hpa" "none") -}}
{{ $mode }}
{{- else -}}
{{- fail (printf "worker.autoscaling.mode must be auto, keda, hpa or none, not %q" $mode) -}}
{{- end -}}
{{- end }}

{{/*
The pod spec both roles share; `role` is web or worker. Each sets its own
replicas, scheduling and extra environment around it.
*/}}
{{- define "anonify.podSpec" -}}
{{- $root := .root -}}
{{- $role := .role -}}
{{- $values := index $root.Values $role -}}
serviceAccountName: {{ include "anonify.serviceAccountName" $root }}
{{- with $root.Values.imagePullSecrets }}
imagePullSecrets:
  {{- toYaml . | nindent 2 }}
{{- end }}
securityContext:
  {{- toYaml $root.Values.podSecurityContext | nindent 2 }}
# The drain (#182) has ANONIFY_DRAIN_SECONDS from the signal; this leaves it
# that and fifteen seconds more before the kubelet sends SIGKILL.
terminationGracePeriodSeconds: {{ add (int $root.Values.drainSeconds) 15 }}
containers:
  - name: {{ $role }}
    image: {{ include "anonify.image" $root }}
    imagePullPolicy: {{ $root.Values.image.pullPolicy }}
    args: ["serve"]
    ports:
      - name: http
        containerPort: 3000
        protocol: TCP
    envFrom:
      - configMapRef:
          name: {{ include "anonify.fullname" $root }}
      - secretRef:
          name: {{ include "anonify.secretName" $root }}
      {{- with $root.Values.envFrom }}
      {{- toYaml . | nindent 6 }}
      {{- end }}
    env:
      - name: ANONIFY_ROLE
        value: {{ $role }}
      {{- $cpus := include "anonify.cpus" $values.resources }}
      {{- if and $cpus (not (hasKey $values.env "ANONIFY_CPU_CONCURRENCY")) (not (hasKey $root.Values.env "ANONIFY_CPU_CONCURRENCY")) }}
      # From resources.limits.cpu, as the app would count the quota.
      - name: ANONIFY_CPU_CONCURRENCY
        value: {{ $cpus | quote }}
      {{- end }}
      {{- range $name, $value := $values.env }}
      - name: {{ $name }}
        value: {{ $value | toString | quote }}
      {{- end }}
    livenessProbe:
      httpGet: { path: /api/health, port: http }
      {{- toYaml $root.Values.probes.liveness | nindent 6 }}
    readinessProbe:
      httpGet: { path: /api/ready, port: http }
      {{- toYaml $root.Values.probes.readiness | nindent 6 }}
    startupProbe:
      httpGet: { path: /api/health, port: http }
      {{- toYaml $root.Values.probes.startup | nindent 6 }}
    resources:
      {{- toYaml $values.resources | nindent 6 }}
    securityContext:
      {{- toYaml $root.Values.securityContext | nindent 6 }}
    volumeMounts:
      - name: tmp
        mountPath: /tmp
      - name: data
        mountPath: /data
volumes:
  - name: tmp
    emptyDir: {}
  - name: data
    {{- if $root.Values.persistence.enabled }}
    persistentVolumeClaim:
      claimName: {{ include "anonify.fullname" $root }}-data
    {{- else }}
    emptyDir: {}
    {{- end }}
{{- with $values.nodeSelector }}
nodeSelector:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with $values.tolerations }}
tolerations:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with $values.affinity }}
affinity:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with $values.topologySpreadConstraints }}
topologySpreadConstraints:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- end }}
