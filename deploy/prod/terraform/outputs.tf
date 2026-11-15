output "namespace" {
  description = "The namespace Bhava runs in."
  value       = kubernetes_namespace_v1.bhava.metadata[0].name
}

output "migration_job" {
  description = "The migration Job this release ran before its rollout."
  value       = kubernetes_job_v1.migrate.metadata[0].name
}

output "config_version" {
  description = "A hash of the settings in bhava-config; it changes when they do, and the pods restart."
  value       = local.config_version
}

output "hosts" {
  description = "The hosts the Ingress names."
  value       = local.hosts
}
