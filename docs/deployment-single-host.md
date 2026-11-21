# Single-server deployment

A simpler alternative to [the AWS deployment](deployment-aws.md): one Ubuntu
server runs everything, and one domain serves both the frontend and the API.
It needs no Terraform, Amplify, SSM, or GitHub Actions.

```text
https://your-domain ---> Caddy (HTTPS)
                          ├── /api, /docs ---> API ---+--- PostgreSQL
                          └── everything else          +--- RabbitMQ
                              (built frontend)  worker -+
```

It reuses `deploy/compose.production.yml` and adds
`deploy/compose.single-host.yml`, which switches Caddy to
`deploy/Caddyfile.single-host`. Serving both on one domain keeps the
`SameSite=Strict` refresh cookie working without CORS.

## Requirements

- An Ubuntu 24.04 server with at least 2 GB of memory (for example EC2
  `t3.small`) and a 30 GB disk. `setup.sh` adds 2 GB of swap.
- Ports 80 and 443 open to the internet.
- A domain whose A record points at the server's public IP, set before the
  first start so Caddy can obtain the certificate.
- A Gemini API key, and a read-only GitHub token if the repositories are
  private.

## First start

Copy `scripts/deploy/single-host/setup.sh` to the server and run:

```bash
sudo bash setup.sh
```

It asks for the repositories, branch, GitHub token, domain, certificate
email, and Gemini API key. It generates the database, RabbitMQ, and JWT
secrets once and keeps all settings in `/srv/luminacv/shared` (readable by
root only). It then clones both repositories and runs `update.sh`.

## Updating

After changes are merged:

```bash
sudo bash /srv/luminacv/backend/scripts/deploy/single-host/update.sh
```

It fetches the branch of both repositories, builds the frontend for the
domain, builds the backend image, applies migrations, and restarts the
services. Data stays in Docker volumes.

## Useful commands

```bash
cd /srv/luminacv/backend/deploy
compose="docker compose --env-file /srv/luminacv/shared/app.env -f compose.production.yml -f compose.single-host.yml"
$compose ps
$compose logs -f api worker
```
