# Pehle Aap × Shaadi Companion

HTML/CSS/JavaScript frontend + Node.js API + PostgreSQL, deployable to GCP GKE Standard.

**Start here:** [`docs_DEPLOYMENT_GUIDE.md`](docs_DEPLOYMENT_GUIDE.md) for accounts, credentials, Flagsmith feature setup, and one-command GCP deployment.

- Frontend: `public/` (served by the Node API; no frontend framework/build step)
- API: `src/`
- Database schema and demo data: `db/schema.sql`, `db/migrate.sql`, `db/seed.json`
- One-command deploy: `scripts/deploy-gke.sh` (reads `.env.deploy`)

Local development: create a PostgreSQL database, copy `.env.example` to `.env`, install dependencies with `npm install`, then run `npm run db:migrate`, `npm run db:seed`, and `npm start`. Open `http://localhost:3000`.

This is a functional integration starter, not a security-audited production service. Review the production checklist in the guide before using real wedding data.
