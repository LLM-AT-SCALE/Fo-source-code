# FabOrchestrator on EKS — CloudFormation

Target: account **358982197923**, **us-west-2**, dedicated VPC **fo-dev-vpc**
(`vpc-0755aa657acaf5889`). The VPC, subnets, NAT, the VPN to CMF (10.10.1.0/24),
RDS `fo-dev-db` and the VPC endpoints are owned by **Terraform** — these stacks
only reference their ids. Change those in Terraform, never here.

These templates replace the ECS/Fargate ones one level up (`platform.yaml`,
`service.yaml`) and the Elastic Beanstalk environments running today
(`faborch-dev`, `fab-admin-dev-env`). `ecr.yaml` one level up is reused as is.

| Stack | Template | Owns |
|---|---|---|
| `fo-dev-ecr` | `../ecr.yaml` | one ECR repo per module image (`fo-dev/<module>`) |
| `fo-dev-eks-cluster` | `eks-cluster.yaml` | EKS control plane, node group, node SG, add-ons |
| `fo-dev-eks-edge` | `eks-edge.yaml` | ALB, target groups, path rules, EFS (Coding Agent runs), CloudFront |
| `fo-dev-eks-workload-iam` | `eks-workload-iam.yaml` | Pod Identity roles per module + LB controller + External Secrets |
| `fo-dev-eks-build` | `eks-build.yaml` | CodeBuild batch that builds the six images from a zip in S3 |
| `fo-dev-eks-logs` | `eks-logs.yaml` | Saved CloudWatch Logs Insights queries |
| `fo-dev-eks-cicd` | `eks-cicd.yaml` | In-VPC CodeBuild deploy project (helm) + EKS access entry; permissions for the GitHub Actions OIDC role |

Kubernetes objects (Deployments, Services, TargetGroupBindings, ExternalSecrets,
HPAs) are **not** CloudFormation — they come from the Helm chart in `deploy/helm/`.

## Deploy order

Run from `faborchestrator/`, with credentials for account 358982197923.

```bash
export AWS_REGION=us-west-2

# 1. Image repositories
aws cloudformation deploy --stack-name fo-dev-ecr \
  --template-file deploy/cloudformation/ecr.yaml \
  --parameter-overrides NamePrefix=fo-dev

# 2. Cluster (~15 min). Narrow the API endpoint to your own egress IP.
aws cloudformation deploy --stack-name fo-dev-eks-cluster \
  --template-file deploy/cloudformation/eks/eks-cluster.yaml \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides EndpointPublicAccessCidrs=<your-ip>/32

aws eks update-kubeconfig --name fo-dev-eks --region us-west-2
kubectl get nodes          # two Ready nodes

# 3. Edge (ALB + CloudFront, ~10 min). Keep the secret — it is also in the
#    CloudFront and ALB config, and a redeploy must pass the same value.
ORIGIN_SECRET=$(openssl rand -hex 32)
aws cloudformation deploy --stack-name fo-dev-eks-edge \
  --template-file deploy/cloudformation/eks/eks-edge.yaml \
  --parameter-overrides OriginVerifySecret=$ORIGIN_SECRET

# 4. Pod identities
aws cloudformation deploy --stack-name fo-dev-eks-workload-iam \
  --template-file deploy/cloudformation/eks/eks-workload-iam.yaml \
  --capabilities CAPABILITY_NAMED_IAM

# 5. Cluster controllers (Helm)
helm repo add eks https://aws.github.io/eks-charts
helm repo add external-secrets https://charts.external-secrets.io
helm upgrade --install aws-load-balancer-controller eks/aws-load-balancer-controller \
  -n kube-system --set clusterName=fo-dev-eks --set region=us-west-2 \
  --set vpcId=vpc-0755aa657acaf5889 \
  --set serviceAccount.name=aws-load-balancer-controller \
  --set enableServiceMutatorWebhook=false
helm upgrade --install external-secrets external-secrets/external-secrets \
  -n external-secrets --create-namespace \
  --set serviceAccount.name=external-secrets

# 6. Application — Helm chart (deploy/helm/faborchestrator), one release per module.

# 7. CI/CD (GitHub Actions deploy.yml / rollback.yml → CodeBuild → helm)
aws cloudformation deploy --stack-name fo-dev-eks-cicd \
  --template-file deploy/cloudformation/eks/eks-cicd.yaml \
  --capabilities CAPABILITY_NAMED_IAM --tags project=faborchestrator env=fo-dev
```

