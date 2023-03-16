provider "aws" {
}

data "aws_region" "current" {}

resource "random_id" "id" {
  byte_length = 8
}

locals {
	directives = {
		aws_cognito_user_pools = [
			"",
			"@aws_cognito_user_pools(cognito_groups: [\"admin\"])",
			"@aws_cognito_user_pools(cognito_groups: [\"user\"])",
			"@aws_cognito_user_pools",
		],
		aws_auth = [
			"",
			"@aws_auth(cognito_groups: [\"admin\"])",
			"@aws_auth(cognito_groups: [\"user\"])",
			"@aws_auth",
		],
		aws_iam = [
			"",
			"@aws_iam",
		],
	}
}

locals {
	cognito_only_directives = [for i,v in setproduct(local.directives.aws_auth, [""]): [i, v]]
	multi_auth_directives = [for i,v in setproduct(local.directives.aws_cognito_user_pools, local.directives.aws_iam): [i, v]]
}

resource "aws_appsync_graphql_api" "appsync_cognito_only_deny" {
  name                = "appsync_test_cognito_only_deny"
  schema              = templatefile("schema.graphql", {alldirectives = local.cognito_only_directives})
  authentication_type = "AMAZON_COGNITO_USER_POOLS"
  user_pool_config {
    default_action = "DENY"
    user_pool_id   = aws_cognito_user_pool.pool.id
  }
  log_config {
    cloudwatch_logs_role_arn = aws_iam_role.appsync_logs.arn
    field_log_level          = "ALL"
  }
}

resource "aws_appsync_graphql_api" "appsync_cognito_only_allow" {
  name                = "appsync_test_cognito_only_allow"
  schema              = templatefile("schema.graphql", {alldirectives = local.cognito_only_directives})
  authentication_type = "AMAZON_COGNITO_USER_POOLS"
  user_pool_config {
    default_action = "ALLOW"
    user_pool_id   = aws_cognito_user_pool.pool.id
  }
  log_config {
    cloudwatch_logs_role_arn = aws_iam_role.appsync_logs.arn
    field_log_level          = "ALL"
  }
}

resource "aws_iam_role" "appsync_logs" {
  assume_role_policy = <<POLICY
{
	"Version": "2012-10-17",
	"Statement": [
		{
		"Effect": "Allow",
		"Principal": {
			"Service": "appsync.amazonaws.com"
		},
		"Action": "sts:AssumeRole"
		}
	]
}
POLICY
}
data "aws_iam_policy_document" "appsync_push_logs" {
  statement {
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents"
    ]
    resources = [
      "arn:aws:logs:*:*:*"
    ]
  }
}


resource "aws_iam_role_policy" "appsync_logs" {
  role   = aws_iam_role.appsync_logs.id
  policy = data.aws_iam_policy_document.appsync_push_logs.json
}
resource "aws_iam_role" "appsync" {
  assume_role_policy = <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Action": "sts:AssumeRole",
      "Principal": {
        "Service": "appsync.amazonaws.com"
      },
      "Effect": "Allow"
    }
  ]
}
EOF
}

resource "aws_appsync_graphql_api" "appsync_with_iam_cognito_first" {
  name                = "appsync_test_with_iam_cognito_first"
  schema              = templatefile("schema.graphql", {alldirectives = local.multi_auth_directives})
  authentication_type = "AMAZON_COGNITO_USER_POOLS"
  user_pool_config {
    default_action = "ALLOW"
    user_pool_id   = aws_cognito_user_pool.pool.id
  }
  additional_authentication_provider {
    authentication_type = "AWS_IAM"
  }
  log_config {
    cloudwatch_logs_role_arn = aws_iam_role.appsync_logs.arn
    field_log_level          = "ALL"
  }
}

