# What a cloud provides, taken as variables. Nothing here creates a cloud resource: a provider-specific module (in
# its own folder, when one is chosen) creates the cluster, the managed Postgres, Redis, the analytics database and the
# buckets, and passes their addresses in. No default holds a secret, an account id or a real address.

# ---- the cluster ------------------------------------------------------------------------------------------------------

variable "kubeconfig_path" {
  description = "Path to the kubeconfig file for the cluster to install into."
  type        = string
  default     = "~/.kube/config"
}

variable "kube_context" {
  description = "The kubeconfig context to use. Empty means the file's current context."
  type        = string
  default     = ""
}

variable "namespace" {
  description = "The namespace Bhava runs in. Created here."
  type        = string
  default     = "bhava"
}

variable "ingress_namespace" {
  description = "The ingress controller's namespace. It is labelled bhava.app/ingress=true so the network policy admits it."
  type        = string
}

variable "ingress_class_name" {
  description = "The IngressClass of the cluster's ingress controller."
  type        = string
}

variable "monitoring_namespace" {
  description = "The monitoring stack's namespace, labelled bhava.app/monitoring=true. Empty: none is labelled."
  type        = string
  default     = ""
}

# ---- where it runs ----------------------------------------------------------------------------------------------------

# The one variable that names a region. It accepts exactly the India regions listed in ../regions.json (data stays
# in India); the object storage region settings are set from it, and nothing else names a region.
variable "region" {
  description = "The provider's India region the cluster, the databases and the buckets are in (one of ../regions.json)."
  type        = string

  validation {
    condition     = contains(jsondecode(file("${path.module}/../regions.json")).india, var.region)
    error_message = "The region must be an India region listed in deploy/prod/regions.json: data stays in India."
  }
}

# ---- the release ------------------------------------------------------------------------------------------------------

variable "web_image" {
  description = "The web image (Dockerfile --target web), by tag or digest, e.g. <registry>/bhava-web:<version>."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9./_:-]*(:[A-Za-z0-9._-]+|@sha256:[0-9a-f]{64})$", var.web_image)) && !endswith(var.web_image, ":latest")
    error_message = "Name the web image with an exact tag or digest, never latest."
  }
}

variable "worker_image" {
  description = "The worker image (Dockerfile --target worker), by tag or digest."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9./_:-]*(:[A-Za-z0-9._-]+|@sha256:[0-9a-f]{64})$", var.worker_image)) && !endswith(var.worker_image, ":latest")
    error_message = "Name the worker image with an exact tag or digest, never latest."
  }
}

variable "release" {
  description = "The release name the app reports (RELEASE)."
  type        = string
}

variable "replicas" {
  description = "Starting replica counts; the autoscalers move them from here (web 2 to 10, worker 1 to 6)."

  type = object({
    web    = optional(number, 2)
    worker = optional(number, 1)
  })

  default = {}
}

# ---- hosts ------------------------------------------------------------------------------------------------------------

variable "platform_domain" {
  description = "The platform domain: businesses' fallback hosts are <slug>.<platform_domain>."
  type        = string
}

variable "platform_host" {
  description = "Where sellers sign in. Empty means app.<platform_domain>."
  type        = string
  default     = ""
}

variable "public_base_url" {
  description = "The platform's public https address."
  type        = string

  validation {
    condition     = startswith(var.public_base_url, "https://")
    error_message = "The public address must be https."
  }
}

variable "extra_hosts" {
  description = "More hosts the Ingress names (sellers' own domains need none: they reach the default backend)."
  type        = list(string)
  default     = []
}

variable "origin_tls_secret_name" {
  description = "The TLS Secret with the origin certificate for the platform hosts (Cloudflare in front)."
  type        = string
  default     = "bhava-origin-tls"
}

# ---- the managed services' addresses (no credentials: those are in the secret store) --------------------------------

variable "postgres" {
  description = "The managed Postgres: host, port, database name, and the address range the network policy admits."

  type = object({
    host     = string
    port     = optional(number, 5432)
    database = string
    cidr     = string
  })
}

variable "redis" {
  description = "The managed Redis: host, port and address range."

  type = object({
    host = string
    port = optional(number, 6379)
    cidr = string
  })
}

variable "analytics" {
  description = "The analytics database: its http(s) address with no login in it, the database name, and the address range."

  type = object({
    url      = string
    database = optional(string, "bhava")
    cidr     = string
  })

  validation {
    condition     = can(regex("^https?://[^@/]+(/.*)?$", var.analytics.url))
    error_message = "The analytics address carries no login: put CLICKHOUSE_URL with its login in the secret store."
  }
}

variable "object_storage" {
  description = "The S3-compatible object storage: endpoint, the files bucket, the backup bucket, and its address range when private."

  type = object({
    endpoint         = string
    bucket           = string
    backup_bucket    = string
    force_path_style = optional(bool, false)
    cidr             = optional(string, "")
  })
}

# ---- secrets: references only, never values ---------------------------------------------------------------------------

variable "secrets" {
  description = "Where the Secret bhava-secrets comes from. Empty external_store_name: it is made by hand (kubectl create secret generic bhava-secrets --from-file=<folder>). Otherwise an ExternalSecret fills it from that store, one remote key per setting under remote_prefix."

  type = object({
    external_store_name = optional(string, "")
    external_store_kind = optional(string, "ClusterSecretStore")
    remote_prefix       = optional(string, "bhava/production")
    refresh_interval    = optional(string, "1h")
  })

  default   = {}
  sensitive = true
}
