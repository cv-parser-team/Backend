variable "aws_region" {
  description = "AWS region for all regional resources."
  type        = string
  default     = "us-east-1"
}

variable "project_name" {
  description = "Short name used in resource names and tags."
  type        = string
  default     = "luminacv"
}

variable "instance_type" {
  description = "EC2 instance type for the API, worker, database, and broker."
  type        = string
  default     = "t3.medium"
}

variable "data_volume_size_gib" {
  description = "Size of the encrypted persistent gp3 data volume."
  type        = number
  default     = 30

  validation {
    condition     = var.data_volume_size_gib >= 20
    error_message = "The data volume must be at least 20 GiB."
  }
}

variable "root_domain_name" {
  description = "Registered root domain shared by the frontend and API, for example example.com."
  type        = string
}

variable "api_subdomain" {
  description = "API subdomain prefix."
  type        = string
  default     = "api"
}

variable "frontend_subdomain" {
  description = "Amplify frontend subdomain prefix."
  type        = string
  default     = "app"
}

variable "route53_zone_id" {
  description = "Existing public Route 53 hosted-zone ID. Leave empty when DNS is managed elsewhere."
  type        = string
  default     = ""
}

variable "github_backend_repository" {
  description = "Backend GitHub repository in owner/name form."
  type        = string
}

variable "github_frontend_repository" {
  description = "Frontend GitHub repository in owner/name form."
  type        = string
}

variable "backend_branch" {
  description = "Backend branch allowed to assume the deployment role."
  type        = string
  default     = "main"
}

variable "frontend_branch" {
  description = "Frontend branch deployed to Amplify."
  type        = string
  default     = "main"
}

variable "github_oidc_provider_arn" {
  description = "ARN of an existing GitHub Actions OIDC provider. Leave empty to create it."
  type        = string
  default     = ""
}

variable "budget_alert_email" {
  description = "Email address that receives AWS Budget alerts."
  type        = string
}

variable "monthly_budget_usd" {
  description = "Monthly cost budget in USD."
  type        = number
  default     = 50

  validation {
    condition     = var.monthly_budget_usd > 0 && var.monthly_budget_usd <= 100
    error_message = "Set a positive monthly budget no greater than the $100 credit."
  }
}
