# EKS Monitoring Setup (Add-ons, IAM & Permissions)

This guide covers **monitoring add-ons** and **IAM permissions** for the Product Catalog DevSecOps project on **Amazon EKS**.

Use this when briefing clients on observability, setting up a new cluster, or preparing production readiness.

---

## Monitoring Goals

| Goal | Tool / Add-on |
|------|----------------|
| Pod & node CPU/memory metrics | **metrics-server** |
| Cluster & app logs/metrics in AWS | **Amazon CloudWatch Observability** add-on |
| Kubernetes events & workload health | `kubectl`, ArgoCD UI |
| Advanced metrics & dashboards (optional) | **Prometheus + Grafana** |

---

## Prerequisites

- EKS cluster: `jubair-eks-cluster-testing` (`us-east-1`)
- `kubectl` configured
- AWS CLI with admin or sufficient IAM permissions
- OIDC provider enabled (same as ALB / IRSA setup)

---

## Add-on 1 — metrics-server (Recommended)

Required for:

```bash
kubectl top nodes
kubectl top pods -n product-app
```

Horizontal Pod Autoscaling (HPA) also depends on metrics-server.

### Install via EKS add-on

```bash
aws eks create-addon \
  --cluster-name jubair-eks-cluster-testing \
  --addon-name metrics-server \
  --region us-east-1
```

Check status:

```bash
aws eks describe-addon \
  --cluster-name jubair-eks-cluster-testing \
  --addon-name metrics-server \
  --region us-east-1 \
  --query "addon.status"
```

Verify:

```bash
kubectl top nodes
kubectl top pods -n product-app
```

### Alternative: Helm install

```bash
helm repo add metrics-server https://kubernetes-sigs.github.io/metrics-server/
helm upgrade --install metrics-server metrics-server/metrics-server \
  -n kube-system
```

---

## Add-on 2 — Amazon CloudWatch Observability (Recommended for AWS-native monitoring)

Provides **Container Insights** — cluster, node, pod metrics and application logs in CloudWatch.

### Step 1 — Create IAM policy

AWS managed policy (simplest):

```
arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy
```

For full CloudWatch Observability EKS add-on, use the policy from AWS docs or:

```bash
# Download latest policy from AWS documentation if needed
# https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/Container-Insights-setup-EKS.html
```

### Step 2 — Create IRSA for CloudWatch agent

Replace account ID if needed:

```bash
eksctl create iamserviceaccount \
  --name cloudwatch-agent \
  --namespace amazon-cloudwatch \
  --cluster jubair-eks-cluster-testing \
  --attach-policy-arn arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy \
  --approve \
  --region us-east-1 \
  --override-existing-serviceaccounts
```

### Step 3 — Install EKS add-on

```bash
aws eks create-addon \
  --cluster-name jubair-eks-cluster-testing \
  --addon-name amazon-cloudwatch-observability \
  --region us-east-1 \
  --resolve-conflicts OVERWRITE
```

Wait until active:

```bash
aws eks describe-addon \
  --cluster-name jubair-eks-cluster-testing \
  --addon-name amazon-cloudwatch-observability \
  --region us-east-1 \
  --query "addon.status"
```

Verify pods:

```bash
kubectl get pods -n amazon-cloudwatch
```

### Step 4 — View metrics in AWS Console

1. Open **CloudWatch** → **Container Insights**
2. Select cluster: `jubair-eks-cluster-testing`
3. View:
   - Node CPU / memory
   - Pod count and restarts
   - Namespace `product-app` workloads

### CloudWatch Logs

Log groups (auto-created):

```
/aws/containerinsights/jubair-eks-cluster-testing/application
/aws/containerinsights/jubair-eks-cluster-testing/dataplane
/aws/containerinsights/jubair-eks-cluster-testing/host
```

Query frontend/backend logs:

```
fields @timestamp, @message
| filter kubernetes.namespace_name = "product-app"
| filter kubernetes.labels.app = "product-backend"
| sort @timestamp desc
| limit 50
```

---

## Add-on 3 — Prometheus + Grafana (Optional, advanced)

For custom dashboards and alerting beyond CloudWatch.

### Quick install with kube-prometheus-stack

```bash
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update

kubectl create namespace monitoring

helm install kube-prometheus-stack prometheus-community/kube-prometheus-stack \
  -n monitoring
```

Access Grafana:

```bash
kubectl port-forward svc/kube-prometheus-stack-grafana -n monitoring 3000:80
```

Default Grafana admin password:

```bash
kubectl get secret kube-prometheus-stack-grafana -n monitoring \
  -o jsonpath="{.data.admin-password}" | base64 -d && echo
```

Open: **http://localhost:3000** (user: `admin`)

### Useful dashboards

- Kubernetes / Compute Resources / Namespace (Pods)
- Node Exporter / Nodes
- Custom panel for `product-app` pod restarts

---

## IAM Permissions Summary

### For cluster admin (one-time setup)

