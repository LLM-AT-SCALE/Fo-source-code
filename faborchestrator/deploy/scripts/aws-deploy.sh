#!/usr/bin/env bash
# Build, push and deploy the module images to AWS (ECR + ECS via CloudFormation).
#
#   deploy/scripts/aws-deploy.sh [image ...]          # default: all six
#   TAG=2026-09-22-1 deploy/scripts/aws-deploy.sh chat admin
#   SKIP_BUILD=1 deploy/scripts/aws-deploy.sh home    # redeploy an existing tag
#
# Reads deploy/aws-params.json (copy deploy/aws-params.example.json) for the
# account-level values and deploy/modules.json for what each image owns.
# Requires: docker, aws cli v2, node, and credentials for the target account.
# The platform stack (deploy/cloudformation/platform.yaml) and the ECR stack
# must already exist; see DEPLOYMENT.md §6.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
app="$(cd "$here/../.." && pwd)"
params="$app/deploy/aws-params.json"
[ -f "$params" ] || { echo "missing $params (copy deploy/aws-params.example.json)"; exit 2; }

jsonq() { node -e "const p=require('$params'); const v=p$1; if(v===undefined){process.exit(3)}; console.log(typeof v==='string'?v:JSON.stringify(v))"; }
region="$(jsonq .region)"
account="$(aws sts get-caller-identity --query Account --output text)"
registry="$account.dkr.ecr.$region.amazonaws.com"
prefix="$(jsonq .repositoryPrefix)"
platform="$(jsonq .platformStackName)"
tag="${TAG:-$(date +%Y-%m-%d)-$(git -C "$app" rev-parse --short HEAD)}"

images=("$@")
[ ${#images[@]} -gt 0 ] || images=(home support-engineer master-data-load coding-agent admin fabinsight)

if [ -z "${SKIP_BUILD:-}" ]; then
  aws ecr get-login-password --region "$region" | docker login --username AWS --password-stdin "$registry"
fi

for image in "${images[@]}"; do
  uri="$registry/$prefix/$image:$tag"
  if [ -z "${SKIP_BUILD:-}" ]; then
    echo "=== build $image -> $uri"
    docker build --platform linux/amd64 -f "$app/deploy/Dockerfile.image" \
      --build-arg IMAGE="$image" --build-arg NODE_IMAGE=public.ecr.aws/docker/library/node:22-alpine \
      -t "$uri" "$app"
    docker push "$uri"
  fi

  echo "=== deploy stack $platform-svc-$image"
  # Parameters derived from modules.json + aws-params.json (see service.yaml header).
  overrides="$(node - "$image" "$uri" "$params" "$app/deploy/modules.json" <<'EOF'
const [image, uri, paramsFile, modulesFile] = process.argv.slice(2);
const p = require(paramsFile); const m = require(modulesFile).images[image];
const svc = (p.services && p.services[image]) || {};
const web = !m.scheduler;
const patterns = web ? [...m.paths.map((x) => (x === '/' ? '/' : `${x}*`)), `/_fab/${image}/*`] : [];
const groups = []; for (let i = 0; i < patterns.length; i += 5) groups.push(patterns.slice(i, i + 5));
if (groups.length > 4) throw new Error(`${image}: too many path patterns for four rules`);
const out = {
  PlatformStackName: p.platformStackName,
  Module: image,
  ImageUri: uri,
  AppUrl: p.appUrl,
  SubnetIds: (svc.subnetIds || p.privateSubnetIds).join(','),
  SecurityGroupIds: (svc.securityGroupIds || [p.taskSecurityGroupId]).join(','),
  Cpu: svc.cpu ?? 1024,
  Memory: svc.memory ?? 2048,
  NodeOptions: m.nodeOptions || '--max-old-space-size=1536',
  DesiredCount: svc.desiredCount ?? 1,
  MaxCount: svc.maxCount ?? 3,
  ContainerPort: m.port || 3000,
  HasLoadBalancer: web ? 'true' : 'false',
  RulePriority: svc.rulePriority ?? { admin: 100, 'support-engineer': 200, 'master-data-load': 300, 'coding-agent': 400, home: 900 }[image] ?? 500,
  CatchAll: m.default ? 'true' : 'false',
  SchedulerEnabled: m.scheduler ? 'true' : 'false',
  UseRunsVolume: image === 'coding-agent' ? 'true' : 'false',
  ExtraManagedPolicyArns: (svc.managedPolicyArns || []).join(','),
};
groups.forEach((g, i) => { out[`PathPatterns${i + 1}`] = g.join(','); });
// CommaDelimitedList parameters are passed as one string; quote for the shell.
console.log(Object.entries(out).map(([k, v]) => `${k}=${JSON.stringify(String(v))}`).join(' '));
EOF
)"
  eval aws cloudformation deploy --region "$region" \
    --stack-name "$platform-svc-$image" \
    --template-file "$app/deploy/cloudformation/service.yaml" \
    --capabilities CAPABILITY_NAMED_IAM \
    --no-fail-on-empty-changeset \
    --parameter-overrides $overrides
done

echo "=== done: tag $tag"
