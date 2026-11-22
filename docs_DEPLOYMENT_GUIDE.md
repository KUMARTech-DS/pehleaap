# Pehle Aap × Shaadi Companion — deployment guide

This package keeps the UI as plain HTML/CSS/JavaScript (`public/`) and Node.js only as the API/backend (`src/`). The same Node service serves the HTML and `/api/*`; no frontend build framework is required. PostgreSQL schema is retained and extended only with safe `IF NOT EXISTS` migrations.

## 1. Accounts and credentials you must create

| Service | Credential / setup | Where to obtain it | Used for |
|---|---|---|---|
| Google Cloud | Project ID, billing-enabled account, deployer login with project Owner/Editor plus Kubernetes/Artifact Registry/DNS permissions | Google Cloud Console | GKE, database, bucket, registry, HTTPS |
| Sarvam AI | `SARVAM_API_KEY` | Sarvam dashboard → API keys | Pinky Bua chat, speech-to-text, translation, text-to-speech |
| Flagsmith | Server-side Environment Key (`FLAGSMITH_SERVER_KEY`), Admin API Token (`FLAGSMITH_ADMIN_API_TOKEN`), Project name/ID (`FLAGSMITH_PROJECT`) | Flagsmith project → Development/Production environment; create an Admin API token in account settings | Runtime flag evaluation + one-time automatic feature creation from deploy script |
| NudgeBee | Kubernetes Agent Auth Key → `NUDGEBEE_AGENT_KEY` | app.nudgebee.com → Admin → Integrations → Kubernetes Clusters → Add K8s Account | Install agent and stream GKE telemetry |
| Google Maps Platform | `GEOCODING_API_KEY` restricted to Geocoding API | Google Cloud Console → APIs & Services → Credentials | Reverse geocode permitted location to state/language suggestion |
| Domain | `APP_DOMAIN`; optional Cloud DNS managed zone `DNS_ZONE` | Your domain registrar / Cloud DNS | HTTPS; browser geolocation and microphone require a secure context |

Do not send keys in chat, commit them, or put them in HTML. Keep them in `.env.deploy` on your deployment machine. The script creates Kubernetes Secrets from them. The GKE node service account receives Storage Object Admin on the private media bucket for signed uploads.

## 2. Configure Flagsmith once

Create a Flagsmith project with Development and Production environments. Copy its server-side environment key, create an Admin API token, and copy the project name/ID. The deploy script uses the Admin API token through the official Flagsmith CLI to create the feature keys below idempotently. Identity segments still need to be configured in the Flagsmith UI using traits `role`, `wedding`, and `elders`.

- Boolean: `low_bandwidth_mode`, `photo_upload_enabled`, `upi_button`, `push_notifications`, `pinky_bua`, `voice_announcements`, `risk_bar_voice`
- JSON / remote config: `queue_due_minutes` = `{"regular":45,"elder":15,"leave_buffer":10}`; `stage_time_seed` = `{"a":30,"b":8}`
- Number: `poll_interval_s` = `20`; `plate_margin` = `0.10`; `expense_category_threshold` = `0.8`
- String / multivariate: `thank_you_variant` = `photos-first`

Use identity traits `role`, `wedding`, and `elders` for segments. The server falls back to safe defaults if Flagsmith is unavailable. The live flags endpoint returns the user's values. NudgeBee agent installation is automated by the deploy script; its workflow/approval policies are configured in the NudgeBee SaaS console.

## 3. Create `.env.deploy`

Copy `.env.deploy.example` to `.env.deploy` and fill values. Never commit it.

```bash
cp .env.deploy.example .env.deploy
nano .env.deploy
```

Required values: `PROJECT_ID`, `APP_DOMAIN`, `SARVAM_API_KEY`, `FLAGSMITH_SERVER_KEY`, `FLAGSMITH_ADMIN_API_TOKEN`, `FLAGSMITH_PROJECT`, `NUDGEBEE_AGENT_KEY`, `GEOCODING_API_KEY`. Optional: `DNS_ZONE`, `REGION`, `ZONE`, `MACHINE_TYPE`, `NODE_COUNT`, `GCS_BUCKET`. The admin token is used only by the deployment script; it is not stored in the app's runtime Kubernetes Secret.

