# ALB Ingress Setup (AWS Load Balancer Controller)

Install the **AWS Load Balancer Controller** with Helm so the Ingress in this repo provisions an internet-facing **Application Load Balancer (ALB)**.

Ingress manifest: `k8s-manifests/ingress/ingress.yaml`

Official reference: [Install AWS Load Balancer Controller with Helm](https://docs.aws.amazon.com/eks/latest/userguide/lbc-helm.html)

---

## Prerequisites

Before starting, complete the following:

- Amazon EKS cluster running (`jubair-eks-cluster-testing`, `us-east-1`)
- `kubectl` connected to the cluster
- [Helm](https://helm.sh/docs/helm/helm_install/) installed locally
- VPC CNI, `kube-proxy`, and CoreDNS add-ons at supported versions
- **Public subnets** tagged for internet-facing ALBs (see [Tag public subnets](#tag-public-subnets))
- OIDC provider enabled on the cluster (required for IRSA)

### Considerations

- The IAM policy and role (`AmazonEKSLoadBalancerControllerRole`) can be reused across EKS clusters in the same AWS account.
- IRSA must be set up per cluster. The OIDC provider ARN in the role trust policy is cluster-specific.
- If reinstalling on a cluster that already has the role, verify the role exists and skip to [Step 2](#step-2-install-aws-load-balancer-controller).

---

## Tag public subnets

The controller discovers subnets using AWS tags. **Without these tags on public subnets, the ALB will not provision.**

| Tag Key | Tag Value |
|---------|-----------|
| `kubernetes.io/role/elb` | `1` |
| `kubernetes.io/cluster/jubair-eks-cluster-testing` | `shared` |

```bash
CLUSTER=jubair-eks-cluster-testing
REGION=us-east-1

VPC_ID=$(aws eks describe-cluster \
  --name $CLUSTER \
  --region $REGION \
  --query "cluster.resourcesVpcConfig.vpcId" \
  --output text)

# Tag each public subnet (replace subnet IDs)
for SUBNET in subnet-aaa subnet-bbb; do
  aws ec2 create-tags --region $REGION --resources $SUBNET --tags \
    Key=kubernetes.io/role/elb,Value=1 \
    Key=kubernetes.io/cluster/$CLUSTER,Value=shared
done
```

---

## Step 1: Create IAM role using `eksctl`

Steps below use AWS Load Balancer Controller **v2.14.1**. See [releases](https://github.com/kubernetes-sigs/aws-load-balancer-controller/releases/) for other versions.

### 1.1 Download IAM policy

```bash
curl -O https://raw.githubusercontent.com/kubernetes-sigs/aws-load-balancer-controller/v2.14.1/docs/install/iam_policy.json
```

### 1.2 Create IAM policy

```bash
aws iam create-policy \
    --policy-name AWSLoadBalancerControllerIAMPolicy \
    --policy-document file://iam_policy.json
```

Note the policy ARN, e.g. `arn:aws:iam::<AWS_ACCOUNT_ID>:policy/AWSLoadBalancerControllerIAMPolicy`.

> Console warnings for the **ELB** service (not **ELB v2**) can be ignored.

### 1.3 Create IRSA service account

Replace `<cluster-name>`, `<AWS_ACCOUNT_ID>`, and `<aws-region-code>`:

```bash
eksctl create iamserviceaccount \
    --cluster=jubair-eks-cluster-testing \
    --namespace=kube-system \
    --name=aws-load-balancer-controller \
    --attach-policy-arn=arn:aws:iam::<AWS_ACCOUNT_ID>:policy/AWSLoadBalancerControllerIAMPolicy \
    --override-existing-serviceaccounts \
    --region us-east-1 \
    --approve
```

---

## Step 2: Install AWS Load Balancer Controller

### 2.1 Add Helm repo

```bash
helm repo add eks https://aws.github.io/eks-charts
helm repo update eks
```

### 2.2 Install with Helm

Replace `my-cluster` with your cluster name. Use `region` and `vpcId` when nodes have restricted IMDS, or on Fargate / Hybrid Nodes:

```bash
helm install aws-load-balancer-controller eks/aws-load-balancer-controller \
  -n kube-system \
  --set clusterName=jubair-eks-cluster-testing \
  --set serviceAccount.create=false \
  --set serviceAccount.name=aws-load-balancer-controller \
  --version 1.14.0
```

With restricted IMDS or Fargate, add:

```bash
  --set region=us-east-1 \
  --set vpcId=$VPC_ID
```

> On `helm upgrade`, CRDs are not updated automatically. Apply them manually from the [chart CRDs](https://github.com/aws/eks-charts/blob/master/stable/aws-load-balancer-controller/crds/crds.yaml) if upgrading.

---

## Step 3: Verify controller installation

```bash
kubectl get deployment -n kube-system aws-load-balancer-controller
```

Expected:

```
NAME                           READY   UP-TO-DATE   AVAILABLE   AGE
aws-load-balancer-controller   2/2     2            2           ...
```

Confirm IngressClass:

```bash
kubectl get ingressclass
```

Expected: `alb` controller `ingress.k8s.aws/alb`.

---

## Deploy Ingress and get ALB URL

### Apply Ingress

Via ArgoCD (recommended) or manually:

```bash
kubectl apply -f k8s-manifests/ingress/ingress.yaml
kubectl get ingress -n product-app
```

### Get ALB hostname

Wait 2–5 minutes, then:

```bash
kubectl get ingress product-frontend-ingress -n product-app \
  -o jsonpath='{.status.loadBalancer.ingress[0].hostname}{"\n"}'
```

Test:

```bash
curl -I http://<ALB-DNS-NAME>/health
```

---

## Ingress manifest reference

```yaml
annotations:
  alb.ingress.kubernetes.io/scheme: internet-facing
  alb.ingress.kubernetes.io/target-type: ip
  alb.ingress.kubernetes.io/healthcheck-path: /health
spec:
  ingressClassName: alb
```

For HTTPS, see [Route application traffic with ALBs](https://docs.aws.amazon.com/eks/latest/userguide/alb-ingress.html).

---

## Troubleshooting

| Symptom | Check |
|---------|-------|
| Ingress has no ADDRESS | Subnet tags, OIDC/IRSA, controller pods and logs |
| 502/503 from ALB | Frontend pods running; `/health` returns 200 |
| Unhealthy targets | Health check path `/health`; SG allows ALB → pods on port 3000 |

```bash
kubectl describe ingress product-frontend-ingress -n product-app
kubectl logs -n kube-system deployment/aws-load-balancer-controller --tail=50
kubectl get pods -n product-app -l app=product-frontend
```

---

## Related documents

- [EKS Cluster Setup Guide](./EKS-CLUSTER-SETUP.md)
- [Grafana Monitoring Guide](./GRAFANA-MONITORING.md)
- [CI/CD Pipeline Guide](./CICD-PIPELINE.md)
