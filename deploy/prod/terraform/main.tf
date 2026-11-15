# Installs ../k8s/base into the cluster it is given, in this order:
#   1. the namespace (with the restricted pod security level) and the labels the network policy needs;
#   2. the Secret bhava-secrets from an outside store, when one is named (otherwise it is made by hand first);
#   3. the migration Job for this release's image, waited for: a failing migration stops the release here, before any
#      new pod exists, while the old pods keep serving;
#   4. everything else, through kustomize, with this module's settings merged in.

provider "kubernetes" {
  config_path    = pathexpand(var.kubeconfig_path)
  config_context = var.kube_context == "" ? null : var.kube_context
}

provider "kustomization" {
  kubeconfig_path = pathexpand(var.kubeconfig_path)
  context         = var.kube_context == "" ? null : var.kube_context
}

locals {
  labels = {
    "app.kubernetes.io/part-of"    = "bhava"
    "app.kubernetes.io/managed-by" = "terraform"
  }

  platform_host = var.platform_host == "" ? "app.${var.platform_domain}" : var.platform_host
  hosts         = distinct(concat([var.platform_domain, "*.${var.platform_domain}"], var.extra_hosts))

  # The settings that are not secret, merged into bhava-config. The object storage regions come from var.region.
  config = {
    DEPLOY_ENV          = "production"
    RELEASE             = var.release
    PLATFORM_DOMAIN     = var.platform_domain
    PLATFORM_HOST       = local.platform_host
    PUBLIC_BASE_URL     = var.public_base_url
    S3_ENDPOINT         = var.object_storage.endpoint
    S3_BUCKET           = var.object_storage.bucket
    S3_REGION           = var.region
    S3_FORCE_PATH_STYLE = var.object_storage.force_path_style ? "1" : "0"
    BACKUP_S3_ENDPOINT  = var.object_storage.endpoint
    BACKUP_S3_BUCKET    = var.object_storage.backup_bucket
    BACKUP_S3_REGION    = var.region
    CLICKHOUSE_DB       = var.analytics.database
  }

  # A change of settings or image restarts the pods; a new web image gets a new migration Job.
  config_version = substr(sha256(jsonencode(local.config)), 0, 16)
  migrate_job    = "bhava-migrate-${substr(sha256(var.web_image), 0, 10)}"

  # The data services' address ranges and ports in the network policy (the base holds documentation-range placeholders).
  data_egress_patch = [
    { op = "replace", path = "/spec/egress/0/to/0/ipBlock/cidr", value = var.postgres.cidr },
    { op = "replace", path = "/spec/egress/0/ports/0/port", value = var.postgres.port },
    { op = "replace", path = "/spec/egress/1/to/0/ipBlock/cidr", value = var.redis.cidr },
    { op = "replace", path = "/spec/egress/1/ports/0/port", value = var.redis.port },
    { op = "replace", path = "/spec/egress/2/to/0/ipBlock/cidr", value = var.analytics.cidr },
  ]
  storage_egress_patch = var.object_storage.cidr == "" ? [{ op = "remove", path = "/spec/egress/3" }] : [{ op = "replace", path = "/spec/egress/3/to/0/ipBlock/cidr", value = var.object_storage.cidr }]
  egress_patch         = concat(local.data_egress_patch, local.storage_egress_patch)
}

# ---- 1. the namespace ---------------------------------------------------------------------------------------------------

resource "kubernetes_namespace_v1" "bhava" {
  metadata {
    name = var.namespace
    labels = merge(local.labels, {
      "bhava.app/region"                   = var.region
      "pod-security.kubernetes.io/enforce" = "restricted"
    })
  }
}

resource "kubernetes_labels" "ingress_namespace" {
  api_version = "v1"
  kind        = "Namespace"

  metadata {
    name = var.ingress_namespace
  }

  labels = {
    "bhava.app/ingress" = "true"
  }
}

resource "kubernetes_labels" "monitoring_namespace" {
  count       = var.monitoring_namespace == "" ? 0 : 1
  api_version = "v1"
  kind        = "Namespace"

  metadata {
    name = var.monitoring_namespace
  }

  labels = {
    "bhava.app/monitoring" = "true"
  }
}

# Stable in-cluster names for the managed services, so the secrets may say bhava-postgres.<namespace>.svc and a move
# to another managed service changes only these variables (use the managed host itself with sslmode=verify-full).
resource "kubernetes_service_v1" "postgres" {
  metadata {
    name      = "bhava-postgres"
    namespace = kubernetes_namespace_v1.bhava.metadata[0].name
    labels    = local.labels
  }

  spec {
    type          = "ExternalName"
    external_name = var.postgres.host
  }
}

resource "kubernetes_service_v1" "redis" {
  metadata {
    name      = "bhava-redis"
    namespace = kubernetes_namespace_v1.bhava.metadata[0].name
    labels    = local.labels
  }

  spec {
    type          = "ExternalName"
    external_name = var.redis.host
  }
}

# ---- 2. secrets from an outside store (optional) --------------------------------------------------------------------

