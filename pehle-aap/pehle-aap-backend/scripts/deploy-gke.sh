
#!/usr/bin/env bash
set -Eeuo pipefail

# ============================================================
# PEHLE AAP - GCP DEPLOYMENT
# Project: festivehackphleapp
# Project Number: 719041791976
# Region: asia-south1
# ============================================================

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Load deployment configuration
if [[ -f .env.deploy ]]; then
  set -a
  source .env.deploy
  set +a
fi

# ------------------------------------------------------------
# 1. GCP PROJECT CONFIGURATION
# ------------------------------------------------------------

PROJECT_ID="${PROJECT_ID:-festivehackphleapp}"
EXPECTED_PROJECT_NUMBER="719041791976"

REGION="${REGION:-asia-south1}"
ZONE="${ZONE:-asia-south1-a}"

CLUSTER="${CLUSTER:-pehle-aap}"
NAMESPACE="pehle-aap"

BUCKET="${GCS_BUCKET:-${PROJECT_ID}-pehle-aap-media}"
IMAGE_TAG="${IMAGE_TAG:-$(date +%Y%m%d%H%M%S)}"

APP_DOMAIN="${APP_DOMAIN:-}"

# ------------------------------------------------------------
# 2. REQUIRED CONFIGURATION
# ------------------------------------------------------------

: "${APP_DOMAIN:?Set APP_DOMAIN in .env.deploy}"
: "${SARVAM_API_KEY:?Set SARVAM_API_KEY in .env.deploy}"
: "${FLAGSMITH_SERVER_KEY:?Set FLAGSMITH_SERVER_KEY in .env.deploy}"
: "${GEOCODING_API_KEY:?Set GEOCODING_API_KEY in .env.deploy}"
: "${NUDGEBEE_AGENT_KEY:?Set NUDGEBEE_AGENT_KEY in .env.deploy}"

# Optional Flagsmith bootstrap
BOOTSTRAP_FLAGSMITH="${BOOTSTRAP_FLAGSMITH:-false}"

if [[ "$BOOTSTRAP_FLAGSMITH" == "true" ]]; then
  : "${FLAGSMITH_ADMIN_API_TOKEN:?Set FLAGSMITH_ADMIN_API_TOKEN}"
  : "${FLAGSMITH_PROJECT:?Set FLAGSMITH_PROJECT}"
fi

# ------------------------------------------------------------
# 3. TOOL CHECKS
# ------------------------------------------------------------

for cmd in gcloud kubectl helm docker; do
  command -v "$cmd" >/dev/null || {
    echo "ERROR: $cmd is not installed."
    exit 1
  }
done

echo ""
echo "=========================================="
echo "PEHLE AAP GCP DEPLOYMENT"
echo "=========================================="
echo "Project:   $PROJECT_ID"
echo "Region:    $REGION"
echo "Zone:      $ZONE"
echo "Cluster:   $CLUSTER"
echo "Namespace: $NAMESPACE"
echo "Domain:    $APP_DOMAIN"
echo "=========================================="

# ------------------------------------------------------------
# 4. VERIFY PROJECT, ACCOUNT AND BILLING
# ------------------------------------------------------------

echo ""
echo "[1/10] Verifying GCP project and billing"

gcloud config set project "$PROJECT_ID"

ACTIVE_ACCOUNT="$(gcloud config get-value account 2>/dev/null)"
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" \
  --format='value(projectNumber)')"

if [[ "$PROJECT_NUMBER" != "$EXPECTED_PROJECT_NUMBER" ]]; then
  echo "ERROR: Unexpected GCP project number."
  echo "Expected: $EXPECTED_PROJECT_NUMBER"
  echo "Actual:   $PROJECT_NUMBER"
  exit 1
fi

BILLING_ENABLED="$(gcloud billing projects describe "$PROJECT_ID" \
  --format='value(billingEnabled)')"

if [[ "$BILLING_ENABLED" != "True" ]]; then
  echo "ERROR: Billing is not enabled."
  exit 1
fi

