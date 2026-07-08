# ALB Ingress Setup (AWS Load Balancer Controller)

This guide explains how to provision an **internet-facing Application Load Balancer (ALB)** automatically from the Kubernetes Ingress manifest in this project.

The Ingress file is:

```
k8s-manifests/ingress/ingress.yaml
```

When configured correctly, ArgoCD syncs the Ingress and the **AWS Load Balancer Controller** creates an ALB in your **public subnets**.

---

## What Gets Created

| Resource | Source | Result |
|----------|--------|--------|
| Kubernetes Ingress | `k8s-manifests/ingress/ingress.yaml` | Routing rule for frontend |
| AWS ALB | AWS Load Balancer Controller | Public HTTP endpoint on port 80 |
| Target Group | Controller | Registers frontend pod IPs (`target-type: ip`) |

Only the **frontend** is exposed publicly. The backend and MySQL stay internal — the frontend proxies `/api/*` to the backend inside the cluster.

---

## Prerequisites Checklist

- [ ] EKS cluster running: `jubair-eks-cluster-testing` (`us-east-1`)
- [ ] `kubectl` connected to the cluster
- [ ] **Public subnets** tagged correctly (see Step 1)
- [ ] **OIDC provider** enabled on the EKS cluster (see Step 2)
- [ ] **AWS Load Balancer Controller** installed (see Step 3)
- [ ] **IAM policy + IRSA role** for the controller (see Step 3)
- [ ] ArgoCD synced (or apply manifests manually once)

---

## Step 1 — Tag Public Subnets (Required)

The controller discovers subnets automatically using AWS tags. **Without these tags, the ALB will not provision.**

For each **public subnet** used by the cluster, apply:

| Tag Key | Tag Value |
|---------|-----------|
| `kubernetes.io/role/elb` | `1` |
| `kubernetes.io/cluster/jubair-eks-cluster-testing` | `shared` |

### Find your cluster VPC and subnets

```bash
CLUSTER=jubair-eks-cluster-testing
REGION=us-east-1

VPC_ID=$(aws eks describe-cluster \
  --name $CLUSTER \
  --region $REGION \
  --query "cluster.resourcesVpcConfig.vpcId" \
  --output text)

echo "VPC: $VPC_ID"

aws ec2 describe-subnets \
  --filters "Name=vpc-id,Values=$VPC_ID" \
  --region $REGION \
  --query "Subnets[*].[SubnetId,MapPublicIpOnLaunch,Tags]" \
  --output table
```

Public subnets usually have `MapPublicIpOnLaunch: true`.

### Tag public subnets (example)

Replace `subnet-aaa` and `subnet-bbb` with your public subnet IDs:

```bash
for SUBNET in subnet-aaa subnet-bbb; do
  aws ec2 create-tags --region us-east-1 --resources $SUBNET --tags \
    Key=kubernetes.io/role/elb,Value=1 \
    Key=kubernetes.io/cluster/jubair-eks-cluster-testing,Value=shared
done
```

Verify:

```bash
aws ec2 describe-subnets --subnet-ids subnet-aaa subnet-bbb --region us-east-1 \
  --query "Subnets[*].Tags" --output table
```

> **Note:** Private subnets use `kubernetes.io/role/internal-elb=1` for **internal** ALBs only. This project uses **internet-facing** ALB, so public subnet tags are required.

---

## Step 2 — Enable OIDC Provider on EKS

The Load Balancer Controller uses **IRSA** (IAM Roles for Service Accounts). OIDC must exist on the cluster.

Check:

```bash
aws eks describe-cluster \
  --name jubair-eks-cluster-testing \
  --region us-east-1 \
  --query "cluster.identity.oidc.issuer" \
  --output text
```

If empty, create the OIDC provider:

```bash
eksctl utils associate-iam-oidc-provider \
  --cluster jubair-eks-cluster-testing \
  --region us-east-1 \
  --approve
```

Or with AWS CLI / console: EKS → Cluster → Security → Enable OIDC.

---

## Step 3 — Install AWS Load Balancer Controller

### 3.1 Install cert-manager (dependency)

```bash
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.14.4/cert-manager.yaml

kubectl wait --for=condition=Available deployment/cert-manager -n cert-manager --timeout=120s
kubectl wait --for=condition=Available deployment/cert-manager-webhook -n cert-manager --timeout=120s
```

### 3.2 Create IAM policy for the controller

Download the official IAM policy:

```bash
curl -o iam-policy.json https://raw.githubusercontent.com/kubernetes-sigs/aws-load-balancer-controller/v2.7.2/docs/install/iam_policy.json

aws iam create-policy \
  --policy-name AWSLoadBalancerControllerIAMPolicy \
  --policy-document file://iam-policy.json
```

Note the policy ARN output, e.g.:

```
arn:aws:iam::767398035572:policy/AWSLoadBalancerControllerIAMPolicy
```

### 3.3 Create IRSA service account

Replace `767398035572` with your AWS account ID if different:

