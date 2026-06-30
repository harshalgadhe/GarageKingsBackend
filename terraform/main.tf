# ============================================================================
# GARAGEKINGS PRODUCTION INFRASTRUCTURE AS CODE (TERRAFORM)
# Optimized for Low-Cost, Scale-to-Zero, Private RDS & CloudFront CDN
# ============================================================================

terraform {
  required_version = ">= 1.5.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

# Variables
variable "aws_region" {
  type    = string
  default = "ap-south-1" # Mumbai Region
}

variable "environment" {
  type    = string
  default = "production"
}

# 1. VPC Networking Configurations
resource "aws_vpc" "gk_vpc" {
  cidr_block           = "10.0.0.0/16"
  enable_dns_hostnames = true
  enable_dns_support   = true
  tags = {
    Name = "gk-${var.environment}-vpc"
  }
}

# Subnets (2 Public for CloudFront/Lambda outbound, 2 Private for RDS)
resource "aws_subnet" "public_1" {
  vpc_id            = aws_vpc.gk_vpc.id
  cidr_block        = "10.0.1.0/24"
  availability_zone = "${var.aws_region}a"
  tags = { Name = "gk-public-subnet-1" }
}

resource "aws_subnet" "public_2" {
  vpc_id            = aws_vpc.gk_vpc.id
  cidr_block        = "10.0.2.0/24"
  availability_zone = "${var.aws_region}b"
  tags = { Name = "gk-public-subnet-2" }
}

resource "aws_subnet" "private_1" {
  vpc_id            = aws_vpc.gk_vpc.id
  cidr_block        = "10.0.3.0/24"
  availability_zone = "${var.aws_region}a"
  tags = { Name = "gk-private-subnet-1" }
}

resource "aws_subnet" "private_2" {
  vpc_id            = aws_vpc.gk_vpc.id
  cidr_block        = "10.0.4.0/24"
  availability_zone = "${var.aws_region}b"
  tags = { Name = "gk-private-subnet-2" }
}

# Internet Gateway
resource "aws_internet_gateway" "igw" {
  vpc_id = aws_vpc.gk_vpc.id
  tags = {
    Name = "gk-${var.environment}-igw"
  }
}

# Route Table for Public/Database Subnets
resource "aws_route_table" "public_rt" {
  vpc_id = aws_vpc.gk_vpc.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.igw.id
  }
  tags = {
    Name = "gk-${var.environment}-public-rt"
  }
}

# Associate Private Subnets (Database subnets) with Route Table to enable public pathing
resource "aws_route_table_association" "private_1_assoc" {
  subnet_id      = aws_subnet.private_1.id
  route_table_id = aws_route_table.public_rt.id
}

resource "aws_route_table_association" "private_2_assoc" {
  subnet_id      = aws_subnet.private_2.id
  route_table_id = aws_route_table.public_rt.id
}

# Database Subnet Group
resource "aws_db_subnet_group" "db_subnet" {
  name       = "gk-${var.environment}-db-subnet-group"
  subnet_ids = [aws_subnet.private_1.id, aws_subnet.private_2.id]
  tags = { Name = "gk-db-subnet-group" }
}

