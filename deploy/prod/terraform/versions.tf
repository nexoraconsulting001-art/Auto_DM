# Provider-neutral: only the Kubernetes API is spoken to. No cloud provider is configured here, and no state backend
# (terraform init -backend=false works; whoever deploys chooses a backend outside the repository).
terraform {
  required_version = ">= 1.9.0"

  required_providers {
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2.33"
    }
    kustomization = {
      source  = "kbst/kustomization"
      version = "~> 0.9"
    }
  }
}
