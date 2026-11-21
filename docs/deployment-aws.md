# AWS deployment

This deployment keeps the operational footprint deliberately small: one EC2
host runs the API, worker, PostgreSQL, RabbitMQ, and Caddy; Amplify serves the
separate Vite frontend. It uses no application S3 integration, NAT gateway,
load balancer, RDS instance, or inbound SSH.

Nothing in this repository provisions resources automatically. Review the
Terraform plan and obtain approval before running `terraform apply`.

## Architecture and trade-offs

```text
app.example.com (Amplify) ---> https://api.example.com
                                      |
                               Elastic IP :443
                                      |
                                    Caddy
                                      |
                         +------------+------------+
                         |                         |
                     Node API                 Node worker
                         |                         |
                         +----- PostgreSQL --------+
                         +----- RabbitMQ ----------+

EC2 root disk: OS only
Encrypted data EBS volume: Docker state, database, broker, uploads, TLS state
```

This is a single-host deployment. It is inexpensive and easy to operate, but
it has no high availability. The separate data volume survives an instance
replacement, but it is not a backup. Take EBS snapshots if the data cannot be
recreated. A future move to managed database/broker/storage services should be
driven by real availability or scale needs, not added pre-emptively.

The frontend and API must be sibling domains under the same registered domain.
The backend's refresh cookie is `SameSite=Strict`; a default
`*.amplifyapp.com` frontend calling `api.example.com` would not send it.

## Estimated monthly cost

Estimate for `us-east-1`, 730 hours, before tax and outside any free tier:

| Resource | Assumption | Approximate monthly cost |
| --- | --- | ---: |
| EC2 | one Linux `t3.medium`, $0.0418/hour | $30.51 |
| EBS | 12 GiB root + 30 GiB data, gp3 at $0.08/GiB-month | $3.36 |
| Public IPv4 | one Elastic IP at $0.005/hour | $3.65 |
| Route 53 | one hosted zone, if used | $0.50 plus queries |
| Amplify | manual build in GitHub; small static site and light traffic | usually under $2 |
| Data transfer, DNS queries, snapshots | usage dependent | allow $2–8 |
| **Expected total** | light usage | **about $40–45/month** |

The `t3.medium` uses Standard CPU credits to prevent surprise Unlimited-credit
charges. Terraform creates a monthly AWS Budget (default `$50`) with forecast
and actual email alerts. A budget alerts but does not shut resources down.
At the expected baseline, a `$100` credit lasts roughly two months. Domain
registration, GitHub Actions usage, LLM API usage, taxes, and heavy outbound
traffic are separate. Check current AWS pricing before applying.

## Prerequisites

- AWS CLI v2 authenticated to the target account
- Terraform 1.6 or later
- Docker with Compose for local validation
- `gh`, `git`, `jq`, `curl`, `zip`, and `ssh-keygen`
- A registered domain; Route 53 is simplest for the custom Amplify domain
- Separate backend and frontend GitHub repositories

Use an IAM identity that can create the resources in `infra/terraform`. Do not
put AWS access keys, Terraform credentials, application secrets, or private
keys in either repository.

## 1. Validate locally

From the backend repository:

```bash
npm ci
npm test
npm run build
npm run deploy:validate

terraform -chdir=infra/terraform init -backend=false
terraform -chdir=infra/terraform validate
```

From the frontend repository:

```bash
npm ci
npm run lint
VITE_API_BASE_URL=https://api.example.com npm run build
```

## 2. Create the read-only GitHub deploy key

The EC2 host pulls only the exact commit SHA selected by the backend workflow.
Create a dedicated key; do not reuse a personal SSH key:

```bash
key_dir=$(mktemp -d)
ssh-keygen -t ed25519 -N '' -C luminacv-production -f "$key_dir/backend-deploy"
gh repo deploy-key add "$key_dir/backend-deploy.pub" \
  --repo YOUR_ORG/YOUR_BACKEND_REPO \
  --title luminacv-production
```

Keep the temporary directory until the private key is uploaded in step 4,
then delete it securely according to your workstation's policy.

## 3. Prepare and review Terraform

Terraform state is local by design, so this deployment does not require an S3
backend. State contains infrastructure metadata and must still be protected.

```bash
cp infra/terraform/terraform.tfvars.example infra/terraform/terraform.tfvars
chmod 600 infra/terraform/terraform.tfvars
# Edit the file: repositories, root domain, hosted-zone ID, and alert email.

terraform -chdir=infra/terraform init
terraform -chdir=infra/terraform fmt -check -recursive
terraform -chdir=infra/terraform validate
terraform -chdir=infra/terraform plan -out=luminacv.tfplan
terraform -chdir=infra/terraform show luminacv.tfplan
```

If the account already has the GitHub Actions OIDC provider, set
`github_oidc_provider_arn`; AWS permits only one provider with that URL per
account. If DNS is outside Route 53, leave `route53_zone_id` empty, create the
API A record using the `application_elastic_ip` output, and create the Amplify
validation/target records reported by:

```bash
aws amplify get-domain-association \
  --app-id "$(terraform -chdir=infra/terraform output -raw amplify_app_id)" \
  --domain-name example.com
```

Only after the plan has been reviewed and explicitly approved:

```bash
terraform -chdir=infra/terraform apply luminacv.tfplan
```

## 4. Upload application secrets

Copy the template outside the repository, replace every example, and make the
database and RabbitMQ passwords URL-safe because they also appear in connection
URLs. Generate the JWT secret rather than inventing one:

