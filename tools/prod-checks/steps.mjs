/**
 * The steps each readiness check reports, in order. tools/readiness/index.mjs lists the same names (READINESS_CHECKS); a test holds
 * the two together. They are repeated here because the check scripts cannot import index.mjs: index.mjs runs a check with a
 * top-level await, and a check that imported it back would wait for it forever.
 */
export const STEPS = Object.freeze({
  r05: Object.freeze(['drivers_are_production', 'no_source_change', 'suite_passes']),
  r06: Object.freeze(['two_servers_ready', 'session_survives_switch', 'upload_shows_on_both', 'scheduled_job_runs_once', 'drain_loses_nothing']),
  r07: Object.freeze(['source_seeded', 'backup_taken', 'restored_to_new_database', 'files_copied_to_object_storage', 'counts_match_per_business', 'checksums_match_per_business', 'only_config_changed']),
  validate: Object.freeze(['compose_config', 'kustomize_build', 'kubeconform', 'terraform_validate', 'region_is_india_only', 'promtool_check_rules', 'promtool_test_rules', 'dashboards_parse', 'metrics_exist']),
});
