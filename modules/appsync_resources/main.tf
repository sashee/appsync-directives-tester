variable "appsync" {
}

variable "alldirectives" {
}

resource "random_id" "id" {
  byte_length = 8
}

resource "aws_cloudwatch_log_group" "loggroup" {
  name              = "/aws/appsync/apis/${var.appsync.id}"
  retention_in_days = 14
}

resource "aws_appsync_datasource" "none" {
  api_id           = var.appsync.id
  name             = "none"
  type             = "NONE"
}

# resolvers

locals {
	all_type_directives = setproduct(var.alldirectives, var.alldirectives)
}

resource "aws_appsync_resolver" "Query_field" {
	count = length(local.all_type_directives)
  api_id      = var.appsync.id
  type   = "Query"
  field  = "q_${local.all_type_directives[count.index][0][0]}_t_${local.all_type_directives[count.index][1][0]}"
  runtime {
    name            = "APPSYNC_JS"
    runtime_version = "1.0.0"
  }
  code = <<EOF
export function request(ctx) {
	return {};
}
export function response(ctx) {
	return ctx.result;
}
EOF
  kind = "PIPELINE"
  pipeline_config {
    functions = [
      aws_appsync_function.Query_field_1[count.index].function_id,
    ]
  }
}

resource "aws_appsync_function" "Query_field_1" {
	count = length(local.all_type_directives)
  api_id      = var.appsync.id
  data_source = aws_appsync_datasource.none.name
	name = "Query_field_1_${count.index}"
  runtime {
    name            = "APPSYNC_JS"
    runtime_version = "1.0.0"
  }
  code = <<EOF
import {util} from "@aws-appsync/utils";
export function request(ctx) {
	const fields = ${jsonencode(var.alldirectives)};
	return {
		version : "2018-05-29",
		payload : Object.assign({}, ...fields.map(([i]) => ({[`f_$${i}`]: "ok"}))),
	};
}
export function response(ctx) {
	return ctx.result;
}
EOF
}