resource "aws_appsync_graphql_api" "appsync_with_iam_iam_first" {
  name                = "appsync_test_with_iam_iam_first"
  schema              = templatefile("schema.graphql", {alldirectives = local.multi_auth_directives})
  authentication_type = "AWS_IAM"
  additional_authentication_provider {
    authentication_type = "AMAZON_COGNITO_USER_POOLS"
    user_pool_config {
      user_pool_id = aws_cognito_user_pool.pool.id
    }
  }
  log_config {
    cloudwatch_logs_role_arn = aws_iam_role.appsync_logs.arn
    field_log_level          = "ALL"
  }
}

module "appsync_cognito_only_deny" {
  source  = "./modules/appsync_resources"
  appsync = aws_appsync_graphql_api.appsync_cognito_only_deny
	alldirectives=local.cognito_only_directives
}

module "appsync_cognito_only_allow" {
  source  = "./modules/appsync_resources"
  appsync = aws_appsync_graphql_api.appsync_cognito_only_allow
	alldirectives=local.cognito_only_directives
}

module "appsync_with_iam_cognito_first" {
  source  = "./modules/appsync_resources"
  appsync = aws_appsync_graphql_api.appsync_with_iam_cognito_first
	alldirectives=local.multi_auth_directives
}

module "appsync_with_iam_iam_first" {
  source  = "./modules/appsync_resources"
  appsync = aws_appsync_graphql_api.appsync_with_iam_iam_first
	alldirectives=local.multi_auth_directives
}

# cognito

resource "aws_cognito_user_pool" "pool" {
  name = "test-${random_id.id.hex}"
  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }
}

resource "aws_cognito_user_pool_client" "client" {
  name = "client"

  user_pool_id = aws_cognito_user_pool.pool.id
	explicit_auth_flows = ["ALLOW_ADMIN_USER_PASSWORD_AUTH", "ALLOW_REFRESH_TOKEN_AUTH", "ALLOW_USER_SRP_AUTH"]
}

resource "aws_cognito_user_group" "admin" {
  name         = "admin"
  user_pool_id = aws_cognito_user_pool.pool.id
}

resource "aws_cognito_user_group" "user" {
  name         = "user"
  user_pool_id = aws_cognito_user_pool.pool.id
}

resource "aws_cognito_user" "user" {
  user_pool_id = aws_cognito_user_pool.pool.id
  username     = "user"
  attributes = {
    email = "user@example.com"
  }
  password = "Password.1"
}
resource "aws_cognito_user_in_group" "user" {
  user_pool_id = aws_cognito_user_pool.pool.id
  group_name   = aws_cognito_user_group.user.name
  username     = aws_cognito_user.user.username
}

output "testdata" {
	value = jsonencode({
		user = {
			username: aws_cognito_user.user.username,
			password: "Password.1",
			userPoolId: aws_cognito_user_pool.pool.id,
			clientId: aws_cognito_user_pool_client.client.id
		},
		APIs = [
			{
				name: "appsync_cognito_only_deny",
				url: aws_appsync_graphql_api.appsync_cognito_only_deny.uris["GRAPHQL"],
				alldirectives: local.cognito_only_directives,
				description: "Cognito authorizer only, default DENY",
				group: "cognito_only",
			},
			{
				name: "appsync_cognito_only_allow", 
				url: aws_appsync_graphql_api.appsync_cognito_only_allow.uris["GRAPHQL"], 
				alldirectives: local.cognito_only_directives,
				description: "Cognito authorizer only, default ALLOW",
				group: "cognito_only",
			},
			{
				name: "appsync_with_iam_cognito_first", 
				url: aws_appsync_graphql_api.appsync_with_iam_cognito_first.uris["GRAPHQL"], 
				alldirectives: local.multi_auth_directives,
				testIam: true,
				description: "Cognito with IAM",
				group: "cognito_with_iam",
			},
			{
				name: "appsync_with_iam_iam_first", 
				url: aws_appsync_graphql_api.appsync_with_iam_iam_first.uris["GRAPHQL"], 
				alldirectives: local.multi_auth_directives,
				testIam: true,
				description: "IAM with Cognito",
				group: "iam_with_cognito",
			}
		],
		region = data.aws_region.current.name
	})
}
