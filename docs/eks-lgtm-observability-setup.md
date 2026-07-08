# Full Observability Stack (LGTM) Setup on EKS

Grafana **L**oki (logs) + **G**rafana (dashboards) + **T**empo (traces) + **M**imir/**P**rometheus (metrics)

## Prerequisites

- Existing EKS cluster with OIDC provider enabled
- `kubectl`, `helm`, `eksctl`, `aws` CLI configured and authenticated
- Cluster admin access

**Architecture:**

| Signal   | Collector          | Storage         | Query/View |
|----------|---------------------|-----------------|------------|
| Metrics  | Prometheus          | Prometheus (or Mimir for long-term) | Grafana |
| Logs     | Grafana Alloy       | Loki (S3-backed)| Grafana |
| Traces   | OTel Collector      | Tempo (S3-backed)| Grafana |

Storage backend: **S3**, auth via **IRSA** (no static AWS credentials in-cluster).

---

## 1. Prerequisites Setup

```bash
export CLUSTER_NAME=your-cluster
export REGION=us-east-1
export ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

# Confirm/associate OIDC provider
eksctl utils associate-iam-oidc-provider \
  --cluster $CLUSTER_NAME --region $REGION --approve

# Add Helm repos
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo add grafana https://grafana.github.io/helm-charts
helm repo add open-telemetry https://open-telemetry.github.io/opentelemetry-helm-charts
helm repo update

kubectl create namespace monitoring
```

---

## 2. S3 Buckets + IAM (Loki & Tempo)

```bash
# Create buckets
aws s3api create-bucket --bucket ${CLUSTER_NAME}-loki-chunks --region $REGION
aws s3api create-bucket --bucket ${CLUSTER_NAME}-tempo-traces --region $REGION
```

### Loki IAM policy

```bash
cat <<EOF > loki-policy.json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["s3:ListBucket", "s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
    "Resource": [
      "arn:aws:s3:::${CLUSTER_NAME}-loki-chunks",
      "arn:aws:s3:::${CLUSTER_NAME}-loki-chunks/*"
    ]
  }]
}
EOF

aws iam create-policy \
  --policy-name LokiS3Policy \
  --policy-document file://loki-policy.json
```

### Tempo IAM policy

```bash
cat <<EOF > tempo-policy.json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["s3:ListBucket", "s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
    "Resource": [
      "arn:aws:s3:::${CLUSTER_NAME}-tempo-traces",
      "arn:aws:s3:::${CLUSTER_NAME}-tempo-traces/*"
    ]
  }]
}
EOF

aws iam create-policy \
  --policy-name TempoS3Policy \
  --policy-document file://tempo-policy.json
```

### IRSA service accounts

```bash
eksctl create iamserviceaccount \
  --cluster $CLUSTER_NAME --region $REGION \
  --namespace monitoring --name loki-sa \
  --attach-policy-arn arn:aws:iam::${ACCOUNT_ID}:policy/LokiS3Policy \
  --approve

eksctl create iamserviceaccount \
  --cluster $CLUSTER_NAME --region $REGION \
  --namespace monitoring --name tempo-sa \
  --attach-policy-arn arn:aws:iam::${ACCOUNT_ID}:policy/TempoS3Policy \
  --approve
```

---

## 3. Prometheus + Grafana + Alertmanager

Using `kube-prometheus-stack` (bundles Prometheus, Grafana, Alertmanager, node-exporter, kube-state-metrics).

```yaml
# kube-prom-stack-values.yaml
grafana:
  adminPassword: "changeme"   # override with a Secret in production
  persistence:
    enabled: true
    size: 10Gi
  additionalDataSources:
    - name: Loki
      type: loki
      url: http://loki-gateway.monitoring.svc.cluster.local
      access: proxy
    - name: Tempo
      type: tempo
      url: http://tempo.monitoring.svc.cluster.local:3100
      access: proxy

prometheus:
  prometheusSpec:
    retention: 15d
    storageSpec:
      volumeClaimTemplate:
        spec:
          accessModes: ["ReadWriteOnce"]
          resources:
            requests:
              storage: 50Gi
    serviceMonitorSelectorNilUsesHelmValues: false
    podMonitorSelectorNilUsesHelmValues: false
```

```bash
helm install kube-prometheus-stack prometheus-community/kube-prometheus-stack \
  -n monitoring -f kube-prom-stack-values.yaml
```

---

## 4. Loki (Simple Scalable Mode, S3-backed)

```yaml
# loki-values.yaml
loki:
  auth_enabled: false
  serviceAccount:
    create: false
    name: loki-sa
  storage:
    type: s3
    bucketNames:
      chunks: ${CLUSTER_NAME}-loki-chunks
      ruler: ${CLUSTER_NAME}-loki-chunks
      admin: ${CLUSTER_NAME}-loki-chunks
    s3:
      region: ${REGION}
  schemaConfig:
    configs:
      - from: "2024-01-01"
        store: tsdb
        object_store: s3
        schema: v13
        index:
          prefix: loki_index_
          period: 24h

deploymentMode: SimpleScalable

write:
  replicas: 2
read:
  replicas: 2
backend:
  replicas: 2

gateway:
  enabled: true
```

> Replace `${CLUSTER_NAME}` and `${REGION}` with literal values, or `envsubst` the file before applying.

```bash
envsubst < loki-values.yaml > loki-values.rendered.yaml
helm install loki grafana/loki -n monitoring -f loki-values.rendered.yaml
```

---

## 5. Log Shipping — Grafana Alloy

```yaml
# alloy-values.yaml
alloy:
  configMap:
    content: |
      discovery.kubernetes "pods" {
        role = "pod"
      }

      loki.source.kubernetes "logs" {
        targets    = discovery.kubernetes.pods.targets
        forward_to = [loki.write.default.receiver]
      }

      loki.write "default" {
        endpoint {
          url = "http://loki-gateway.monitoring.svc.cluster.local/loki/api/v1/push"
        }
      }
```

```bash
helm install alloy grafana/alloy -n monitoring -f alloy-values.yaml
```

---

## 6. Tempo (S3-backed Traces)

```yaml
# tempo-values.yaml
tempo:
  serviceAccount:
    create: false
    name: tempo-sa
  storage:
    trace:
      backend: s3
      s3:
        bucket: ${CLUSTER_NAME}-tempo-traces
        region: ${REGION}
  traces:
    otlp:
      grpc:
        enabled: true
      http:
        enabled: true
```

```bash
envsubst < tempo-values.yaml > tempo-values.rendered.yaml
helm install tempo grafana/tempo-distributed -n monitoring -f tempo-values.rendered.yaml
```

---

## 7. OTel Collector (App Traces → Tempo)

```yaml
# otel-collector-values.yaml
mode: deployment
config:
  receivers:
    otlp:
      protocols:
        grpc:
          endpoint: 0.0.0.0:4317
        http:
          endpoint: 0.0.0.0:4318
  exporters:
    otlp:
      endpoint: tempo-distributor.monitoring.svc.cluster.local:4317
      tls:
        insecure: true
  service:
    pipelines:
      traces:
        receivers: [otlp]
        exporters: [otlp]
```

```bash
helm install otel-collector open-telemetry/opentelemetry-collector \
  -n monitoring -f otel-collector-values.yaml
```

Point application instrumentation (OTel SDK) at:
```
otel-collector.monitoring.svc.cluster.local:4317
```

---

## 8. (Optional) Mimir — Long-Term Metrics Storage

Only needed if Prometheus's local retention (15d) isn't sufficient.

```bash
aws s3api create-bucket --bucket ${CLUSTER_NAME}-mimir-blocks --region $REGION
```

```yaml
# mimir-values.yaml
mimir:
  structuredConfig:
    common:
      storage:
        backend: s3
        s3:
          endpoint: s3.${REGION}.amazonaws.com
          bucket_name: ${CLUSTER_NAME}-mimir-blocks
          region: ${REGION}
minio:
  enabled: false
```

```bash
envsubst < mimir-values.yaml > mimir-values.rendered.yaml
helm install mimir grafana/mimir-distributed -n monitoring -f mimir-values.rendered.yaml
```

Then add a `remoteWrite` block pointing at Mimir's `nginx` gateway in `kube-prom-stack-values.yaml` and `helm upgrade`.

---

## 9. Verification

```bash
# Check all pods are running
kubectl -n monitoring get pods

# Check persistent volumes bound correctly
kubectl -n monitoring get pvc

# Port-forward Grafana locally
kubectl -n monitoring port-forward svc/kube-prometheus-stack-grafana 3000:80

# Retrieve Grafana admin password (if not set manually in values)
kubectl -n monitoring get secret kube-prometheus-stack-grafana \
  -o jsonpath="{.data.admin-password}" | base64 -d
```

Open `http://localhost:3000` — Prometheus, Loki, and Tempo datasources should already be pre-wired via `additionalDataSources`.

---

## 10. Exposing Grafana Externally

Choose one based on your existing ingress setup:

- **ALB Ingress Controller** — standard for EKS, pairs with Route53 + ACM cert
- **Traefik `IngressRoute`** — if you want parity with a homelab/self-hosted setup; disable the chart's built-in ingress and write a custom manifest

---

## Notes

- Reuse an existing OIDC provider if the cluster already has one — don't recreate it.
- Tempo/OTel is only needed if your workloads are instrumented for tracing; metrics + logs (Prometheus + Loki) alone cover most day-to-day debugging.
- For any app you want scraped, add a `ServiceMonitor` or `PodMonitor` CR targeting its metrics endpoint.
