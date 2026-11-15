# Terraform module

Provider-neutral: it installs `../k8s/base` into a cluster it is given and creates nothing cloud-specific. A provider-specific module, when a cloud is chosen, lives in its own folder, creates the cluster, the managed Postgres, Redis, the analytics database and the buckets, and passes their addresses into this one.

| File | What it holds |
|---|---|
| `versions.tf` | Terraform 1.9 or later; the `hashicorp/kubernetes` and `kbst/kustomization` providers only. No backend: `terraform init -backend=false` works, and whoever deploys chooses a backend outside the repository. |
| `variables.tf` | The cluster (kubeconfig and context), the namespace, the ingress class and namespace, **`region`**, the images and release, the hosts, the managed services' addresses (`postgres`, `redis`, `analytics`, `object_storage`: hosts, ports, buckets and the address ranges the network policy admits, never a credential), and `secrets` (where `bhava-secrets` comes from: references only, `sensitive`). |
| `main.tf` | In order: the namespace (pod security `restricted`, labelled with the region) and the labels the network policy needs; an ExternalSecret when an outside store is named; the migration Job for this image, waited for; then everything else through kustomize with the settings merged into `bhava-config`, the hosts into the Ingress and the address ranges into the network policy. A change of settings restarts the pods; a new image runs a new migration Job first. |
| `outputs.tf` | The namespace, the migration Job, the settings' version, the hosts. |
| `terraform.tfvars.example` | Placeholders only. |

Credentials never pass through Terraform: `DATABASE_URL`, `REDIS_URL`, `CLICKHOUSE_URL` and the bucket keys are in the secret store. `bhava-postgres` and `bhava-redis` are ExternalName Services for the managed hosts, so the secrets may name a stable in-cluster address (with `sslmode=verify-full`, name the managed host itself).

```
terraform init
terraform plan  -var-file=<your file outside the repository>
terraform apply -var-file=<your file outside the repository>
```

## The region list

`region` is the only variable that names a region, and its validation accepts exactly the `india` list of `../regions.json` (data stays in India). The object storage settings (`S3_REGION`, `BACKUP_S3_REGION`) are set from it. The list covers the India regions of the major clouds, by each provider's own region names: AWS (Mumbai, Hyderabad), Google Cloud (Mumbai, Delhi), Azure (Central, South and West India, and the Jio India regions), Oracle Cloud (Mumbai, Hyderabad), DigitalOcean (Bengaluru), Akamai Linode (Chennai, Mumbai) and IBM Cloud (Mumbai, Chennai). A provider not on the list is added to `regions.json` first, with its India region's exact name.

**Cloudflare in front.** Cloudflare is the DNS and the proxy in front of whichever cloud runs Bhava; it is not a region and needs none here. Its edge serves visitors from the nearest location, but the origin, every database and every bucket stay in the region above. Do not use an object store that has no India location for the files or the backups. See `../runbooks/dns-and-cutover.md` for the TLS mode and the cut-over.

Checked by `terraform fmt -check`, `terraform init -backend=false` and `terraform validate` in the prod workflow (G-08), and by `test/p9/prod-deploy/terraform.test.js` (including a plan with a region outside India, which is refused, when Terraform is installed).