echo "Account:        $ACTIVE_ACCOUNT"
echo "Project number: $PROJECT_NUMBER"
echo "Billing:        ENABLED"

# ------------------------------------------------------------
# 5. ENABLE REQUIRED GOOGLE CLOUD APIS
# ------------------------------------------------------------

echo ""
echo "[2/10] Enabling GCP APIs"

gcloud services enable \
  container.googleapis.com \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com \
  storage.googleapis.com \
  compute.googleapis.com \
  dns.googleapis.com \
  secretmanager.googleapis.com \
  sqladmin.googleapis.com \
  servicenetworking.googleapis.com \
  monitoring.googleapis.com \
  logging.googleapis.com \
  --project="$PROJECT_ID"

# ------------------------------------------------------------
# 6. CREATE ARTIFACT REGISTRY AND STORAGE
# ------------------------------------------------------------

echo ""
echo "[3/10] Creating Artifact Registry and GCS bucket"

if ! gcloud artifacts repositories describe pehle-aap \
  --location="$REGION" >/dev/null 2>&1; then

  gcloud artifacts repositories create pehle-aap \
    --repository-format=docker \
    --location="$REGION" \
    --description="Pehle Aap application containers"
fi

if ! gcloud storage buckets describe "gs://${BUCKET}" \
  >/dev/null 2>&1; then

  gcloud storage buckets create "gs://${BUCKET}" \
    --location="$REGION" \
    --uniform-bucket-level-access
fi

PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" \
  --format='value(projectNumber)')"

COMPUTE_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

echo "Compute service account: $COMPUTE_SA"

gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${COMPUTE_SA}" \
  --role=roles/storage.objectAdmin \
  --quiet

# ------------------------------------------------------------
# 7. CREATE GKE STANDARD CLUSTER
# ------------------------------------------------------------

echo ""
echo "[4/10] Creating GKE Standard cluster"

if ! gcloud container clusters describe "$CLUSTER" \
  --zone="$ZONE" >/dev/null 2>&1; then

  gcloud container clusters create "$CLUSTER" \
    --zone="$ZONE" \
    --project="$PROJECT_ID" \
    --num-nodes="${NODE_COUNT:-2}" \
    --machine-type="${MACHINE_TYPE:-e2-standard-4}" \
    --disk-size=50 \
    --workload-pool="${PROJECT_ID}.svc.id.goog" \
    --release-channel=regular \
    --enable-ip-alias \
    --enable-autorepair
else
  echo "GKE cluster already exists: $CLUSTER"
fi

gcloud container clusters get-credentials "$CLUSTER" \
  --zone="$ZONE" \
  --project="$PROJECT_ID"

kubectl create namespace "$NAMESPACE" \
  --dry-run=client -o yaml | kubectl apply -f -

# ------------------------------------------------------------
# 8. INSTALL POSTGRESQL
# ------------------------------------------------------------

echo ""
echo "[5/10] Installing PostgreSQL operator"

helm repo add cnpg https://cloudnative-pg.github.io/charts \
  >/dev/null 2>&1 || true

helm repo update

helm upgrade --install cnpg cnpg/cloudnative-pg \
  --namespace cnpg-system \
  --create-namespace \
  --wait

kubectl apply -f k8s/postgres.yaml

kubectl -n "$NAMESPACE" wait \
  --for=condition=Ready \
  cluster/pehle-db \
  --timeout=900s

# ------------------------------------------------------------
# 9. CREATE APPLICATION SECRETS
# ------------------------------------------------------------

echo ""
echo "[6/10] Creating application secrets"

kubectl -n "$NAMESPACE" create secret generic app-secrets \
  --from-literal=SARVAM_API_KEY="$SARVAM_API_KEY" \
  --from-literal=FLAGSMITH_SERVER_KEY="$FLAGSMITH_SERVER_KEY" \
  --from-literal=GEOCODING_API_KEY="$GEOCODING_API_KEY" \
  --from-literal=GCS_BUCKET="$BUCKET" \
  --from-literal=APP_NAME=pehle-aap-api \
  --dry-run=client -o yaml | kubectl apply -f -