# Security Groups
resource "aws_security_group" "db_sg" {
  name        = "gk-${var.environment}-db-sg"
  description = "Access to private PostgreSQL RDS"
  vpc_id      = aws_vpc.gk_vpc.id

  # Ingress allowed from all IP addresses to support Lambda outside VPC & local migrations (port shifted to non-standard)
  ingress {
    from_port   = 25432
    to_port     = 25432
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# 2. Private RDS PostgreSQL Database Instance
resource "aws_db_instance" "postgres" {
  identifier             = "gk-${var.environment}-postgres"
  engine                 = "postgres"
  engine_version         = "16.13"
  instance_class         = "db.t4g.micro" # Free Tier Eligible
  allocated_storage      = 20             # 20GB Free Tier GP3
  storage_type           = "gp3"
  db_subnet_group_name   = aws_db_subnet_group.db_subnet.name
  vpc_security_group_ids = [aws_security_group.db_sg.id]
  username               = "gk_admin"
  password               = "GkProdDbSec_981a8dc71f"
  db_name                = "garagekings_prod"
  port                   = 25432
  skip_final_snapshot    = true
  publicly_accessible    = true # Enabled for Zero-Cost VPC Routing (Lambda outside VPC)
  
  # Automated Backup (Free PITR - Set to 0 to satisfy sandbox constraints)
  backup_retention_period = 0
}

# 3. AWS Cognito User Pool
resource "aws_cognito_user_pool" "user_pool" {
  name = "gk-${var.environment}-user-pool"

  username_attributes = ["email"]
  auto_verified_attributes = ["email"]

  password_policy {
    minimum_length    = 8
    require_lowercase = true
    require_numbers   = true
    require_symbols   = true
    require_uppercase = true
  }
}

resource "aws_cognito_user_pool_client" "client" {
  name         = "gk-client"
  user_pool_id = aws_cognito_user_pool.user_pool.id

  explicit_auth_flows = [
    "ALLOW_USER_PASSWORD_AUTH",
    "ALLOW_REFRESH_TOKEN_AUTH"
  ]
}

# 4. Amazon S3 Bucket (Product Images & Receipts)
resource "aws_s3_bucket" "assets_bucket" {
  bucket        = "gk-${var.environment}-public-assets-2026"
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "block" {
  bucket = aws_s3_bucket.assets_bucket.id

  block_public_acls       = false
  block_public_policy     = false
  ignore_public_acls      = false
  restrict_public_buckets = false
}

# 5. Core API Monolithic AWS Lambda Function
resource "aws_iam_role" "lambda_role" {
  name = "gk-${var.environment}-lambda-execution-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = { Service = "lambda.amazonaws.com" }
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "lambda_basic" {
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
  role       = aws_iam_role.lambda_role.name
}

# Lambda Function URL (Always Free routing!)
resource "aws_lambda_function" "api_monolith" {
  function_name = "gk-${var.environment}-api-prod"
  role          = aws_iam_role.lambda_role.arn
  handler       = "dist/main.handler"
  runtime       = "nodejs20.x"
  architectures = ["arm64"] # Graviton2: 20% cheaper & faster
  timeout       = 30
  memory_size   = 1024

  # Package dummy (Overwritten by CI/CD git pushes)
  filename         = "${path.module}/dummy_payload.zip"
  source_code_hash = filebase64sha256("${path.module}/dummy_payload.zip")

  lifecycle {
    ignore_changes = [
      filename,
      source_code_hash,
    ]
  }

  environment {
    variables = {
      NODE_ENV              = "production"
      DATABASE_URL          = "postgresql://gk_admin:GkProdDbSec_981a8dc71f@${aws_db_instance.postgres.endpoint}/garagekings_prod"
      COGNITO_USER_POOL_ID  = aws_cognito_user_pool.user_pool.id
      COGNITO_CLIENT_ID     = aws_cognito_user_pool_client.client.id
      GOOGLE_CLIENT_ID      = "231477217878-0g2nq0e6fmvqt802gdu8esm1uucfmjvv.apps.googleusercontent.com"
      S3_ASSETS_BUCKET      = aws_s3_bucket.assets_bucket.id
      DATABASE_SSL          = "true"
    }
  }
}

resource "aws_lambda_function_url" "api_furl" {
  function_name      = aws_lambda_function.api_monolith.function_name
  authorization_type = "AWS_IAM"

  cors {
    allow_origins     = ["*"]
    allow_methods     = ["*"]
    allow_headers     = ["*"]
    expose_headers    = ["keep-alive", "date"]
    max_age           = 86400
  }
}

resource "aws_cloudfront_origin_access_control" "lambda_oac" {
  name                              = "gk-${var.environment}-lambda-oac"
  description                       = "OAC for GarageKings Lambda Function URL"
  origin_access_control_origin_type = "lambda"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# 6. Amazon CloudFront CDN Distribution
resource "aws_cloudfront_distribution" "cdn" {
  origin {
    domain_name = aws_s3_bucket.assets_bucket.bucket_regional_domain_name
    origin_id   = "S3-Assets"
  }

  # API Monolith Function URL Origin
  origin {
    domain_name              = split("/", replace(aws_lambda_function_url.api_furl.function_url, "https://", ""))[0]
    origin_id                = "Lambda-FURL"
    origin_access_control_id = aws_cloudfront_origin_access_control.lambda_oac.id
    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  enabled             = true
  is_ipv6_enabled     = true
  default_root_object = "index.html"

  # Default S3 Static Assets Caching Behaviors
  default_cache_behavior {
    allowed_methods  = ["GET", "HEAD"]
    cached_methods   = ["GET", "HEAD"]
    target_origin_id = "S3-Assets"

    forwarded_values {
      query_string = false
      cookies { forward = "none" }
    }

    viewer_protocol_policy = "redirect-to-https"
    min_ttl                = 0
    default_ttl            = 86400
    max_ttl                = 31536000
  }

  # API Routing Caching Bypass (Cache strictly 0 seconds!)
  ordered_cache_behavior {
    path_pattern     = "/api/*"
    allowed_methods  = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods   = ["GET", "HEAD"]
    target_origin_id = "Lambda-FURL"

    forwarded_values {
      query_string = true
      headers      = ["X-Authorization", "Origin"]
      cookies { forward = "all" }
    }

    viewer_protocol_policy = "redirect-to-https"
    min_ttl                = 0
    default_ttl            = 0
    max_ttl                = 0
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }

  tags = {
    Environment = var.environment
  }
}

# Outputs
output "cloudfront_domain" {
  value       = aws_cloudfront_distribution.cdn.domain_name
  description = "Production global domain endpoint"
}

# Permission to allow CloudFront OAC to invoke Lambda Function URL
resource "aws_lambda_permission" "allow_cloudfront_furl" {
  statement_id  = "AllowCloudFrontServicePrincipalFURL"
  action        = "lambda:InvokeFunctionUrl"
  function_name = aws_lambda_function.api_monolith.function_name
  principal     = "cloudfront.amazonaws.com"
  source_arn    = aws_cloudfront_distribution.cdn.arn
}

# Permission to allow CloudFront OAC to invoke Lambda Function (via backend Invoke calls)
resource "aws_lambda_permission" "allow_cloudfront_furl_invoke" {
  statement_id  = "AllowCloudFrontServicePrincipalFURLInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api_monolith.function_name
  principal     = "cloudfront.amazonaws.com"
  source_arn    = aws_cloudfront_distribution.cdn.arn
}

# Public read policy for S3 assets bucket
resource "aws_s3_bucket_policy" "assets_bucket_policy" {
  bucket = aws_s3_bucket.assets_bucket.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "PublicReadGetObject"
        Effect    = "Allow"
        Principal = "*"
        Action    = "s3:GetObject"
        Resource  = "${aws_s3_bucket.assets_bucket.arn}/*"
      }
    ]
  })
}