```bash
eksctl create iamserviceaccount \
  --cluster=jubair-eks-cluster-testing \
  --namespace=kube-system \
  --name=aws-load-balancer-controller \
  --attach-policy-arn=arn:aws:iam::767398035572:policy/AWSLoadBalancerControllerIAMPolicy \
  --override-existing-serviceaccounts \
  --region us-east-1 \
  --approve
```

### 3.4 Install controller with Helm

```bash
helm repo add eks https://aws.github.io/eks-charts
helm repo update

helm install aws-load-balancer-controller eks/aws-load-balancer-controller \
  -n kube-system \
  --set clusterName=jubair-eks-cluster-testing \
  --set serviceAccount.create=false \
  --set serviceAccount.name=aws-load-balancer-controller \
  --set region=us-east-1 \
  --set vpcId=$VPC_ID
```

Verify:

```bash
kubectl get deployment -n kube-system aws-load-balancer-controller
kubectl get pods -n kube-system -l app.kubernetes.io/name=aws-load-balancer-controller
```

Logs (if issues):

```bash
kubectl logs -n kube-system deployment/aws-load-balancer-controller --tail=100
```

---

## Step 4 — Verify IngressClass

The Ingress manifest uses `ingressClassName: alb`.

```bash
kubectl get ingressclass
```

Expected:

```
NAME   CONTROLLER            PARAMETERS   AGE
alb    ingress.k8s.aws/alb   <none>       ...
```

If missing, the Helm chart usually creates it. Recheck controller installation.

---

## Step 5 — Deploy Ingress (GitOps or Manual)

### Option A — ArgoCD (recommended)

Push/sync repo so ArgoCD applies `k8s-manifests/ingress/ingress.yaml`.

```bash
kubectl get ingress -n product-app
```

### Option B — Manual apply

```bash
kubectl apply -f k8s-manifests/ingress/ingress.yaml
```

---

## Step 6 — Get ALB URL

Wait 2–5 minutes for AWS to provision the load balancer.

```bash
kubectl get ingress product-frontend-ingress -n product-app

kubectl get ingress product-frontend-ingress -n product-app \
  -o jsonpath='{.status.loadBalancer.ingress[0].hostname}{"\n"}'
```

Example output:

```
k8s-productapp-productfr-xxxxxxxxx.us-east-1.elb.amazonaws.com
```

Open in browser:

```
http://<ALB-DNS-NAME>
```

Test health:

```bash
curl -I http://<ALB-DNS-NAME>/health
```

---

## Ingress Manifest Reference

```yaml
annotations:
  alb.ingress.kubernetes.io/scheme: internet-facing      # public ALB
  alb.ingress.kubernetes.io/target-type: ip              # register pod IPs
  alb.ingress.kubernetes.io/listen-ports: '[{"HTTP": 80}]'
  alb.ingress.kubernetes.io/healthcheck-path: /health
spec:
  ingressClassName: alb
```

### Optional: HTTPS (ACM certificate)

After you have an ACM certificate ARN:

```yaml
alb.ingress.kubernetes.io/listen-ports: '[{"HTTP": 80}, {"HTTPS": 443}]'
alb.ingress.kubernetes.io/certificate-arn: arn:aws:acm:us-east-1:767398035572:certificate/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
alb.ingress.kubernetes.io/ssl-redirect: "443"
```

---

## Troubleshooting

### Ingress has no ADDRESS

```bash
kubectl describe ingress product-frontend-ingress -n product-app
kubectl logs -n kube-system deployment/aws-load-balancer-controller --tail=50
```

Common causes:

| Error | Fix |
|-------|-----|
| Subnets not tagged | Add `kubernetes.io/role/elb=1` on public subnets |
| Missing OIDC / IRSA | Complete Step 2 and Step 3 |
| Controller not running | Reinstall Helm chart, check IAM policy |
| Wrong VPC | Ensure `vpcId` in Helm matches cluster VPC |

### ALB created but 502/503

```bash
kubectl get pods -n product-app -l app=product-frontend
kubectl get endpoints product-frontend -n product-app
curl http://localhost:3000/health   # from inside a debug pod if needed
```

Ensure frontend pods are `Running` and `/health` returns 200.

### Target groups unhealthy

- Health check path must be `/health` (configured in Ingress annotations)
- Security groups must allow ALB → node/pod traffic on port 3000

---

## Security Group Notes

EKS Auto Mode / managed node groups usually configure this automatically. If targets stay unhealthy:

1. Open EC2 → Load Balancers → select ALB → check security groups
2. Ensure worker node security group allows inbound from ALB security group on port **3000**

---

## NodePort vs ALB

| Access method | URL | Use case |
|---------------|-----|----------|
| **ALB Ingress** | `http://<alb-dns>` | Production / client demo |
| **NodePort** | `http://<node-ip>:30080` | Quick testing without ALB |

Both can coexist. ALB is the recommended public entry point.

---

## Related Documents

- [EKS Cluster Setup Guide](./EKS-CLUSTER-SETUP.md)
- [Monitoring Setup Guide](./MONITORING-SETUP.md)
- [CI/CD Pipeline Guide](./CICD-PIPELINE.md)