# ------------------------------------------------------------
# 10. OPTIONAL FLAGSMITH BOOTSTRAP
# ------------------------------------------------------------

if [[ "$BOOTSTRAP_FLAGSMITH" == "true" ]]; then

  echo ""
  echo "[OPTIONAL] Flagsmith feature bootstrap"

  export FLAGSMITH_API_KEY="$FLAGSMITH_ADMIN_API_TOKEN"
  export FLAGSMITH_PROJECT

  FLAGS_IMAGE="ghcr.io/flagsmith/flagsmith-cli"

  create_flag() {
    local key="$1"
    local value="$2"
    local enabled="$3"

    if docker run --rm \
      -e FLAGSMITH_API_KEY \
      -e FLAGSMITH_PROJECT \
      "$FLAGS_IMAGE" feature get "$key" \
      --project "$FLAGSMITH_PROJECT" --json >/dev/null 2>&1; then

      echo "Existing feature: $key"
    else
      local args=(feature create "$key"
        --project "$FLAGSMITH_PROJECT"
        --value "$value"
        --yes --no-input)

      [[ "$enabled" == "true" ]] && args+=(--enabled)

      docker run --rm \
        -e FLAGSMITH_API_KEY \
        -e FLAGSMITH_PROJECT \
        "$FLAGS_IMAGE" "${args[@]}"
    fi
  }

  create_flag low_bandwidth_mode false false
  create_flag photo_upload_enabled true true
  create_flag upi_button true true
  create_flag push_notifications true true
  create_flag pinky_bua true true
  create_flag voice_announcements true true
  create_flag risk_bar_voice false false
  create_flag queue_due_minutes '{"regular":45,"elder":15,"leave_buffer":10}' true
  create_flag stage_time_seed '{"a":30,"b":8}' true
  create_flag poll_interval_s 20 true
  create_flag plate_margin 0.10 true
  create_flag expense_category_threshold 0.8 true
  create_flag thank_you_variant photos-first true

  unset FLAGSMITH_API_KEY

else
  echo ""
  echo "Skipping Flagsmith bootstrap."
  echo "Using existing Suffai organisation / pehleapp / Development environment."
  echo "Ensure required feature definitions and values exist there."
fi

# ------------------------------------------------------------
# 11. BUILD AND DEPLOY APPLICATION
# ------------------------------------------------------------

echo ""
echo "[7/10] Building and deploying application"

IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/pehle-aap/web:${IMAGE_TAG}"

gcloud builds submit --tag "$IMAGE" .

sed "s|IMAGE_PLACEHOLDER|$IMAGE|g" \
  k8s/deployment.yaml | kubectl apply -f -

# ------------------------------------------------------------
# 12. DATABASE MIGRATION AND SEED
# ------------------------------------------------------------

echo ""
echo "[8/10] Running database migration and seed"

for i in $(seq 1 90); do
  if kubectl -n "$NAMESPACE" get secret pehle-db-app \
    >/dev/null 2>&1; then
    break
  fi
  sleep 5
done

kubectl -n "$NAMESPACE" get secret pehle-db-app >/dev/null

for JOB in pehle-aap-migrate pehle-aap-seed; do

  SCRIPT="src/migrate.js"

  if [[ "$JOB" == "pehle-aap-seed" ]]; then
    SCRIPT="src/seed.js"
  fi

  kubectl -n "$NAMESPACE" delete job "$JOB" \
    --ignore-not-found >/dev/null

  cat <<EOF | kubectl apply -f -
apiVersion: batch/v1
kind: Job
metadata:
  name: ${JOB}
  namespace: ${NAMESPACE}
spec:
  backoffLimit: 2
  template:
    spec:
      restartPolicy: Never
      containers:
      - name: runner
        image: ${IMAGE}
        command: ["node", "${SCRIPT}"]
        env:
        - name: DATABASE_URL
          valueFrom:
            secretKeyRef:
              name: pehle-db-app
              key: uri