## Design notes

- **Traffic:** viewer → CloudFront (HTTPS, `*.cloudfront.net` cert) → ALB → pod.
  The ALB accepts only CloudFront's origin-facing prefix list **and** requests
  carrying the secret `X-Origin-Verify` header; anything else gets 403. For
  HTTPS on the CloudFront→ALB hop, pass `CertificateArn` and `OriginDomainName`
  to the edge stack.
- **Rule priorities** are explicit: admin 100, support-engineer 210–212, master-data-load
  300, coding-agent 400, home catch-all 1000. Paths mirror
  `deploy/modules.json`; keep them in sync.
- **IP space:** pods take VPC IPs from the two private /25s (~234 free). The
  VPC CNI keeps only 2 spare IPs per node. If that ever runs short, add a
  secondary CIDR in Terraform and switch the CNI to custom networking.
- **Database:** `fo-dev-db` is a db.t4g.micro (~90 connections, ~180 MB free
  memory). Run every module with `PG_POOL_MAX=5` and cap chat at 2 replicas.
  `fo-dev-db-sg` already allows the private subnets, so no rule change is needed.
- **Scheduler:** exactly one `fabinsight` replica, `strategy: Recreate`.
  Before starting it, set `REPORT_SCHEDULER_ENABLED=false` on the Elastic
  Beanstalk `faborch-dev` environment.
- **EFS** (Coding Agent runs) is retained if the edge stack is deleted.
- **CMF token Lambdas** from the Admin Console: off by default
  (`EnableCmfTokenProvisioning=false` on the workload-iam stack). Turning it on
  also needs `CMF_LAMBDA_ROLE_ARN`, `CMF_LAMBDA_ARTIFACT_BUCKET`,
  `CMF_LAMBDA_SUBNET_IDS` and `CMF_LAMBDA_SECURITY_GROUP_ID` on the admin module;
  the code defaults point at the old 628203515088 account.

## Logs (CloudWatch)

Container logs are shipped by the `amazon-cloudwatch-observability` add-on
(Fluent Bit, one stream per pod); control-plane logging (api, audit,
authenticator) is switched on in `eks-cluster.yaml`.

| Log group | Contents | Retention |
|---|---|---|
| `/aws/containerinsights/fo-dev-eks/application` | stdout/stderr of every pod (the six modules and the system pods) | 60 days |
| `/aws/eks/fo-dev-eks/cluster` | Kubernetes API, audit, authenticator | 60 days |
| `/aws/containerinsights/fo-dev-eks/performance` | Container Insights metrics | 60 days |
| `/aws/containerinsights/fo-dev-eks/host`, `…/dataplane` | node and kubelet logs | 60 days |
| `/codebuild/fo-dev-eks-images` | image builds | 60 days |
| `/codebuild/fo-dev-eks-deploy` | CI deploys / rollbacks (helm) | 60 days |
| `/aws/lambda/cmf-token-*` | CMF bearer-token Lambdas (source, target, test env, H) | 60 days |

EKS and the add-on create these groups, so retention is set by command rather
than CloudFormation (in Git Bash, prefix with `MSYS_NO_PATHCONV=1`):

```bash
aws logs put-retention-policy --log-group-name /aws/containerinsights/fo-dev-eks/application --retention-in-days 60
```

`eks-logs.yaml` (stack `fo-dev-eks-logs`) adds saved Logs Insights queries —
CloudWatch → Logs Insights → Saved queries → **fo-dev**: one per module,
"errors (all modules)", "error count per module (5 min)", "all modules" and
"cluster: who changed what (audit)". For a quick look without the console:
`kubectl --context fo-dev-eks -n faborchestrator logs deploy/<module>`.

## Tear-down (after cutover is stable)

Delete in reverse order: app Helm releases → controllers → `fo-dev-eks-workload-iam`
→ `fo-dev-eks-edge` (EFS stays; delete it by hand if unwanted) → `fo-dev-eks-cluster`.
