data "aws_iam_policy_document" "instance_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "application" {
  name               = "${var.project_name}-ec2-role"
  assume_role_policy = data.aws_iam_policy_document.instance_assume_role.json
}

resource "aws_iam_role_policy_attachment" "ssm_core" {
  role       = aws_iam_role.application.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

data "aws_iam_policy_document" "application_secrets" {
  statement {
    actions = ["ssm:GetParameter"]
    resources = [
      "arn:aws:ssm:${var.aws_region}:*:parameter/luminacv/production/env",
      "arn:aws:ssm:${var.aws_region}:*:parameter/luminacv/production/github-deploy-key"
    ]
  }
}

resource "aws_iam_role_policy" "application_secrets" {
  name   = "read-deployment-secrets"
  role   = aws_iam_role.application.id
  policy = data.aws_iam_policy_document.application_secrets.json
}

resource "aws_iam_instance_profile" "application" {
  name = "${var.project_name}-application"
  role = aws_iam_role.application.name
}

resource "aws_iam_openid_connect_provider" "github" {
  count = var.github_oidc_provider_arn == "" ? 1 : 0

  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = ["6938fd4d98bab03faadb97b34396831e3780aea1"]
}

locals {
  github_oidc_provider_arn = var.github_oidc_provider_arn != "" ? var.github_oidc_provider_arn : aws_iam_openid_connect_provider.github[0].arn
}

data "aws_iam_policy_document" "backend_github_assume_role" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [local.github_oidc_provider_arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_backend_repository}:ref:refs/heads/${var.backend_branch}"]
    }
  }
}

resource "aws_iam_role" "backend_github" {
  name               = "${var.project_name}-backend-github-deploy"
  assume_role_policy = data.aws_iam_policy_document.backend_github_assume_role.json
}

data "aws_iam_policy_document" "backend_deploy" {
  statement {
    actions   = ["ec2:DescribeInstances"]
    resources = ["*"]
  }

  statement {
    actions = ["ssm:SendCommand"]
    resources = [
      aws_instance.application.arn,
      "arn:aws:ssm:${var.aws_region}::document/AWS-RunShellScript"
    ]
  }

  statement {
    actions   = ["ssm:GetCommandInvocation"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "backend_deploy" {
  name   = "deploy-through-ssm"
  role   = aws_iam_role.backend_github.id
  policy = data.aws_iam_policy_document.backend_deploy.json
}

data "aws_iam_policy_document" "frontend_github_assume_role" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [local.github_oidc_provider_arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_frontend_repository}:ref:refs/heads/${var.frontend_branch}"]
    }
  }
}

resource "aws_iam_role" "frontend_github" {
  name               = "${var.project_name}-frontend-github-deploy"
  assume_role_policy = data.aws_iam_policy_document.frontend_github_assume_role.json
}

data "aws_iam_policy_document" "frontend_deploy" {
  statement {
    actions = [
      "amplify:CreateDeployment",
      "amplify:GetJob",
      "amplify:StartDeployment"
    ]
    resources = [
      aws_amplify_app.frontend.arn,
      "${aws_amplify_app.frontend.arn}/branches/${var.frontend_branch}",
      "${aws_amplify_app.frontend.arn}/branches/${var.frontend_branch}/*"
    ]
  }
}

resource "aws_iam_role_policy" "frontend_deploy" {
  name   = "deploy-to-amplify"
  role   = aws_iam_role.frontend_github.id
  policy = data.aws_iam_policy_document.frontend_deploy.json
}