EOF

  kubectl -n "$NAMESPACE" wait \
    --for=condition=complete "job/${JOB}" \
    --timeout=600s

  kubectl -n "$NAMESPACE" logs "job/${JOB}"

done

# ------------------------------------------------------------
# 13. PROMETHEUS AND NUDGEBEE
# ------------------------------------------------------------

echo ""
echo "[9/10] Installing Prometheus and NudgeBee"

helm repo add prometheus-community \
  https://prometheus-community.github.io/helm-charts \
  >/dev/null 2>&1 || true

helm repo add nudgebee-agent \
  https://nudgebee.github.io/k8s-agent/ \
  >/dev/null 2>&1 || true

helm repo update

helm upgrade --install nudgebee-prometheus \
  prometheus-community/kube-prometheus-stack \
  --namespace nudgebee-agent \
  --create-namespace \
  --set nodeExporter.enabled=true \
  --set alertmanager.enabled=true \
  --set kubeStateMetrics.enabled=true \
  -f https://raw.githubusercontent.com/nudgebee/k8s-agent/main/kube-prometheus-stack-values.yaml \
  --wait --timeout 15m

kubectl apply -f k8s/servicemonitor.yaml
kubectl apply -f k8s/prometheusrule.yaml

helm upgrade --install nudgebee-agent \
  nudgebee-agent/nudgebee-agent \
  --namespace nudgebee-agent \
  --create-namespace \
  --set-string runner.nudgebee.auth_secret_key="$NUDGEBEE_AGENT_KEY" \
  --set-string globalConfig.prometheus_url="http://nudgebee-prometheus-kube-p-prometheus.nudgebee-agent.svc:9090" \
  --set nodeAgent.podmonitor.enabled=false \
  --wait --timeout 15m

# ------------------------------------------------------------
# 14. HTTPS AND DOMAIN CONFIGURATION
# ------------------------------------------------------------

echo ""
echo "[10/10] Configuring HTTPS"

IP_NAME=pehle-aap-ip

if ! gcloud compute addresses describe "$IP_NAME" \
  --global >/dev/null 2>&1; then

  gcloud compute addresses create "$IP_NAME" --global
fi

IP="$(gcloud compute addresses describe "$IP_NAME" \
  --global --format='value(address)')"

cat <<EOF | kubectl apply -f -
apiVersion: networking.gke.io/v1
kind: ManagedCertificate
metadata:
  name: pehle-aap-cert
  namespace: ${NAMESPACE}
spec:
  domains:
  - ${APP_DOMAIN}
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: pehle-aap-ingress
  namespace: ${NAMESPACE}
  annotations:
    kubernetes.io/ingress.class: gce
    kubernetes.io/ingress.global-static-ip-name: ${IP_NAME}
    networking.gke.io/managed-certificates: pehle-aap-cert
spec:
  rules:
  - host: ${APP_DOMAIN}
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: web
            port:
              number: 80
EOF

echo ""
echo "=========================================="
echo "DEPLOYMENT COMMANDS COMPLETED"
echo "=========================================="

echo "Project:     $PROJECT_ID"
echo "Project No:  $PROJECT_NUMBER"
echo "Region:      $REGION"
echo "Cluster:     $CLUSTER"
echo "Namespace:   $NAMESPACE"
echo "Image:       $IMAGE"
echo "Reserved IP: $IP"
echo "Domain:      $APP_DOMAIN"

echo ""
echo "DNS:"
echo "Create an A record for ${APP_DOMAIN} pointing to ${IP}."
echo ""
echo "HTTPS:"
echo "Google ManagedCertificate provisioning can take time."
echo ""
echo "Verify:"
echo "kubectl -n $NAMESPACE get pods"
echo "kubectl -n $NAMESPACE get ingress"
echo "kubectl -n $NAMESPACE get managedcertificate"
echo "curl -s https://${APP_DOMAIN}/api/health"
echo ""
echo "IMPORTANT: Replace demo access keys before production."