| Action | Purpose |
|--------|---------|
| `eks:CreateAddon`, `eks:DescribeAddon` | Install EKS add-ons |
| `iam:CreatePolicy`, `iam:AttachRolePolicy` | Controller / monitoring IAM |
| `iam:CreateRole`, `iam:PassRole` | IRSA roles |
| `ec2:CreateTags`, `ec2:DescribeSubnets` | ALB subnet tagging |

### For AWS Load Balancer Controller (IRSA)

Policy: `AWSLoadBalancerControllerIAMPolicy`

Used by: `aws-load-balancer-controller` service account in `kube-system`

Key permissions:

- `elasticloadbalancing:*` (create/manage ALB, target groups, listeners)
- `ec2:DescribeSubnets`, `ec2:DescribeSecurityGroups`, `ec2:DescribeVpcs`
- `ec2:CreateSecurityGroup`, `ec2:AuthorizeSecurityGroupIngress`
- `iam:CreateServiceLinkedRole` (for ELB service-linked role)

### For CloudWatch Observability (IRSA)

Policy: `CloudWatchAgentServerPolicy`

Used by: CloudWatch agent / fluent bit pods in `amazon-cloudwatch`

Key permissions:

- `logs:CreateLogGroup`, `logs:CreateLogStream`, `logs:PutLogEvents`
- `cloudwatch:PutMetricData`
- `ec2:DescribeTags`, `ec2:DescribeVolumes`

### For developers (read-only monitoring)

Attach to IAM user/role:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "eks:DescribeCluster",
        "eks:ListClusters",
        "eks:AccessKubernetesApi",
        "cloudwatch:DescribeAlarms",
        "cloudwatch:GetMetricData",
        "cloudwatch:ListMetrics",
        "logs:DescribeLogGroups",
        "logs:FilterLogEvents",
        "logs:GetLogEvents"
      ],
      "Resource": "*"
    }
  ]
}
```

Plus EKS access entry mapping the IAM user to a Kubernetes `view` or `edit` ClusterRole.

---

## Application-Level Health Checks (Already Configured)

Your deployments already expose health endpoints:

| Workload | Path | Port |
|----------|------|------|
| Frontend | `/health` | 3000 |
| Backend | `/health` | 5000 |

ALB Ingress uses `/health` for target group health checks.

Verify manually:

```bash
# Via ALB
curl http://<ALB-DNS>/health

# Inside cluster
kubectl run curl-test --rm -it --restart=Never --image=curlimages/curl -- \
  curl -s http://product-frontend.product-app.svc.cluster.local:3000/health

kubectl run curl-test --rm -it --restart=Never --image=curlimages/curl -- \
  curl -s http://product-backend.product-app.svc.cluster.local:5000/health
```

---

## Recommended Monitoring Checklist

### Cluster level

- [ ] `metrics-server` add-on active
- [ ] `amazon-cloudwatch-observability` add-on active
- [ ] CloudWatch Container Insights showing cluster metrics
- [ ] Log groups receiving `product-app` logs

### Application level

- [ ] All pods in `product-app` are `Running`
- [ ] ALB target group health is **healthy**
- [ ] ArgoCD application `product-catalog` is **Synced**
- [ ] No repeated `CrashLoopBackOff` on backend/mysql

### Alerting (optional next step)

In CloudWatch, create alarms for:

- ALB `HTTPCode_Target_5XX_Count` > threshold
- EKS node `CPUUtilization` > 80%
- Pod restart count spike in Container Insights
- ArgoCD sync failure (if exposing ArgoCD metrics)

---

## Useful Commands

```bash
# Pod status
kubectl get pods -n product-app -o wide

# Recent events
kubectl get events -n product-app --sort-by='.lastTimestamp'

# Pod logs
kubectl logs -n product-app -l app=product-backend --tail=100 -f
kubectl logs -n product-app -l app=product-frontend --tail=100 -f

# Resource usage
kubectl top pods -n product-app
kubectl top nodes

# Ingress / ALB status
kubectl get ingress -n product-app
kubectl describe ingress product-frontend-ingress -n product-app

# ArgoCD app health
kubectl get applications -n argocd
```

---

## Add-ons Summary Table

| Add-on | Namespace | Required for | Install method |
|--------|-----------|--------------|----------------|
| **aws-ebs-csi-driver** | `kube-system` | MySQL PVC (`gp3`) | EKS add-on |
| **aws-load-balancer-controller** | `kube-system` | ALB Ingress | Helm + IRSA |
| **metrics-server** | `kube-system` | `kubectl top`, HPA | EKS add-on |
| **amazon-cloudwatch-observability** | `amazon-cloudwatch` | Logs & Container Insights | EKS add-on + IRSA |
| **cert-manager** | `cert-manager` | ALB controller webhook | kubectl apply |
| **ArgoCD** | `argocd` | GitOps deployment | kubectl apply |

---

## Related Documents

- [ALB Ingress Setup Guide](./ALB-INGRESS-SETUP.md)
- [EKS Cluster Setup Guide](./EKS-CLUSTER-SETUP.md)
- [CI/CD Pipeline Guide](./CICD-PIPELINE.md)
