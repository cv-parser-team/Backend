resource "aws_amplify_app" "frontend" {
  name     = "${var.project_name}-frontend"
  platform = "WEB"

  enable_branch_auto_deletion = true

  custom_rule {
    source = "/<*>"
    status = "404-200"
    target = "/index.html"
  }
}

resource "aws_amplify_branch" "frontend" {
  app_id      = aws_amplify_app.frontend.id
  branch_name = var.frontend_branch
  stage       = "PRODUCTION"

  enable_auto_build = false
}

resource "aws_amplify_domain_association" "frontend" {
  app_id                = aws_amplify_app.frontend.id
  domain_name           = var.root_domain_name
  wait_for_verification = false

  sub_domain {
    branch_name = aws_amplify_branch.frontend.branch_name
    prefix      = var.frontend_subdomain
  }
}