```bash
cp deploy/env.production.example /tmp/luminacv-production.env
chmod 600 /tmp/luminacv-production.env
openssl rand -base64 48
# Edit /tmp/luminacv-production.env and use the generated JWT value.

scripts/aws/put-secrets.sh \
  us-east-1 \
  /tmp/luminacv-production.env \
  "$key_dir/backend-deploy"
```

The script uploads two SSM Standard SecureString parameters:

- `/luminacv/production/env`
- `/luminacv/production/github-deploy-key`

The values do not enter Terraform state or GitHub. The instance role can read
only those two parameters. If a customer-managed KMS key is used instead of
the default SSM key, add a narrowly scoped `kms:Decrypt` permission to the EC2
role.

## 5. Configure GitHub repository variables

No GitHub secret contains an AWS key. Both workflows use GitHub OIDC to obtain
short-lived AWS credentials. Set these Actions variables:

```bash
region=us-east-1
backend_role=$(terraform -chdir=infra/terraform output -raw backend_github_role_arn)
frontend_role=$(terraform -chdir=infra/terraform output -raw frontend_github_role_arn)
amplify_app=$(terraform -chdir=infra/terraform output -raw amplify_app_id)
api_url=$(terraform -chdir=infra/terraform output -raw api_url)

gh variable set AWS_REGION --body "$region" --repo YOUR_ORG/YOUR_BACKEND_REPO
gh variable set AWS_DEPLOY_ROLE_ARN --body "$backend_role" --repo YOUR_ORG/YOUR_BACKEND_REPO

gh variable set AWS_REGION --body "$region" --repo YOUR_ORG/YOUR_FRONTEND_REPO
gh variable set AWS_DEPLOY_ROLE_ARN --body "$frontend_role" --repo YOUR_ORG/YOUR_FRONTEND_REPO
gh variable set AMPLIFY_APP_ID --body "$amplify_app" --repo YOUR_ORG/YOUR_FRONTEND_REPO
gh variable set AMPLIFY_BRANCH --body main --repo YOUR_ORG/YOUR_FRONTEND_REPO
gh variable set VITE_API_BASE_URL --body "$api_url" --repo YOUR_ORG/YOUR_FRONTEND_REPO
```

If the deployment branches are not `main`, update both the Terraform branch
variables and each workflow trigger. Protect the GitHub `production`
environment if manual approval before each deployment is desired.

## 6. First deployment and checks

The EC2 bootstrap installs Docker/Compose, mounts the encrypted data volume,
moves Docker's data root onto it, and installs `/usr/local/bin/luminacv-deploy`.
Wait for Systems Manager registration before starting the workflow:

```bash
instance_id=$(terraform -chdir=infra/terraform output -raw application_instance_id)
aws ssm describe-instance-information \
  --filters "Key=InstanceIds,Values=$instance_id" \
  --region us-east-1

gh workflow run deploy-backend.yml --repo YOUR_ORG/YOUR_BACKEND_REPO --ref main
gh run watch --repo YOUR_ORG/YOUR_BACKEND_REPO

gh workflow run deploy-amplify.yml --repo YOUR_ORG/YOUR_FRONTEND_REPO --ref main
gh run watch --repo YOUR_ORG/YOUR_FRONTEND_REPO

curl --fail https://api.example.com/docs/json >/dev/null
curl --fail https://app.example.com/ >/dev/null
```

Each backend deploy fetches the exact workflow commit, builds one image for the
API and worker, waits for PostgreSQL and RabbitMQ, applies committed Drizzle
migrations, then replaces services. PostgreSQL, RabbitMQ, Caddy, uploads, and
Docker state are named volumes on the data EBS disk. Database and RabbitMQ
ports are not published.

## Operations

Run a read-only service check without opening SSH:

```bash
aws ssm send-command \
  --instance-ids "$instance_id" \
  --document-name AWS-RunShellScript \
  --parameters 'commands=["docker compose -p luminacv ps"]' \
  --region us-east-1
```

Start an interactive Session Manager shell when needed:

```bash
aws ssm start-session --target "$instance_id" --region us-east-1
```

Rotate either secret by updating the local source file, rerunning
`scripts/aws/put-secrets.sh`, and redeploying the backend. Never print decrypted
SSM values in CI logs.

Create an optional point-in-time EBS snapshot before a risky change:

```bash
volume_id=$(aws ec2 describe-volumes \
  --filters Name=tag:Name,Values=luminacv-data \
  --query 'Volumes[0].VolumeId' --output text --region us-east-1)
aws ec2 create-snapshot \
  --volume-id "$volume_id" \
  --description "LuminaCV pre-change backup" \
  --region us-east-1
```

Snapshots incur additional charges. For a transactionally consistent database
backup, stop writes or use `pg_dump` before taking the snapshot.

## Cleanup

Cleanup permanently deletes the EC2 instance, EBS volumes and all uploaded
documents/database/broker data, Amplify app, networking, DNS record managed by
this stack, IAM roles, and budget. Take and verify a backup first if needed.

```bash
terraform -chdir=infra/terraform plan -destroy -out=destroy.tfplan
terraform -chdir=infra/terraform show destroy.tfplan
# Run only after explicit approval:
terraform -chdir=infra/terraform apply destroy.tfplan

aws ssm delete-parameters \
  --names \
    /luminacv/production/env \
    /luminacv/production/github-deploy-key \
  --region us-east-1

gh repo deploy-key list --repo YOUR_ORG/YOUR_BACKEND_REPO
gh repo deploy-key delete DEPLOY_KEY_ID --repo YOUR_ORG/YOUR_BACKEND_REPO
```

If `github_oidc_provider_arn` pointed at a pre-existing provider, Terraform does
not delete it. Delete old EBS snapshots separately after confirming their IDs;
the stack intentionally does not guess which backups are safe to remove.
