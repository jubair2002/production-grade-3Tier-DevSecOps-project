# Grafana Monitoring (Prometheus + Grafana)

Optional **Prometheus + Grafana** stack for custom dashboards and alerting on the EKS cluster.

Cluster: `jubair-eks-cluster-testing` (`us-east-1`)

---

## Prerequisites

- `kubectl` connected to the cluster
- [Helm](https://helm.sh/docs/helm/helm_install/) installed locally

---

## Install kube-prometheus-stack

```bash
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update

kubectl create namespace monitoring

helm install kube-prometheus-stack prometheus-community/kube-prometheus-stack \
  -n monitoring
```

Verify:

```bash
kubectl get pods -n monitoring
```

---

## Access Grafana

Port-forward:

```bash
kubectl port-forward svc/kube-prometheus-stack-grafana -n monitoring 3000:80
```

Default admin password:

```bash
kubectl get secret kube-prometheus-stack-grafana -n monitoring \
  -o jsonpath="{.data.admin-password}" | base64 -d && echo
```

Open **http://localhost:3000** (user: `admin`).

---

## Useful dashboards

- Kubernetes / Compute Resources / Namespace (Pods)
- Node Exporter / Nodes
- Custom panel for `product-app` pod restarts

---

## Related documents

- [EKS Cluster Setup Guide](./EKS-CLUSTER-SETUP.md)
- [ALB Ingress Setup Guide](./ALB-INGRESS-SETUP.md)
- [CI/CD Pipeline Guide](./CICD-PIPELINE.md)
