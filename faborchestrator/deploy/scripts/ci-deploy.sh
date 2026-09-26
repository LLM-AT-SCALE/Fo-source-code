#!/usr/bin/env bash
# Deploy or roll back the FabOrchestrator Helm release from CI.
#
# Runs in CodeBuild project fo-dev-eks-deploy (deploy/cloudformation/eks/eks-cicd.yaml),
# inside the VPC (private EKS endpoint), from the source zip of the commit being
# deployed. Started by .github/workflows/deploy.yml and rollback.yml.
#
#   MODE=deploy   IMAGE_TAG=<7-char commit>  IMAGES=admin,home | all
#       Selected modules move to IMAGE_TAG; every other module keeps the tag it
#       is running now. Chart and values come from this commit for all modules.
#   MODE=rollback REVISION=<helm revision>   (empty = the previous one)
#   MODE=check    read-only: release history and running images
#
# Needs: aws cli, kubectl, helm (installed by the CodeBuild buildspec).
set -euo pipefail

cd "$(dirname "$0")/../.."                       # faborchestrator/
region="${AWS_REGION:-us-west-2}"
cluster="${CLUSTER:-fo-dev-eks}"
ns="${NAMESPACE:-faborchestrator}"
release="${RELEASE:-faborchestrator}"
chart=deploy/helm/faborchestrator
values="$chart/values-${ENV_NAME:-fo-dev}.yaml"
mode="${MODE:-deploy}"

# Every module image (deploy/modules.json) and the page that proves it answers.
modules="home support-engineer master-data-load coding-agent admin fabinsight"
declare -A smoke_path=(
  [home]=/ [support-engineer]=/chat [master-data-load]=/modeling-agent
  [coding-agent]=/backend-agent [admin]=/admin
)

aws eks update-kubeconfig --name "$cluster" --region "$region" >/dev/null
kubectl get namespace "$ns" >/dev/null                  # fails fast without cluster access

releases() { helm history "$release" -n "$ns" --max 5 || true; }

if [ "$mode" = check ]; then                     # read-only: can CI reach and read the release?
  releases
  kubectl -n "$ns" get deploy -o custom-columns='MODULE:.metadata.name,IMAGE:.spec.template.spec.containers[0].image,READY:.status.readyReplicas'
  exit 0
fi

if [ "$mode" = rollback ]; then
  echo "=== history before"; releases
  echo "=== helm rollback $release ${REVISION:-<previous>}"
  helm rollback "$release" ${REVISION:+"$REVISION"} -n "$ns" --wait --timeout 15m
  echo "=== history after"; releases
  kubectl -n "$ns" get deploy -o custom-columns='MODULE:.metadata.name,IMAGE:.spec.template.spec.containers[0].image,READY:.status.readyReplicas'
  exit 0
fi

: "${IMAGE_TAG:?IMAGE_TAG is required}"
images="${IMAGES:-all}"
selected() { case ",$images," in *,all,*|*",$1,"*) return 0 ;; esac; return 1; }

echo "=== image per module"
sets=()
for m in $modules; do
  if selected "$m"; then
    tag="$IMAGE_TAG"; note="deploy"
  else
    tag="$(kubectl -n "$ns" get deploy "$m" -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null | sed 's/.*://')"
    note="unchanged"
    [ -n "$tag" ] || { echo "$m is not running yet - select it (or all modules)"; exit 1; }
  fi
  printf '  %-18s %-10s %s\n' "$m" "$tag" "$note"
  sets+=(--set-string "modules.$m.tag=$tag")
done

# Helm 4 applies server-side: take over fields last set by hand (`kubectl set image`)
# instead of failing on the conflict.
extra=()
case "$(helm version --short)" in v4*) extra+=(--force-conflicts) ;; esac

echo "=== helm upgrade (rolls back automatically if pods do not become ready)"
helm upgrade --install "$release" "$chart" -n "$ns" -f "$values" "${sets[@]}" "${extra[@]}" \
  --atomic --wait --timeout 15m --history-max 20

# A new pod is Ready before the ALB has seen it pass two health checks, and a
# Recreate module (coding-agent, fabinsight) has no old pod meanwhile: allow the
# target group up to 2 minutes to turn healthy before calling a page failed.
echo "=== smoke test"
url="$(awk '/^appUrl:/ {print $2}' "$values")"
failed=0
for m in $modules; do
  selected "$m" && [ -n "${smoke_path[$m]:-}" ] || continue
  for _ in $(seq 12); do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "$url${smoke_path[$m]}" || true)"
    case "$code" in 2??|3??) break ;; esac
    sleep 10
  done
  printf '  %-18s %-16s %s\n' "$m" "${smoke_path[$m]}" "$code"
  case "$code" in 2??|3??) ;; *) failed=1 ;; esac
done

echo "=== history"; releases
[ "$failed" = 0 ] || { echo "smoke test failed - the pods are up but a page did not answer"; exit 1; }
