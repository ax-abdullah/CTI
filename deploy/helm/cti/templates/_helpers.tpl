{{/* Base name, overridable. */}}
{{- define "cti.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "cti.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name (include "cti.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "cti.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
app.kubernetes.io/name: {{ include "cti.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{/* Selector for one role's pods. */}}
{{- define "cti.selectorLabels" -}}
app.kubernetes.io/name: {{ include "cti.name" .root }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .role }}
{{- end -}}

{{- define "cti.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "cti.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "cti.image" -}}
{{- printf "%s:%s" .Values.image.repository (default .Chart.AppVersion .Values.image.tag) -}}
{{- end -}}

{{- define "cti.secretName" -}}
{{- if .Values.secrets.existingSecret -}}
{{- .Values.secrets.existingSecret -}}
{{- else -}}
{{- printf "%s-secrets" (include "cti.fullname" .) -}}
{{- end -}}
{{- end -}}

{{/*
Environment shared by every role. CTI_ROLE is appended per workload — it is
the only thing that differs between them.

POD_ID comes from the pod name so ownership leases are attributable to a
specific pod; the app appends a random suffix so a restarted pod never
mistakes its predecessor's lease for its own.
*/}}
{{- define "cti.envVars" -}}
- name: POD_ID
  valueFrom:
    fieldRef:
      fieldPath: metadata.name
{{- end -}}

{{- define "cti.envFrom" -}}
- configMapRef:
    name: {{ include "cti.fullname" . }}-config
- secretRef:
    name: {{ include "cti.secretName" . }}
{{- end -}}