resource "kubernetes_manifest" "external_secret" {
  count = nonsensitive(var.secrets.external_store_name != "") ? 1 : 0

  manifest = {
    apiVersion = "external-secrets.io/v1beta1"
    kind       = "ExternalSecret"
    metadata = {
      name      = "bhava-secrets"
      namespace = kubernetes_namespace_v1.bhava.metadata[0].name
      labels    = local.labels
    }
    spec = {
      refreshInterval = var.secrets.refresh_interval
      secretStoreRef = {
        kind = var.secrets.external_store_kind
        name = var.secrets.external_store_name
      }
      target = {
        name           = "bhava-secrets"
        creationPolicy = "Owner"
        deletionPolicy = "Retain"
      }
      dataFrom = [{
        find = {
          path = var.secrets.remote_prefix
          name = { regexp = "^[A-Z0-9_]+$" }
        }
        rewrite = [{
          regexp = { source = "${var.secrets.remote_prefix}/(.*)", target = "$1" }
        }]
      }]
    }
  }
}

# ---- 3. the migration Job, before the rollout -----------------------------------------------------------------------

resource "kubernetes_job_v1" "migrate" {
  depends_on = [kubernetes_manifest.external_secret]

  metadata {
    name      = local.migrate_job
    namespace = kubernetes_namespace_v1.bhava.metadata[0].name
    labels    = merge(local.labels, { "app.kubernetes.io/component" = "migrate" })
  }

  spec {
    backoff_limit           = 0
    active_deadline_seconds = 900

    template {
      metadata {
        labels = {
          "app.kubernetes.io/name"      = "bhava"
          "app.kubernetes.io/component" = "migrate"
          "bhava.app/data-client"       = "true"
        }
      }

      spec {
        restart_policy                  = "Never"
        automount_service_account_token = false

        security_context {
          run_as_non_root = true
          run_as_user     = 1000
          run_as_group    = 1000

          seccomp_profile {
            type = "RuntimeDefault"
          }
        }

        container {
          name    = "migrate"
          image   = var.web_image
          command = ["node", "scripts/move-to-cloud.js", "schema"]

          env {
            name  = "NODE_ENV"
            value = "production"
          }

          env {
            name  = "SECRETS_DRIVER"
            value = "file"
          }

          env {
            name  = "SECRETS_DIR"
            value = "/run/secrets"
          }

          resources {
            requests = {
              cpu    = "100m"
              memory = "256Mi"
            }
            limits = {
              cpu    = "1"
              memory = "512Mi"
            }
          }

          security_context {
            allow_privilege_escalation = false
            read_only_root_filesystem  = true

            capabilities {
              drop = ["ALL"]
            }
          }

          volume_mount {
            name       = "tmp"
            mount_path = "/tmp"
          }

          volume_mount {
            name       = "secrets"
            mount_path = "/run/secrets"
            read_only  = true
          }
        }

        volume {
          name = "tmp"
          empty_dir {}
        }

        volume {
          name = "secrets"
          secret {
            secret_name  = "bhava-secrets"
            default_mode = "0400"
          }
        }
      }
    }
  }

  wait_for_completion = true

  timeouts {
    create = "15m"
    update = "15m"
  }
}

# ---- 4. everything else -----------------------------------------------------------------------------------------------

data "kustomization_overlay" "bhava" {
  resources = ["${path.module}/../k8s/base"]
  namespace = var.namespace

  images {
    name     = "bhava-web"
    new_name = var.web_image
  }

  images {
    name     = "bhava-worker"
    new_name = var.worker_image
  }

  replicas {
    name  = "bhava-web"
    count = var.replicas.web
  }

  replicas {
    name  = "bhava-worker"
    count = var.replicas.worker
  }

  patches {
    patch = yamlencode({
      apiVersion = "v1"
      kind       = "ConfigMap"
      metadata   = { name = "bhava-config" }
      data       = local.config
    })
  }

  patches {
    patch = yamlencode({
      apiVersion = "networking.k8s.io/v1"
      kind       = "Ingress"
      metadata   = { name = "bhava" }
      spec = {
        ingressClassName = var.ingress_class_name
        tls              = [{ hosts = local.hosts, secretName = var.origin_tls_secret_name }]
        rules = [for host in local.hosts : {
          host = host
          http = { paths = [{ path = "/", pathType = "Prefix", backend = { service = { name = "bhava-web", port = { name = "http" } } } }] }
        }]
      }
    })
  }

  patches {
    target {
      kind = "NetworkPolicy"
      name = "bhava-data-egress"
    }
    patch = jsonencode(local.egress_patch)
  }

  patches {
    target {
      kind = "Deployment"
      name = "bhava-(web|worker)"
    }
    patch = jsonencode([
      { op = "replace", path = "/spec/template/metadata/annotations/bhava.app~1config-version", value = local.config_version },
    ])
  }
}

resource "kustomization_resource" "p0" {
  for_each   = data.kustomization_overlay.bhava.ids_prio[0]
  manifest   = data.kustomization_overlay.bhava.manifests[each.value]
  depends_on = [kubernetes_namespace_v1.bhava]
}

resource "kustomization_resource" "p1" {
  for_each   = data.kustomization_overlay.bhava.ids_prio[1]
  manifest   = data.kustomization_overlay.bhava.manifests[each.value]
  depends_on = [kustomization_resource.p0, kubernetes_job_v1.migrate, kubernetes_labels.ingress_namespace]
}

resource "kustomization_resource" "p2" {
  for_each   = data.kustomization_overlay.bhava.ids_prio[2]
  manifest   = data.kustomization_overlay.bhava.manifests[each.value]
  depends_on = [kustomization_resource.p1]
}
