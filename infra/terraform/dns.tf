resource "aws_route53_record" "api" {
  count = var.route53_zone_id == "" ? 0 : 1

  zone_id = var.route53_zone_id
  name    = "${var.api_subdomain}.${var.root_domain_name}"
  type    = "A"
  ttl     = 300
  records = [aws_eip.application.public_ip]
}
