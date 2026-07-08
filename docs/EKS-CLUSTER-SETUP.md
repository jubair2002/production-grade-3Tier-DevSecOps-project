# AWS EKS Cluster Setup & Laptop Connection Guide

This document explains how to connect your laptop to the **Amazon EKS** cluster, install the required add-ons, and prepare the environment for the **Product Catalog DevSecOps** project.

Use this guide when onboarding a new machine, briefing a client, or handing over cluster access.

---

## Overview

| Item | Value |
|------|-------|
| Cloud | AWS |
| Region | `us-east-1` |
| Cluster name | `jubair-eks-cluster-testing` |
| Application namespace | `product-app` |
| GitOps tool | ArgoCD (`argocd` namespace) |
| Storage class | `gp3` |

---

## What You Need on Your Laptop

Install these tools before connecting to EKS:

| Tool | Purpose | Install (Linux) |
|------|---------|-----------------|
| **AWS CLI v2** | Authenticate and talk to AWS | [AWS CLI install guide](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) |
| **kubectl** | Manage Kubernetes resources | `sudo snap install kubectl --classic` or [kubectl install](https://kubernetes.io/docs/tasks/tools/) |
| **git** | Clone repo and work with manifests | `sudo apt install git` |
| **Docker** (optional) | Build images locally | [Docker install](https://docs.docker.com/engine/install/) |

Verify installations:

```bash
aws --version
kubectl version --client
git --version
```

---

## Step 1 — Configure AWS Credentials on Your Laptop

You need an IAM user or role with permission to access the EKS cluster.

### Option A: Access Key (used in this project)

```bash
aws configure
```

Enter when prompted:

- **AWS Access Key ID** — your IAM access key
- **AWS Secret Access Key** — your IAM secret key
- **Default region name** — `us-east-1`
- **Default output format** — `json`

Verify AWS identity:

```bash
aws sts get-caller-identity
```

Expected output example:

```json
{
    "UserId": "AIDA...",
    "Account": "767398035572",
    "Arn": "arn:aws:iam::767398035572:user/cslb23jubair"
}
```

### Option B: AWS SSO / Named Profile

If you use a named profile:

```bash
export AWS_PROFILE=your-profile-name
export AWS_REGION=us-east-1
aws sts get-caller-identity
```

---

## Step 2 — Connect kubectl to the EKS Cluster

This command downloads the cluster kubeconfig and sets your current context.

```bash
aws eks update-kubeconfig \
  --region us-east-1 \
  --name jubair-eks-cluster-testing
```

Verify connection:

```bash
kubectl config current-context
kubectl cluster-info
kubectl get nodes
```

Expected:

- Context name contains `jubair-eks-cluster-testing`
- Nodes show `Ready` status

### Quick health check

```bash
kubectl get namespaces
kubectl get pods -A
```

---

## Step 3 — Required EKS Add-ons

These add-ons must be present for this project to work correctly.

### 3.1 Amazon EBS CSI Driver (required for MySQL PVC)

The MySQL database uses a **PersistentVolumeClaim** with storage class `gp3`. Without the EBS CSI driver, the MySQL pod stays in `Pending` state.

Check if the driver is installed:

```bash
kubectl get pods -n kube-system | grep ebs-csi
```

If not installed, enable the EKS add-on:

```bash
aws eks create-addon \
  --cluster-name jubair-eks-cluster-testing \
  --addon-name aws-ebs-csi-driver \
  --region us-east-1
```

Wait until the add-on is active:

```bash
aws eks describe-addon \
  --cluster-name jubair-eks-cluster-testing \
  --addon-name aws-ebs-csi-driver \
  --region us-east-1 \
  --query "addon.status"
```

### 3.2 Storage Class `gp3`

Confirm `gp3` exists:

```bash
kubectl get storageclass
```

If `gp3` is missing, create it:

```yaml
# gp3-storageclass.yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: gp3
provisioner: ebs.csi.aws.com
volumeBindingMode: WaitForFirstConsumer
parameters:
  type: gp3
  encrypted: "true"
```

Apply:

```bash
kubectl apply -f gp3-storageclass.yaml
```

### 3.3 Core EKS Add-ons (verify)

These usually come with EKS but should be checked:

```bash
aws eks list-addons \
  --cluster-name jubair-eks-cluster-testing \
  --region us-east-1
```

Common defaults:

- `vpc-cni`
- `kube-proxy`
- `coredns`

---

## Step 4 — Install ArgoCD (GitOps Controller)

ArgoCD watches the Git repository and deploys `k8s-manifests/` to EKS automatically.

### 4.1 Install ArgoCD

```bash
kubectl create namespace argocd

kubectl apply -n argocd -f \
  https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml
```

Wait for pods to become ready:

```bash
kubectl get pods -n argocd -w
```

### 4.2 Access ArgoCD UI from laptop

```bash
kubectl port-forward svc/argocd-server -n argocd 8080:443
```

Open in browser:

```
https://localhost:8080
```

Get initial admin password:

```bash
kubectl -n argocd get secret argocd-initial-admin-secret \
  -o jsonpath="{.data.password}" | base64 -d && echo
```

Login:

- **Username:** `admin`
- **Password:** output from command above

### 4.3 Register the Git repository in ArgoCD

In ArgoCD UI:

1. Go to **Settings → Repositories**
2. Click **Connect Repo**
3. Use HTTPS URL:

```
https://github.com/jubair2002/production-grade-3Tier-DevSecOps-project.git
```

Or apply the Application manifest directly:

```bash
kubectl apply -f k8s-manifests/argocd/application.yaml
```

### 4.4 Verify ArgoCD application

```bash
kubectl get applications -n argocd
```

Expected application name: `product-catalog`

Sync status should become **Synced** and health **Healthy** after manifests are applied.

---

## Step 5 — Deploy / Verify the Application

Once ArgoCD is synced, check workloads:

```bash
kubectl get all -n product-app
kubectl get pvc -n product-app
```

Expected resources:

| Resource | Name |
|----------|------|
| Deployments | `product-frontend`, `product-backend`, `mysql` |
| Services (NodePort) | `product-frontend`, `product-backend`, `mysql` |
| PVC | `mysql-pvc` (Bound) |

### NodePort access (testing)

| Service | NodePort | Use |
|---------|----------|-----|
| Frontend | `30080` | Open app in browser |
| Backend | `30500` | Direct API access |
| MySQL | `30306` | DB access (testing only) |

Get node IP:

```bash
kubectl get nodes -o wide
```

Open application:

```
http://<NODE_EXTERNAL_IP>:30080
```

---

## Step 6 — Daily Commands (Laptop ↔ EKS)

### Switch to EKS context

```bash
aws eks update-kubeconfig --region us-east-1 --name jubair-eks-cluster-testing
```

### View application status

```bash
kubectl get pods -n product-app
kubectl get svc -n product-app
```

### View logs

```bash
# Backend logs
kubectl logs -n product-app -l app=product-backend --tail=50

# Frontend logs
kubectl logs -n product-app -l app=product-frontend --tail=50

# MySQL logs
kubectl logs -n product-app -l app=mysql --tail=50
```

### Restart a deployment (manual)

```bash
kubectl rollout restart deployment/product-backend -n product-app
kubectl rollout restart deployment/product-frontend -n product-app
```

> In GitOps mode, ArgoCD may revert manual changes if `selfHeal: true` is enabled.

---

## IAM Permissions Required

The IAM user/role on your laptop should allow at minimum:

- `eks:DescribeCluster`
- `eks:ListClusters`
- `eks:AccessKubernetesApi` (via `aws-auth` / EKS access entry)

For CI/CD pipeline (GitHub Actions), also needed:

- `sts:GetCallerIdentity`
- EKS cluster access for verification step

---

## Troubleshooting

### Error: `No cluster found for name: jubair-eks-cluster-testing`

**Cause:** Wrong AWS region.

**Fix:** Use `us-east-1`:

```bash
aws eks list-clusters --region us-east-1
```

---

### MySQL pod `Pending`

**Cause:** PVC not bound (missing storage class or EBS CSI driver).

**Fix:**

```bash
kubectl describe pvc mysql-pvc -n product-app
kubectl get storageclass
kubectl get pods -n kube-system | grep ebs-csi
```

Ensure `storageClassName: gp3` is set in `k8s-manifests/db/pvc.yaml`.

---

### Backend `CrashLoopBackOff`

**Cause:** Backend starts before MySQL is ready.

**Fix:** Wait for MySQL to be `Running`, then check backend logs:

```bash
kubectl get pods -n product-app
kubectl logs -n product-app -l app=product-backend --tail=30
```

---

### `Unauthorized` or `connection refused` from kubectl

**Cause:** AWS credentials expired or IAM user not mapped to EKS.

**Fix:**

```bash
aws sts get-caller-identity
aws eks update-kubeconfig --region us-east-1 --name jubair-eks-cluster-testing
```

Ask cluster admin to add your IAM user/role to EKS access entries.

---

## Handover Checklist (Client / Team)

- [ ] AWS CLI installed and configured on laptop
- [ ] `kubectl` installed
- [ ] Can run `aws sts get-caller-identity`
- [ ] Can run `kubectl get nodes`
- [ ] EBS CSI driver add-on is active
- [ ] Storage class `gp3` exists
- [ ] ArgoCD installed in `argocd` namespace
- [ ] ArgoCD application `product-catalog` is Synced
- [ ] All pods in `product-app` are Running
- [ ] App opens on `http://<NODE_IP>:30080`

---

## Related Documents

- [Main Project README](../README.md)
- [CI/CD Pipeline Guide](./CICD-PIPELINE.md)
- [ALB Ingress Setup Guide](./ALB-INGRESS-SETUP.md)
- [Grafana Monitoring Guide](./GRAFANA-MONITORING.md)
