# Terraform templates

Provider-neutral: no cloud is chosen. Track: deploy-templates. Empty until that track builds it.

To build here:

- A root module that **takes** what a cloud provides, as variables, and creates nothing cloud-specific itself: the cluster's API address and credentials reference, the managed Postgres addresses (the app login and the owner login), the Redis address, the analytics database address, the object storage endpoint and bucket, the backup bucket, the platform domain and hosts, the image reference, and where secrets are mounted from.
- It uses only the `kubernetes` (and, if needed, `helm`) providers to apply what `../k8s` describes, so the same module runs on any provider. A provider-specific module, when one is chosen, lives in its own folder and feeds these variables.
- **One variable named `region`**, with a `validation` block that accepts exactly the values of `../regions.json` (`india`). No other variable, default or resource names a region.
- Every variable that carries a secret reference is `sensitive = true` and holds a reference (a path or a name), never a value. No state backend is configured in the repository: `terraform init -backend=false` must work.
- `terraform.tfvars.example` with placeholders only.

Checked by `terraform fmt -check`, `terraform init -backend=false` and `terraform validate` in `npm run prod:validate`, plus a test that `region` refuses a region outside India (G-08).