Before running, point the domain's A record to the global IP the script reserves. If using Cloud DNS, set `DNS_ZONE` and the script will create/update the A record. Otherwise the script prints the IP for you to configure at your registrar, then re-run it if necessary. Google ManagedCertificate can take time to become Active after DNS resolves.

## 4. One-command deployment

Prerequisites on the machine: `gcloud`, `kubectl`, `helm` 3, `docker`, `python3`, and an authenticated Google account (`gcloud auth login`, `gcloud auth configure-docker`). Then:

```bash
chmod +x scripts/deploy-gke.sh
./scripts/deploy-gke.sh
```

The script enables APIs; creates Artifact Registry, private Cloud Storage bucket, GKE Standard cluster and PostgreSQL; creates app secrets; builds/pushes the image; runs schema migrations and dummy seed data; installs Prometheus + the NudgeBee agent; deploys the app; and creates HTTPS Ingress + ManagedCertificate. Flagsmith is a separate hosted SaaS account: create its project/environments and provide the server-side key plus an Admin API token; the script bootstraps the feature keys. It cannot create your Flagsmith tenant or mint external service credentials on your behalf.

**Costs:** GKE Standard, disks, load balancer, Cloud Storage and monitoring may incur charges. Review current GCP and NudgeBee plan pricing before running. `NODE_COUNT=2` and `e2-standard-4` are defaults, not free-tier guarantees.

## 5. Demo access keys

Seeded demo keys (replace/disable before production):

- Couple: `demo-couple-key`
- Family team: `demo-team-key`
- Vendor: `demo-vendor-key`
- Guest: `demo-guest-key`

The seed data is in `db/seed.json`. The seed script is idempotent for the demo wedding name; edit that JSON to change the sample data before first deployment.

## 6. What is wired

- HTML screens call authenticated REST APIs for dashboard, vendors, functions, tasks, gifts, queue and check-in; create/update actions write to PostgreSQL.
- Role is derived from the access link, not from a UI dropdown. Backend query scopes are authoritative.
- Pinky Bua uses Sarvam chat with role-filtered context. It is read-only: it cannot commit money or task changes through model output. Users make changes through explicit UI actions.
- Voice question: user taps microphone → browser asks microphone permission → audio sent to Saaras v4 → Pinky Bua answer via Sarvam chat → translated answer and Bulbul TTS audio where supported.
- Location is opt-in: user taps “Suggest using location” → browser permission prompt → state reverse geocoding → language suggestion. Coordinates are not written to PostgreSQL. User selects and saves their preferred language. Browser language is the fallback.
- Flagsmith server-side SDK supplies live flag/config values with safe defaults.
- NudgeBee Kubernetes agent + Prometheus are installed by Helm; application metrics are exposed at `/api/metrics` and scraped by ServiceMonitor.
- GCS signed-upload URL endpoint is available at `/api/uploads/sign` for private media uploads.

## 7. Verify after deployment

```bash
kubectl -n pehle-aap get pods
kubectl -n nudgebee-agent get pods
kubectl -n pehle-aap get managedcertificate,ingress
curl -s https://$APP_DOMAIN/api/health
curl -s https://$APP_DOMAIN/api/metrics | head
```

Open `https://$APP_DOMAIN`, sign in with a demo key, allow/deny location, choose language, and test Pinky Bua text and voice. Verify the cluster appears connected in NudgeBee. Sarvam, Flagsmith, NudgeBee and Google API calls require valid active credentials/quotas; a successful Kubernetes deployment alone cannot validate those external accounts.

## 8. Important production checklist

This is a demo/starter deployment, not a security-audited production release. Before real wedding data: replace demo access keys with cryptographically random per-person links; enforce rate limits and session expiry; add CSRF protections if cookie auth is introduced; configure backups/PITR and retention; restrict IAM and CORS; add signed upload confirmation and file scanning; add audit logs; validate all role-specific queries; configure Flagsmith segments/experiments; and test Sarvam language/voice support and API quotas. NudgeBee's agent needs cluster-level permissions; keep its documented least-privilege/read-only mode unless approved remediation is deliberately enabled.
