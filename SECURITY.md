# Security

This project is unreleased and its data/API formats can change incompatibly. Review deployment requirements before exposing an installation.

## Credentials

- Generate private configuration with `yarn configure`; never commit `.env`, CLI session files, provider keys, database dumps, uploads, or installation snapshots.
- Provider keys are entered in platform administration, encrypted in PostgreSQL, and not readable after saving. Keep `APP_ENCRYPTION_KEY` separate from database backups. Losing or changing it makes saved credentials unreadable and invalidates signed tenant backups.
- Development accounts and TEST AI are for disposable local environments only. Production rejects development seed and TEST AI.
- Expose the HTTPS ingress only. Keep databases, Redis, S3, model endpoints, and the Docker socket private.

## Trust and access

Server-side membership checks, forced PostgreSQL RLS, and asset authorization enforce company boundaries. Company administrators do not gain access to other users' private conversations. Documents and model output are untrusted inputs. AI responses require human review for consequential use.

Material uploads are decoded with resource limits; this is not an enterprise antivirus/DLP service. Configure limits appropriate to the installation. Review [architecture](docs/ARCHITECTURE.md), [operations](docs/OPERATIONS.md), and [verification](docs/VERIFICATION.md).

## Reporting a vulnerability

Use the repository's private vulnerability reporting feature if enabled. Otherwise, contact the repository owner privately through their GitHub profile. Do not include credentials, customer files, or exploit details in a public issue. Include the affected revision, reproduction steps, and impact using synthetic data.

If a credential was ever committed, revoke it at its issuer first. Removing a file or rewriting history does not revoke a leaked credential.
