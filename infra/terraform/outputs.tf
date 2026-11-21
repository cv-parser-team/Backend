output "api_url" {
  value = "https://${var.api_subdomain}.${var.root_domain_name}"
}

output "application_instance_id" {
  value = aws_instance.application.id
}

output "application_elastic_ip" {
  value = aws_eip.application.public_ip
}

output "amplify_app_id" {
  value = aws_amplify_app.frontend.id
}

output "amplify_default_url" {
  value = "https://${var.frontend_branch}.${aws_amplify_app.frontend.default_domain}"
}

output "backend_github_role_arn" {
  value = aws_iam_role.backend_github.arn
}

output "frontend_github_role_arn" {
  value = aws_iam_role.frontend_github.arn
}

output "frontend_url" {
  value = "https://${var.frontend_subdomain}.${var.root_domain_name}"
}
