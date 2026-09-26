#!/usr/bin/env bash
# Build the six module images in AWS CodeBuild (no local Docker, no GitHub).
#
#   deploy/scripts/aws-build-images.sh            # build the committed HEAD
#   REF=2e7b4dd deploy/scripts/aws-build-images.sh # build another commit
#   IMAGES=admin,home deploy/scripts/aws-build-images.sh   # only these images
#
# Packages the COMMITTED code (git archive — nothing untracked, no .env), uploads
# it to s3://$BUCKET/eks-source/faborchestrator.zip and starts the CodeBuild
# batch of stack fo-dev-eks-build (deploy/cloudformation/eks/eks-build.yaml).
# Images are pushed as fo-dev/<module>:<7-char commit> and :latest.
# Requires: git, aws cli v2 and credentials for the target account.
set -euo pipefail

region="${AWS_REGION:-us-west-2}"
bucket="${BUCKET:-fo-dev-pipeline-artifacts-358982197923}"
project="${PROJECT:-fo-dev-eks-images}"
ref="${REF:-HEAD}"
images="${IMAGES:-all}"

repo_root="$(git rev-parse --show-toplevel)"
tag="$(git -C "$repo_root" rev-parse --short=7 "$ref")"
zip="$(mktemp -d)/faborchestrator.zip"

if [ "$ref" = "HEAD" ] && [ -n "$(git -C "$repo_root" status --porcelain -- faborchestrator)" ]; then
  echo "note: uncommitted changes under faborchestrator/ are NOT included (building $tag)"
fi

echo "=== package $ref ($tag)"
git -C "$repo_root" archive --format=zip -o "$zip" "$ref" faborchestrator

echo "=== upload s3://$bucket/eks-source/faborchestrator.zip"
aws s3 cp --region "$region" --only-show-errors "$zip" "s3://$bucket/eks-source/faborchestrator.zip"

echo "=== start build batch ($project, IMAGE_TAG=$tag, IMAGES=$images)"
id="$(aws codebuild start-build-batch --region "$region" --project-name "$project" \
  --environment-variables-override "[{\"name\":\"IMAGE_TAG\",\"value\":\"$tag\",\"type\":\"PLAINTEXT\"},{\"name\":\"IMAGES\",\"value\":\"$images\",\"type\":\"PLAINTEXT\"}]" \
  --query 'buildBatch.id' --output text)"
echo "batch: $id"

while :; do
  status="$(aws codebuild batch-get-build-batches --region "$region" --ids "$id" \
    --query 'buildBatches[0].buildBatchStatus' --output text)"
  [ "$status" = "IN_PROGRESS" ] || break
  sleep 30
done

aws codebuild batch-get-build-batches --region "$region" --ids "$id" \
  --query 'buildBatches[0].buildGroups[].[identifier,currentBuildSummary.buildStatus]' --output text
echo "=== $status: images tagged $tag"
[ "$status" = "SUCCEEDED" ]
