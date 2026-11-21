data "aws_ssm_parameter" "amazon_linux_2023" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}

resource "aws_ebs_volume" "data" {
  availability_zone = aws_subnet.public.availability_zone
  size              = var.data_volume_size_gib
  type              = "gp3"
  encrypted         = true

  tags = { Name = "${var.project_name}-data" }
}

resource "aws_instance" "application" {
  ami                         = data.aws_ssm_parameter.amazon_linux_2023.value
  instance_type               = var.instance_type
  subnet_id                   = aws_subnet.public.id
  vpc_security_group_ids      = [aws_security_group.application.id]
  associate_public_ip_address = false
  iam_instance_profile        = aws_iam_instance_profile.application.name

  user_data_replace_on_change = true
  user_data = templatefile("${path.module}/user-data.sh.tftpl", {
    aws_region         = var.aws_region
    data_volume_id     = aws_ebs_volume.data.id
    repository_ssh_url = "git@github.com:${var.github_backend_repository}.git"
  })

  root_block_device {
    volume_type           = "gp3"
    volume_size           = 12
    encrypted             = true
    delete_on_termination = true
  }

  metadata_options {
    http_endpoint = "enabled"
    http_tokens   = "required"
  }

  credit_specification {
    cpu_credits = "standard"
  }

  lifecycle {
    precondition {
      condition     = var.instance_type == "t3.medium"
      error_message = "This deployment is intentionally fixed to the requested t3.medium instance."
    }
  }

  tags = { Name = "${var.project_name}-application" }
}

resource "aws_volume_attachment" "data" {
  device_name = "/dev/sdf"
  volume_id   = aws_ebs_volume.data.id
  instance_id = aws_instance.application.id
}
