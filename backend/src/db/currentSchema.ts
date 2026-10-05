export const currentSchemaSql: string = String.raw`
CREATE COLLATION inventory_text_order(
    provider = icu, deterministic = 'false', locale = 'en-US-u-ks-level1'
);

CREATE COLLATION inventory_version_order(
    provider = icu, deterministic = 'false', locale = 'en-US-u-kn-ks-level1'
);

CREATE FUNCTION official_usage_payload_hash(payload jsonb)
RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL safe
AS $$
  SELECT encode(sha256(convert_to(payload::text,'UTF8')),'hex')
$$;

CREATE TABLE app_schema (
    singleton boolean CONSTRAINT app_schema_pkey PRIMARY KEY DEFAULT TRUE CONSTRAINT app_schema_singleton_check CHECK (singleton)
  , fingerprint text NOT NULL CONSTRAINT app_schema_fingerprint_check CHECK (fingerprint ~ '^[a-f0-9]{64}$')
  , initialized_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE sessions (
    sid varchar NOT NULL
  , sess pg_catalog.json NOT NULL
  , expire timestamp with time zone NOT NULL
  , tenant_id text GENERATED ALWAYS AS (sess ->> CAST('tenantId' AS text)) STORED
  , principal_id text GENERATED ALWAYS AS (sess ->> CAST('accountId' AS text)) STORED
  , CONSTRAINT sessions_sess_check CHECK (octet_length(CAST(sess AS text)) <= 16384)
  , CONSTRAINT sessions_pkey PRIMARY KEY (sid)
);

CREATE TABLE source_identifiers (
    id uuid NOT NULL
  , tenant_id text NOT NULL
  , source text NOT NULL
  , environment_id text DEFAULT CAST('' AS text) NOT NULL
  , identifier_kind text NOT NULL
  , identifier_value text NOT NULL
  , resource_type text DEFAULT CAST('' AS text) NOT NULL
  , native_id text DEFAULT CAST('' AS text) NOT NULL
  , CONSTRAINT source_identifiers_identifier_kind_check CHECK (identifier_kind = ANY(ARRAY[CAST('package_id' AS text)
                                                                                         , CAST('package_app_id' AS text)
                                                                                         , CAST('manifest_id' AS text)
                                                                                         , CAST('asset_id' AS text)
                                                                                         , CAST('power_platform_resource_id' AS text)
                                                                                         , CAST('cds_bot_id' AS text)
                                                                                         , CAST('entra_app_id' AS text)
                                                                                         , CAST('entra_agent_id' AS text)
                                                                                         , CAST('entra_blueprint_id' AS text)
                                                                                         , CAST('environment_id' AS text)]))
  , CONSTRAINT source_identifiers_identifier_value_check CHECK (length(identifier_value) >= 1
                                                            AND length(identifier_value) <= 512)
  , CONSTRAINT source_identifiers_native_id_check CHECK (length(native_id) <= 512)
  , CONSTRAINT source_identifiers_resource_type_check CHECK (length(resource_type) <= 128)
  , CONSTRAINT source_identifiers_source_check CHECK (source = ANY(ARRAY[CAST('graph_packages' AS text)
                                                                       , CAST('power_platform' AS text)]))
  , CONSTRAINT source_identifiers_tenant_id_check CHECK (length(tenant_id) >= 1
                                                     AND length(tenant_id) <= 128)
  , CONSTRAINT source_identifiers_pkey PRIMARY KEY (id)
  , CONSTRAINT source_identifiers_scoped_identity UNIQUE (tenant_id, source, resource_type, environment_id, native_id, identifier_kind, identifier_value)
);

CREATE TABLE jobs (
    id uuid NOT NULL
  , tenant_id text NOT NULL
  , principal_id text NOT NULL
  , token_mode text NOT NULL
  , capability text NOT NULL
  , action text NOT NULL
  , request_hash text NOT NULL
  , idempotency_key text NOT NULL
  , access_update jsonb
  , actor_name text NOT NULL
  , actor_username text NOT NULL
  , request_path text NOT NULL
  , scope text NOT NULL
  , status text DEFAULT CAST('queued' AS text) NOT NULL
  , cancel_requested boolean DEFAULT FALSE NOT NULL
  , lease_owner uuid
  , lease_version integer DEFAULT 0 NOT NULL
  , lease_until timestamp with time zone
  , attempts integer DEFAULT 0 NOT NULL
  , created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
  , updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
  , deadline_at timestamp with time zone DEFAULT clock_timestamp() + CAST('00:30:00' AS interval) NOT NULL
  , expires_at timestamp with time zone DEFAULT clock_timestamp() + CAST('7 days' AS interval) NOT NULL
  , confirmation_hash text
  , confirmation_summary jsonb
  , confirmed_at timestamp with time zone
  , reassign_user_id text
  , result_revision bigint DEFAULT 0 NOT NULL
  , CONSTRAINT jobs_access_update_check CHECK (octet_length(CAST(access_update AS text)) <= 65536)
  , CONSTRAINT jobs_action_check CHECK (action = ANY(ARRAY[CAST('block' AS text)
                                                         , CAST('unblock' AS text)
                                                         , CAST('update-availability' AS text)
                                                         , CAST('update-installation' AS text)
                                                         , CAST('reassign' AS text)]))
  , CONSTRAINT jobs_attempts_check CHECK (attempts >= 0 AND attempts <= 10)
  , CONSTRAINT jobs_capability_check CHECK (capability = ANY(ARRAY[CAST('graph.package.access.manage' AS text)
                                                                 , CAST('graph.package.block.manage' AS text)]))
  , CONSTRAINT jobs_confirmation_complete CHECK ((confirmation_hash IS NULL
                                              AND confirmation_summary IS NULL
                                              AND confirmed_at IS NULL)
                                              OR (confirmation_hash IS NOT NULL
                                              AND confirmation_summary IS NOT NULL
                                              AND confirmed_at IS NOT NULL))
  , CONSTRAINT jobs_confirmation_hash_check CHECK (confirmation_hash ~ CAST('^[a-f0-9]{64}$' AS text))
  , CONSTRAINT jobs_confirmation_summary_check CHECK (jsonb_typeof(confirmation_summary) = CAST('object' AS text)
                                                  AND octet_length(CAST(confirmation_summary AS text)) <= 65536)
  , CONSTRAINT jobs_idempotency_key_check CHECK (length(idempotency_key) >= 1
                                             AND length(idempotency_key) <= 128)
  , CONSTRAINT jobs_reassign_user_id_check CHECK (length(reassign_user_id) >= 1
                                              AND length(reassign_user_id) <= 512)
  , CONSTRAINT jobs_reassignment_intent CHECK ((action = CAST('reassign' AS text)
                                            AND reassign_user_id IS NOT NULL
                                            AND access_update IS NULL)
                                            OR (action <> CAST('reassign' AS text)
                                            AND reassign_user_id IS NULL))
  , CONSTRAINT jobs_request_hash_check CHECK (request_hash ~ CAST('^[a-f0-9]{64}$' AS text))
  , CONSTRAINT jobs_request_path_check CHECK (length(request_path) <= 1024)
  , CONSTRAINT jobs_result_revision_check CHECK (result_revision >= 0)
  , CONSTRAINT jobs_scope_check CHECK (scope = ANY(ARRAY[CAST('single' AS text)
                                                       , CAST('bulk' AS text)]))
  , CONSTRAINT jobs_status_check CHECK (status = ANY(ARRAY[CAST('queued' AS text)
                                                         , CAST('running' AS text)
                                                         , CAST('waiting_authorization' AS text)
                                                         , CAST('succeeded' AS text)
                                                         , CAST('failed' AS text)
                                                         , CAST('cancelled' AS text)
                                                         , CAST('partial' AS text)]))
  , CONSTRAINT jobs_token_mode_check CHECK (token_mode = ANY(ARRAY[CAST('delegated' AS text)
                                                                 , CAST('application' AS text)]))
  , CONSTRAINT jobs_pkey PRIMARY KEY (id)
  , CONSTRAINT jobs_tenant_id_principal_id_capability_idempotency_key_key UNIQUE (tenant_id, principal_id, capability, idempotency_key)
);

CREATE TABLE job_items (
    id uuid NOT NULL
  , job_id uuid NOT NULL
  , ordinal integer NOT NULL
  , target_id text NOT NULL
  , display_name text NOT NULL
  , status text DEFAULT CAST('queued' AS text) NOT NULL
  , sent_at timestamp with time zone
  , message text
  , error_code text
  , updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
  , prestate_hash text
  , prestate jsonb
  , poststate_hash text
  , poststate jsonb
  , correlation_id uuid
  , reconciliation_status text DEFAULT CAST('not_required' AS text) NOT NULL
  , reconciled_at timestamp with time zone
  , source_generation_id uuid
  , source_identity text
  , agent_id uuid
  , authority_expires_at timestamp with time zone
  , CONSTRAINT job_inventory_authority_complete CHECK ((source_generation_id IS NULL
                                                    AND source_identity IS NULL
                                                    AND agent_id IS NULL
                                                    AND authority_expires_at IS NULL)
                                                    OR (source_generation_id IS NOT NULL
                                                    AND source_identity IS NOT NULL
                                                    AND agent_id IS NOT NULL
                                                    AND authority_expires_at IS NOT NULL))
  , CONSTRAINT job_items_error_code_check CHECK (length(error_code) <= 128)
  , CONSTRAINT job_items_message_check CHECK (length(message) <= 1024)
  , CONSTRAINT job_items_ordinal_check CHECK (ordinal >= 0 AND ordinal <= 4999)
  , CONSTRAINT job_items_poststate_check CHECK (jsonb_typeof(poststate) = CAST('object' AS text)
                                            AND octet_length(CAST(poststate AS text)) <= 65536)
  , CONSTRAINT job_items_poststate_complete CHECK ((poststate_hash IS NULL) = (poststate IS NULL))
  , CONSTRAINT job_items_poststate_hash_check CHECK (poststate_hash ~ CAST('^[a-f0-9]{64}$' AS text))
  , CONSTRAINT job_items_prestate_check CHECK (jsonb_typeof(prestate) = CAST('object' AS text)
                                           AND octet_length(CAST(prestate AS text)) <= 65536)
  , CONSTRAINT job_items_prestate_complete CHECK ((prestate_hash IS NULL) = (prestate IS NULL))
  , CONSTRAINT job_items_prestate_hash_check CHECK (prestate_hash ~ CAST('^[a-f0-9]{64}$' AS text))
  , CONSTRAINT job_items_reconciliation_complete CHECK ((reconciliation_status = ANY(ARRAY[CAST('not_required' AS text)
                                                                                         , CAST('required' AS text)])
                                                     AND reconciled_at IS NULL)
                                                     OR (reconciliation_status = ANY(ARRAY[CAST('verified_applied' AS text)
                                                                                         , CAST('verified_not_applied' AS text)
                                                                                         , CAST('conflict' AS text)])
                                                     AND reconciled_at IS NOT NULL))
  , CONSTRAINT job_items_reconciliation_status_check CHECK (reconciliation_status = ANY(ARRAY[CAST('not_required' AS text)
                                                                                            , CAST('required' AS text)
                                                                                            , CAST('verified_applied' AS text)
                                                                                            , CAST('verified_not_applied' AS text)
                                                                                            , CAST('conflict' AS text)]))
  , CONSTRAINT job_items_status_check CHECK (status = ANY(ARRAY[CAST('queued' AS text)
                                                              , CAST('running' AS text)
                                                              , CAST('succeeded' AS text)
                                                              , CAST('failed' AS text)
                                                              , CAST('cancelled' AS text)
                                                              , CAST('inconclusive' AS text)
                                                              , CAST('skipped' AS text)]))
  , CONSTRAINT job_items_target_id_check CHECK (length(target_id) >= 1 AND length(target_id) <= 512)
  , CONSTRAINT job_items_job_id_ordinal_key UNIQUE (job_id, ordinal)
  , CONSTRAINT job_items_job_id_target_id_key UNIQUE (job_id, target_id)
  , CONSTRAINT job_items_pkey PRIMARY KEY (id)
);

CREATE TABLE job_attempts (
    id uuid NOT NULL
  , job_id uuid NOT NULL
  , item_id uuid NOT NULL
  , lease_owner uuid NOT NULL
  , lease_version integer NOT NULL
  , started_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
  , sent_at timestamp with time zone
  , finished_at timestamp with time zone
  , outcome text
  , correlation_id uuid
  , prestate_hash text
  , readback_count integer DEFAULT 0 NOT NULL
  , CONSTRAINT job_attempts_outcome_check CHECK (outcome = ANY(ARRAY[CAST('succeeded' AS text)
                                                                   , CAST('failed' AS text)
                                                                   , CAST('cancelled' AS text)
                                                                   , CAST('inconclusive' AS text)
                                                                   , CAST('skipped' AS text)]))
  , CONSTRAINT job_attempts_prestate_hash_check CHECK (prestate_hash ~ CAST('^[a-f0-9]{64}$' AS text))
  , CONSTRAINT job_attempts_readback_count_check CHECK (readback_count >= 0
                                                    AND readback_count <= 20)
  , CONSTRAINT job_attempts_item_id_lease_version_key UNIQUE (item_id, lease_version)
  , CONSTRAINT job_attempts_pkey PRIMARY KEY (id)
);

CREATE TABLE audit_events (
    id uuid NOT NULL
  , event_id text NOT NULL
  , operation_id text NOT NULL
  , tenant_id text
  , principal_id text NOT NULL
  , actor_username text NOT NULL
  , actor_name text NOT NULL
  , scope text NOT NULL
  , action text NOT NULL
  , target_blocked_state boolean
  , agent_id text NOT NULL
  , agent_display_name text
  , started_at timestamp with time zone NOT NULL
  , observed_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
  , completed_at timestamp with time zone
  , status text NOT NULL
  , message text
  , error_code text
  , request_path text NOT NULL
  , metadata jsonb
  , CONSTRAINT audit_events_action_check CHECK (action = ANY(ARRAY[CAST('block' AS text)
                                                                 , CAST('unblock' AS text)
                                                                 , CAST('update-availability' AS text)
                                                                 , CAST('update-installation' AS text)
                                                                 , CAST('reassign' AS text)
                                                                 , CAST('view-audit-search' AS text)
                                                                 , CAST('export-audit-search' AS text)
                                                                 , CAST('view-hunting' AS text)
                                                                 , CAST('export-hunting' AS text)
                                                                 , CAST('approve-hunting' AS text)
                                                                 , CAST('qualify-hunting' AS text)
                                                                 , CAST('submit-hunting' AS text)
                                                                 , CAST('query-hunting' AS text)
                                                                 , CAST('cancel-hunting' AS text)
                                                                 , CAST('delete-hunting' AS text)
                                                                 , CAST('revoke-hunting-scope' AS text)
                                                                 , CAST('export-package-inventory' AS text)
                                                                 , CAST('export-power-platform-inventory' AS text)
                                                                 , CAST('export-official-usage-aggregate' AS text)
                                                                 , CAST('export-official-usage-users' AS text)
                                                                 , CAST('export-administrative-audit' AS text)
                                                                 , CAST('export-agent-inventory' AS text)
                                                                 , CAST('associate-agent-usage' AS text)
                                                                 , CAST('remove-agent-usage-association' AS text)]))
  , CONSTRAINT audit_events_action_state CHECK ((action = ANY(ARRAY[CAST('block' AS text)
                                                                  , CAST('unblock' AS text)])
                                             AND target_blocked_state IS NOT NULL)
                                             OR (action <> ALL(ARRAY[CAST('block' AS text)
                                                                   , CAST('unblock' AS text)])
                                             AND target_blocked_state IS NULL))
  , CONSTRAINT audit_events_error_code_check CHECK (length(error_code) <= 256)
  , CONSTRAINT audit_events_message_check CHECK (length(message) <= 4096)
  , CONSTRAINT audit_events_metadata_check CHECK (octet_length(CAST(metadata AS text)) <= 16384)
  , CONSTRAINT audit_events_scope_check CHECK (scope = ANY(ARRAY[CAST('single' AS text)
                                                               , CAST('bulk' AS text)]))
  , CONSTRAINT audit_events_status_check CHECK (status = ANY(ARRAY[CAST('requested' AS text)
                                                                 , CAST('started' AS text)
                                                                 , CAST('succeeded' AS text)
                                                                 , CAST('failed' AS text)
                                                                 , CAST('skipped' AS text)
                                                                 , CAST('inconclusive' AS text)
                                                                 , CAST('cancelled' AS text)]))
  , CONSTRAINT audit_events_pkey PRIMARY KEY (id)
);

CREATE TABLE capability_configuration (
    tenant_id text NOT NULL
  , capability_id text NOT NULL
  , enabled boolean DEFAULT FALSE NOT NULL
  , shared_data_scope boolean DEFAULT FALSE NOT NULL
  , preview_qualified boolean DEFAULT FALSE NOT NULL
  , revision integer DEFAULT 1 NOT NULL
  , updated_by text NOT NULL
  , updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
  , CONSTRAINT capability_configuration_capability_id_check CHECK (length(capability_id) >= 1
                                                               AND length(capability_id) <= 128)
  , CONSTRAINT capability_configuration_revision_check CHECK (revision > 0)
  , CONSTRAINT capability_configuration_tenant_id_check CHECK (length(tenant_id) >= 1
                                                           AND length(tenant_id) <= 128)
  , CONSTRAINT capability_configuration_updated_by_check CHECK (length(updated_by) >= 1
                                                            AND length(updated_by) <= 256)
  , CONSTRAINT capability_configuration_pkey PRIMARY KEY (tenant_id, capability_id)
);

CREATE TABLE capability_evidence (
    tenant_id text NOT NULL
  , principal_id text NOT NULL
  , capability_id text NOT NULL
  , resource_audience text NOT NULL
  , environment_id text DEFAULT CAST('' AS text) NOT NULL
  , token_mode text NOT NULL
  , permission_revision text NOT NULL
  , configuration_revision integer NOT NULL
  , status text NOT NULL
  , details jsonb DEFAULT CAST('{}' AS jsonb) NOT NULL
  , observed_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
  , expires_at timestamp with time zone NOT NULL
  , last_success_at timestamp with time zone
  , authorization_principal_id text NOT NULL
  , contract_revision text NOT NULL
  , CONSTRAINT capability_evidence_authorization_principal_check CHECK (length(authorization_principal_id) >= 1
                                                                    AND length(authorization_principal_id) <= 256)
  , CONSTRAINT capability_evidence_capability_id_check CHECK (length(capability_id) >= 1
                                                          AND length(capability_id) <= 128)
  , CONSTRAINT capability_evidence_configuration_revision_check CHECK (configuration_revision > 0)
  , CONSTRAINT capability_evidence_contract_revision_check CHECK (length(contract_revision) >= 1
                                                              AND length(contract_revision) <= 128)
  , CONSTRAINT capability_evidence_details_check CHECK (octet_length(CAST(details AS text)) <= 8192)
  , CONSTRAINT capability_evidence_environment_id_check CHECK (length(environment_id) <= 256)
  , CONSTRAINT capability_evidence_permission_revision_check CHECK (length(permission_revision) >= 1
                                                                AND length(permission_revision) <= 128)
  , CONSTRAINT capability_evidence_principal_id_check CHECK (length(principal_id) >= 1
                                                         AND length(principal_id) <= 256)
  , CONSTRAINT capability_evidence_resource_audience_check CHECK (length(resource_audience) >= 1
                                                              AND length(resource_audience) <= 256)
  , CONSTRAINT capability_evidence_status_check CHECK (status = ANY(ARRAY[CAST('available' AS text)
                                                                        , CAST('missing_permission' AS text)
                                                                        , CAST('missing_internal_role' AS text)
                                                                        , CAST('missing_role' AS text)
                                                                        , CAST('missing_license' AS text)
                                                                        , CAST('not_configured' AS text)
                                                                        , CAST('unsupported' AS text)
                                                                        , CAST('preview_disabled' AS text)
                                                                        , CAST('provider_error' AS text)
                                                                        , CAST('unknown' AS text)]))
  , CONSTRAINT capability_evidence_tenant_id_check CHECK (length(tenant_id) >= 1
                                                      AND length(tenant_id) <= 128)
  , CONSTRAINT capability_evidence_token_mode_check CHECK (token_mode = ANY(ARRAY[CAST('delegated' AS text)
                                                                                , CAST('application' AS text)]))
  , CONSTRAINT capability_evidence_pkey PRIMARY KEY (tenant_id, principal_id, authorization_principal_id, capability_id, resource_audience, environment_id, token_mode, permission_revision, contract_revision, configuration_revision)
);

CREATE TABLE power_platform_refresh_jobs (
    id uuid NOT NULL
  , tenant_id text NOT NULL
  , principal_id text NOT NULL
  , idempotency_key text NOT NULL
  , request_hash text NOT NULL
  , role_scope text NOT NULL
  , cloud text DEFAULT CAST('global' AS text) NOT NULL
  , environment_scope text DEFAULT CAST('' AS text) NOT NULL
  , requested_types jsonb NOT NULL
  , status text DEFAULT CAST('waiting_authorization' AS text) NOT NULL
  , page_count integer DEFAULT 0 NOT NULL
  , observed_count integer DEFAULT 0 NOT NULL
  , total_records integer
  , unknown_field_count integer DEFAULT 0 NOT NULL
  , error_code text
  , message text
  , created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
  , attempted_at timestamp with time zone
  , updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
  , finished_at timestamp with time zone
  , expires_at timestamp with time zone DEFAULT clock_timestamp() + CAST('7 days' AS interval) NOT NULL
  , deadline_at timestamp with time zone DEFAULT clock_timestamp() + CAST('00:30:00' AS interval) NOT NULL
  , CONSTRAINT power_platform_refresh_jobs_cloud_check CHECK (cloud = CAST('global' AS text))
  , CONSTRAINT power_platform_refresh_jobs_environment_scope_check CHECK (length(environment_scope) <= 512)
  , CONSTRAINT power_platform_refresh_jobs_error_code_check CHECK (length(error_code) <= 128)
  , CONSTRAINT power_platform_refresh_jobs_idempotency_key_check CHECK (length(idempotency_key) >= 1
                                                                    AND length(idempotency_key) <= 128)
  , CONSTRAINT power_platform_refresh_jobs_message_check CHECK (length(message) <= 1024)
  , CONSTRAINT power_platform_refresh_jobs_observed_count_check CHECK (observed_count >= 0
                                                                   AND observed_count <= 5000)
  , CONSTRAINT power_platform_refresh_jobs_page_count_check CHECK (page_count >= 0
                                                               AND page_count <= 50)
  , CONSTRAINT power_platform_refresh_jobs_principal_id_check CHECK (length(principal_id) >= 1
                                                                 AND length(principal_id) <= 256)
  , CONSTRAINT power_platform_refresh_jobs_request_hash_check CHECK (request_hash ~ CAST('^[a-f0-9]{64}$' AS text))
  , CONSTRAINT power_platform_refresh_jobs_requested_types_check CHECK (jsonb_typeof(requested_types) = CAST('array' AS text)
                                                                    AND (jsonb_array_length(requested_types) >= 1
                                                                     AND jsonb_array_length(requested_types) <= 2)
                                                                    AND requested_types <@ CAST('["microsoft.copilotstudio/agents", "microsoft.powerplatform/environments"]' AS jsonb))
  , CONSTRAINT power_platform_refresh_jobs_role_scope_check CHECK (role_scope = ANY(ARRAY[CAST('full' AS text)
                                                                                        , CAST('ai' AS text)
                                                                                        , CAST('unknown' AS text)]))
  , CONSTRAINT power_platform_refresh_jobs_status_check CHECK (status = ANY(ARRAY[CAST('waiting_authorization' AS text)
                                                                                , CAST('running' AS text)
                                                                                , CAST('succeeded' AS text)
                                                                                , CAST('failed' AS text)
                                                                                , CAST('cancelled' AS text)]))
  , CONSTRAINT power_platform_refresh_jobs_tenant_id_check CHECK (length(tenant_id) >= 1
                                                              AND length(tenant_id) <= 128)
  , CONSTRAINT power_platform_refresh_jobs_total_records_check CHECK (total_records >= 0
                                                                  AND total_records <= 5000)
  , CONSTRAINT power_platform_refresh_jobs_unknown_field_count_check CHECK (unknown_field_count >= 0
                                                                        AND unknown_field_count <= 1000000)
  , CONSTRAINT power_platform_refresh_jobs_pkey PRIMARY KEY (id)
  , CONSTRAINT power_platform_refresh_jobs_tenant_id_principal_id_idempote_key UNIQUE (tenant_id, principal_id, idempotency_key)
);

CREATE TABLE package_refresh_jobs (
    id uuid NOT NULL
  , tenant_id text NOT NULL
  , principal_id text NOT NULL
  , authorization_principal_id text NOT NULL
  , token_mode text NOT NULL
  , idempotency_key text NOT NULL
  , request_hash text NOT NULL
  , query_hash text NOT NULL
  , scope_kind text NOT NULL
  , status text DEFAULT CAST('waiting_authorization' AS text) NOT NULL
  , page_count integer DEFAULT 0 NOT NULL
  , observed_count integer DEFAULT 0 NOT NULL
  , total_records integer
  , error_code text
  , message text
  , created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
  , attempted_at timestamp with time zone
  , updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
  , finished_at timestamp with time zone
  , deadline_at timestamp with time zone DEFAULT clock_timestamp() + CAST('04:00:00' AS interval) NOT NULL
  , expires_at timestamp with time zone DEFAULT clock_timestamp() + CAST('7 days' AS interval) NOT NULL
  , auto_details boolean DEFAULT FALSE NOT NULL
  , CONSTRAINT inventory_refresh_job_mode CHECK (NOT auto_details
                                              OR (scope_kind = CAST('exact' AS text)
                                              AND token_mode = CAST('delegated' AS text)))
  , CONSTRAINT package_refresh_jobs_authorization_principal_id_check CHECK (length(authorization_principal_id) >= 1
                                                                        AND length(authorization_principal_id) <= 256)
  , CONSTRAINT package_refresh_jobs_error_code_check CHECK (length(error_code) <= 128)
  , CONSTRAINT package_refresh_jobs_idempotency_key_check CHECK (length(idempotency_key) >= 1
                                                             AND length(idempotency_key) <= 128)
  , CONSTRAINT package_refresh_jobs_message_check CHECK (length(message) <= 1024)
  , CONSTRAINT package_refresh_jobs_observed_count_check CHECK (observed_count >= 0
                                                            AND observed_count <= 5000)
  , CONSTRAINT package_refresh_jobs_page_count_check CHECK (page_count >= 0 AND page_count <= 100)
  , CONSTRAINT package_refresh_jobs_principal_id_check CHECK (length(principal_id) >= 1
                                                          AND length(principal_id) <= 256)
  , CONSTRAINT package_refresh_jobs_query_hash_check CHECK (query_hash ~ CAST('^[a-f0-9]{64}$' AS text))
  , CONSTRAINT package_refresh_jobs_request_hash_check CHECK (request_hash ~ CAST('^[a-f0-9]{64}$' AS text))
  , CONSTRAINT package_refresh_jobs_scope_kind_check CHECK (scope_kind = ANY(ARRAY[CAST('broad' AS text)
                                                                                 , CAST('exact' AS text)]))
  , CONSTRAINT package_refresh_jobs_status_check CHECK (status = ANY(ARRAY[CAST('waiting_authorization' AS text)
                                                                         , CAST('running' AS text)
                                                                         , CAST('succeeded' AS text)
                                                                         , CAST('failed' AS text)
                                                                         , CAST('cancelled' AS text)]))
  , CONSTRAINT package_refresh_jobs_tenant_id_check CHECK (length(tenant_id) >= 1
                                                       AND length(tenant_id) <= 128)
  , CONSTRAINT package_refresh_jobs_token_mode_check CHECK (token_mode = ANY(ARRAY[CAST('delegated' AS text)
                                                                                 , CAST('application' AS text)]))
  , CONSTRAINT package_refresh_jobs_total_records_check CHECK (total_records >= 0
                                                           AND total_records <= 5000)
  , CONSTRAINT package_refresh_jobs_pkey PRIMARY KEY (id)
  , CONSTRAINT package_refresh_jobs_tenant_id_principal_id_token_mode_idem_key UNIQUE (tenant_id, principal_id, token_mode, idempotency_key)
);

CREATE TABLE package_inventory_snapshots (
    id uuid NOT NULL
  , job_id uuid
  , tenant_id text NOT NULL
  , principal_id text NOT NULL
  , token_mode text NOT NULL
  , query_hash text NOT NULL
  , scope_kind text NOT NULL
  , requested_ids jsonb NOT NULL
  , observed_count integer NOT NULL
  , total_records integer NOT NULL
  , page_count integer NOT NULL
  , is_current boolean DEFAULT TRUE NOT NULL
  , observed_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
  , expires_at timestamp with time zone DEFAULT clock_timestamp() + CAST('30 days' AS interval) NOT NULL
  , observation_kind text NOT NULL
  , control_state jsonb
  , identity_revalidation_required boolean DEFAULT FALSE NOT NULL
  , read_started_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
  , catalog_only boolean DEFAULT FALSE NOT NULL
  , CONSTRAINT package_control_only CHECK (observation_kind = ANY(ARRAY[CAST('block' AS text)
                                                                      , CAST('access' AS text)])
                                       AND token_mode = CAST('delegated' AS text)
                                       AND scope_kind = CAST('exact' AS text)
                                       AND jsonb_array_length(requested_ids) = 1
                                       AND observed_count = 1
                                       AND total_records = 1)
  , CONSTRAINT package_inventory_snapshots_check CHECK ((scope_kind = CAST('broad' AS text)
                                                     AND jsonb_array_length(requested_ids) = 0)
                                                     OR (scope_kind = CAST('exact' AS text)
                                                     AND jsonb_array_length(requested_ids) > 0))
  , CONSTRAINT package_inventory_snapshots_observed_count_check CHECK (observed_count >= 0
                                                                   AND observed_count <= 5000)
  , CONSTRAINT package_inventory_snapshots_page_count_check CHECK (page_count >= 1
                                                               AND page_count <= 100)
  , CONSTRAINT package_inventory_snapshots_principal_id_check CHECK (length(principal_id) >= 1
                                                                 AND length(principal_id) <= 256)
  , CONSTRAINT package_inventory_snapshots_query_hash_check CHECK (query_hash ~ CAST('^[a-f0-9]{64}$' AS text))
  , CONSTRAINT package_inventory_snapshots_requested_ids_check CHECK (jsonb_typeof(requested_ids) = CAST('array' AS text)
                                                                  AND (jsonb_array_length(requested_ids) >= 0
                                                                   AND jsonb_array_length(requested_ids) <= 5000)
                                                                  AND octet_length(CAST(requested_ids AS text)) <= 2580000)
  , CONSTRAINT package_inventory_snapshots_scope_kind_check CHECK (scope_kind = ANY(ARRAY[CAST('broad' AS text)
                                                                                        , CAST('exact' AS text)]))
  , CONSTRAINT package_inventory_snapshots_tenant_id_check CHECK (length(tenant_id) >= 1
                                                              AND length(tenant_id) <= 128)
  , CONSTRAINT package_inventory_snapshots_token_mode_check CHECK (token_mode = ANY(ARRAY[CAST('delegated' AS text)
                                                                                        , CAST('application' AS text)]))
  , CONSTRAINT package_inventory_snapshots_total_records_check CHECK (total_records >= 0
                                                                  AND total_records <= 5000)
  , CONSTRAINT package_observation_kind CHECK ((observation_kind = CAST('inventory' AS text)
                                            AND control_state IS NULL)
                                            OR (observation_kind = ANY(ARRAY[CAST('block' AS text)
                                                                           , CAST('access' AS text)])
                                            AND control_state IS NOT NULL
                                            AND jsonb_typeof(control_state) = CAST('object' AS text)
                                            AND control_state ? CAST('kind' AS text)
                                            AND (control_state ->> CAST('kind' AS text)) = observation_kind
                                            AND token_mode = CAST('delegated' AS text)
                                            AND scope_kind = CAST('exact' AS text)
                                            AND jsonb_array_length(requested_ids) = 1
                                            AND observed_count = 1
                                            AND total_records = 1
                                            AND page_count = 1))
  , CONSTRAINT package_inventory_snapshots_id_tenant_id_principal_id_key UNIQUE (id, tenant_id, principal_id)
  , CONSTRAINT package_inventory_snapshots_job_id_key UNIQUE (job_id)
  , CONSTRAINT package_inventory_snapshots_pkey PRIMARY KEY (id)
);

CREATE TABLE package_inventory_resources (
    snapshot_id uuid NOT NULL
  , tenant_id text NOT NULL
  , principal_id text NOT NULL
  , native_id text NOT NULL
  , display_name text NOT NULL
  , is_blocked boolean NOT NULL
  , available_to text
  , deployed_to text
  , publisher text
  , last_modified_at timestamp with time zone
  , identifiers jsonb NOT NULL
  , package_data jsonb NOT NULL
  , CONSTRAINT package_inventory_resources_available_to_check CHECK (length(available_to) <= 128)
  , CONSTRAINT package_inventory_resources_deployed_to_check CHECK (length(deployed_to) <= 128)
  , CONSTRAINT package_inventory_resources_display_name_check CHECK (length(display_name) >= 1
                                                                 AND length(display_name) <= 256)
  , CONSTRAINT package_inventory_resources_identifiers_check CHECK (jsonb_typeof(identifiers) = CAST('array' AS text)
                                                                AND (jsonb_array_length(identifiers) >= 1
                                                                 AND jsonb_array_length(identifiers) <= 4)
                                                                AND octet_length(CAST(identifiers AS text)) <= 8192)
  , CONSTRAINT package_inventory_resources_native_id_check CHECK (length(native_id) >= 1
                                                              AND length(native_id) <= 512)
  , CONSTRAINT package_inventory_resources_package_data_check CHECK (jsonb_typeof(package_data) = CAST('object' AS text)
                                                                 AND octet_length(CAST(package_data AS text)) <= 2097152)
  , CONSTRAINT package_inventory_resources_publisher_check CHECK (length(publisher) <= 4096)
  , CONSTRAINT package_inventory_resources_pkey PRIMARY KEY (snapshot_id, native_id)
);

CREATE TABLE package_mutation_qualifications (
    id uuid NOT NULL
  , tenant_id text NOT NULL
  , target_id text NOT NULL
  , target_type text NOT NULL
  , action text NOT NULL
  , actor_principal_id text
  , actor_name text
  , approved_by text NOT NULL
  , contract_revision text NOT NULL
  , configuration_revision integer NOT NULL
  , auth_mode text NOT NULL
  , prestate jsonb NOT NULL
  , poststate jsonb NOT NULL
  , restoration_criteria jsonb NOT NULL
  , status text NOT NULL
  , qualified_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
  , expires_at timestamp with time zone NOT NULL
  , restored_at timestamp with time zone
  , workflow_version smallint DEFAULT 1 NOT NULL
  , approved_by_principal_id text
  , correlation_id uuid
  , attempted_at timestamp with time zone
  , error_code text
  , message text
  , paired_qualification_id uuid
  , job_id uuid
  , cycle_stage text
  , CONSTRAINT package_mutation_qualifications_action_check CHECK (action = ANY(ARRAY[CAST('block' AS text)
                                                                                    , CAST('unblock' AS text)
                                                                                    , CAST('update-availability' AS text)
                                                                                    , CAST('update-installation' AS text)
                                                                                    , CAST('reassign' AS text)]))
  , CONSTRAINT package_mutation_qualifications_actor_name_check CHECK (length(actor_name) >= 1
                                                                   AND length(actor_name) <= 256)
  , CONSTRAINT package_mutation_qualifications_actor_principal_id_check CHECK (length(actor_principal_id) >= 1
                                                                           AND length(actor_principal_id) <= 256)
  , CONSTRAINT package_mutation_qualifications_approved_by_check CHECK (length(approved_by) >= 1
                                                                    AND length(approved_by) <= 256)
  , CONSTRAINT package_mutation_qualifications_approved_by_principal_id_check CHECK (approved_by_principal_id IS NULL
                                                                                  OR (length(approved_by_principal_id) >= 1
                                                                                  AND length(approved_by_principal_id) <= 256))
  , CONSTRAINT package_mutation_qualifications_auth_mode_check CHECK (auth_mode = CAST('delegated' AS text))
  , CONSTRAINT package_mutation_qualifications_check CHECK (expires_at > qualified_at)
  , CONSTRAINT package_mutation_qualifications_configuration_revision_check CHECK (configuration_revision > 0)
  , CONSTRAINT package_mutation_qualifications_contract_revision_check CHECK (length(contract_revision) >= 1
                                                                          AND length(contract_revision) <= 128)
  , CONSTRAINT package_mutation_qualifications_cycle_stage_check CHECK (cycle_stage = ANY(ARRAY[CAST('original' AS text)
                                                                                              , CAST('restoration' AS text)]))
  , CONSTRAINT package_mutation_qualifications_error_code_check CHECK (error_code IS NULL
                                                                    OR (length(error_code) >= 1
                                                                    AND length(error_code) <= 128))
  , CONSTRAINT package_mutation_qualifications_message_check CHECK (message IS NULL
                                                                 OR (length(message) >= 1
                                                                 AND length(message) <= 1024))
  , CONSTRAINT package_mutation_qualifications_poststate_check CHECK (jsonb_typeof(poststate) = CAST('object' AS text)
                                                                  AND octet_length(CAST(poststate AS text)) <= 65536)
  , CONSTRAINT package_mutation_qualifications_prestate_check CHECK (jsonb_typeof(prestate) = CAST('object' AS text)
                                                                 AND octet_length(CAST(prestate AS text)) <= 65536)
  , CONSTRAINT package_mutation_qualifications_restoration_criteria_check CHECK (jsonb_typeof(restoration_criteria) = CAST('object' AS text)
                                                                             AND octet_length(CAST(restoration_criteria AS text)) <= 65536)
  , CONSTRAINT package_mutation_qualifications_status_check CHECK (status = ANY(ARRAY[CAST('approved' AS text)
                                                                                    , CAST('restoring' AS text)
                                                                                    , CAST('qualified' AS text)
                                                                                    , CAST('restoration_conflict' AS text)
                                                                                    , CAST('failed' AS text)
                                                                                    , CAST('inconclusive' AS text)
                                                                                    , CAST('expired' AS text)]))
  , CONSTRAINT package_mutation_qualifications_target_id_check CHECK (length(target_id) >= 1
                                                                  AND length(target_id) <= 512)
  , CONSTRAINT package_mutation_qualifications_target_type_check CHECK (target_type = CAST('copilot_package' AS text))
  , CONSTRAINT package_mutation_qualifications_tenant_id_check CHECK (length(tenant_id) >= 1
                                                                  AND length(tenant_id) <= 128)
  , CONSTRAINT package_mutation_qualifications_workflow_check CHECK ((workflow_version = 1
                                                                  AND status = ANY(ARRAY[CAST('restoration_conflict' AS text)
                                                                                       , CAST('failed' AS text)
                                                                                       , CAST('expired' AS text)]))
                                                                  OR (workflow_version = 2
                                                                  AND approved_by_principal_id IS NOT NULL
                                                                  AND status <> CAST('qualified' AS text))
                                                                  OR (workflow_version = 3
                                                                  AND approved_by_principal_id IS NOT NULL
                                                                  AND ((status = CAST('approved' AS text)
                                                                    AND actor_principal_id IS NULL
                                                                    AND actor_name IS NULL
                                                                    AND correlation_id IS NULL
                                                                    AND attempted_at IS NULL
                                                                    AND restored_at IS NULL
                                                                    AND error_code IS NULL
                                                                    AND paired_qualification_id IS NULL
                                                                    AND job_id IS NULL
                                                                    AND cycle_stage IS NULL)
                                                                    OR (status = CAST('restoring' AS text)
                                                                    AND actor_principal_id IS NOT NULL
                                                                    AND actor_name IS NOT NULL
                                                                    AND correlation_id IS NOT NULL
                                                                    AND attempted_at IS NOT NULL
                                                                    AND restored_at IS NULL
                                                                    AND error_code IS NULL
                                                                    AND paired_qualification_id IS NOT NULL
                                                                    AND cycle_stage IS NOT NULL)
                                                                    OR (status = CAST('qualified' AS text)
                                                                    AND actor_principal_id IS NOT NULL
                                                                    AND actor_name IS NOT NULL
                                                                    AND correlation_id IS NOT NULL
                                                                    AND attempted_at IS NOT NULL
                                                                    AND restored_at IS NOT NULL
                                                                    AND error_code IS NULL
                                                                    AND paired_qualification_id IS NOT NULL
                                                                    AND job_id IS NOT NULL
                                                                    AND cycle_stage IS NOT NULL)
                                                                    OR (status = ANY(ARRAY[CAST('restoration_conflict' AS text)
                                                                                         , CAST('failed' AS text)
                                                                                         , CAST('inconclusive' AS text)])
                                                                    AND actor_principal_id IS NOT NULL
                                                                    AND actor_name IS NOT NULL
                                                                    AND correlation_id IS NOT NULL
                                                                    AND attempted_at IS NOT NULL
                                                                    AND restored_at IS NULL
                                                                    AND error_code IS NOT NULL
                                                                    AND paired_qualification_id IS NOT NULL
                                                                    AND cycle_stage IS NOT NULL)
                                                                    OR status = CAST('expired' AS text))))
  , CONSTRAINT package_mutation_qualifications_workflow_version_check CHECK (workflow_version = ANY(ARRAY[1, 2, 3]))
  , CONSTRAINT package_mutation_qualifications_pkey PRIMARY KEY (id)
);

CREATE TABLE official_usage_staging (
    id uuid NOT NULL
  , tenant_id text NOT NULL
  , actor_principal_id text NOT NULL
  , revision integer DEFAULT 1 NOT NULL
  , status text DEFAULT CAST('active' AS text) NOT NULL
  , kind text NOT NULL
  , file_hash text NOT NULL
  , parser_version text NOT NULL
  , schema_version text NOT NULL
  , bundle_id uuid NOT NULL
  , correction_of_set_id uuid
  , reporting_start date
  , reporting_end date
  , period_provenance text NOT NULL
  , source_as_of timestamp with time zone
  , source_as_of_provenance text NOT NULL
  , source_freshness text NOT NULL
  , downloaded_at timestamp with time zone
  , row_count integer NOT NULL
  , stored_bytes bigint NOT NULL
  , warnings jsonb DEFAULT CAST('[]' AS jsonb) NOT NULL
  , reconciliation jsonb DEFAULT CAST('{}' AS jsonb) NOT NULL
  , active_revision bigint NOT NULL
  , accepted_version_id uuid
  , accepted_set_id uuid
  , created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
  , expires_at timestamp with time zone DEFAULT clock_timestamp() + CAST('00:30:00' AS interval) NOT NULL
  , accepted_at timestamp with time zone
  , accepted_result_revision bigint
  , content_hash text
  , CONSTRAINT official_usage_staging_active_revision_check CHECK (active_revision > 0)
  , CONSTRAINT official_usage_staging_actor_principal_id_check CHECK (length(actor_principal_id) >= 1
                                                                  AND length(actor_principal_id) <= 256)
  , CONSTRAINT official_usage_staging_check CHECK (reporting_start <= reporting_end)
  , CONSTRAINT official_usage_staging_check1 CHECK ((source_as_of IS NULL
                                                 AND source_as_of_provenance = CAST('absent' AS text)
                                                 AND source_freshness = CAST('unknown' AS text))
                                                 OR (source_as_of IS NOT NULL
                                                 AND source_as_of_provenance = CAST('source_metadata' AS text)
                                                 AND source_freshness = CAST('known' AS text))
                                                 OR (source_as_of IS NOT NULL
                                                 AND source_as_of_provenance = CAST('operator_asserted' AS text)
                                                 AND source_freshness = CAST('unknown' AS text)))
  , CONSTRAINT official_usage_staging_check2 CHECK ((status = CAST('accepted' AS text)
                                                 AND accepted_version_id IS NOT NULL
                                                 AND accepted_set_id IS NOT NULL
                                                 AND accepted_at IS NOT NULL)
                                                 OR (status <> CAST('accepted' AS text)
                                                 AND accepted_version_id IS NULL
                                                 AND accepted_set_id IS NULL
                                                 AND accepted_at IS NULL))
  , CONSTRAINT official_usage_staging_content_hash_check CHECK (content_hash IS NULL
                                                             OR content_hash ~ CAST('^[a-f0-9]{64}$' AS text))
  , CONSTRAINT official_usage_staging_content_hash_state CHECK (status <> CAST('active' AS text)
                                                             OR content_hash IS NOT NULL)
  , CONSTRAINT official_usage_staging_file_hash_check CHECK (file_hash ~ CAST('^[a-f0-9]{64}$' AS text))
  , CONSTRAINT official_usage_staging_kind_check CHECK (kind = ANY(ARRAY[CAST('agents' AS text)
                                                                       , CAST('userAgents' AS text)
                                                                       , CAST('users' AS text)]))
  , CONSTRAINT official_usage_staging_parser_version_check CHECK (length(parser_version) >= 1
                                                              AND length(parser_version) <= 64)
  , CONSTRAINT official_usage_staging_period_provenance_check CHECK (period_provenance = ANY(ARRAY[CAST('source_metadata' AS text)
                                                                                                 , CAST('operator_asserted' AS text)
                                                                                                 , CAST('activity_range' AS text)]))
  , CONSTRAINT official_usage_staging_receipt_check CHECK ((status = CAST('accepted' AS text)
                                                        AND accepted_result_revision IS NOT NULL
                                                        AND accepted_result_revision > 0)
                                                        OR (status <> CAST('accepted' AS text)
                                                        AND accepted_result_revision IS NULL))
  , CONSTRAINT official_usage_staging_reconciliation_check CHECK (jsonb_typeof(reconciliation) = CAST('object' AS text)
                                                              AND octet_length(CAST(reconciliation AS text)) <= 32768)
  , CONSTRAINT official_usage_staging_reporting_range_check CHECK ((reporting_start IS NULL
                                                                AND reporting_end IS NULL)
                                                                OR (reporting_start IS NOT NULL
                                                                AND reporting_end IS NOT NULL
                                                                AND reporting_start <= reporting_end))
  , CONSTRAINT official_usage_staging_revision_check CHECK (revision > 0)
  , CONSTRAINT official_usage_staging_row_count_check CHECK (row_count >= 0
                                                         AND row_count <= 1000000)
  , CONSTRAINT official_usage_staging_schema_version_check CHECK (length(schema_version) >= 1
                                                              AND length(schema_version) <= 128)
  , CONSTRAINT official_usage_staging_source_as_of_provenance_check CHECK (source_as_of_provenance = ANY(ARRAY[CAST('source_metadata' AS text)
                                                                                                             , CAST('operator_asserted' AS text)
                                                                                                             , CAST('absent' AS text)]))
  , CONSTRAINT official_usage_staging_source_freshness_check CHECK (source_freshness = ANY(ARRAY[CAST('known' AS text)
                                                                                               , CAST('unknown' AS text)]))
  , CONSTRAINT official_usage_staging_status_check CHECK (status = ANY(ARRAY[CAST('active' AS text)
                                                                           , CAST('accepted' AS text)
                                                                           , CAST('replaced' AS text)
                                                                           , CAST('expired' AS text)
                                                                           , CAST('cancelled' AS text)]))
  , CONSTRAINT official_usage_staging_stored_bytes_check CHECK (stored_bytes >= 2
                                                            AND stored_bytes <= CAST('8589934592' AS bigint))
  , CONSTRAINT official_usage_staging_tenant_id_check CHECK (length(tenant_id) >= 1
                                                         AND length(tenant_id) <= 128)
  , CONSTRAINT official_usage_staging_warnings_check CHECK (jsonb_typeof(warnings) = CAST('array' AS text)
                                                        AND jsonb_array_length(warnings) <= 100
                                                        AND octet_length(CAST(warnings AS text)) <= 32768)
  , CONSTRAINT official_usage_staging_pkey PRIMARY KEY (id)
  , CONSTRAINT official_usage_staging_scope_unique UNIQUE (id, tenant_id, actor_principal_id)
);

CREATE TABLE official_usage_staged_rows (
    staging_id uuid NOT NULL
  , tenant_id text NOT NULL
  , actor_principal_id text NOT NULL
  , ordinal integer NOT NULL
  , row_data jsonb NOT NULL
  , CONSTRAINT official_usage_staged_rows_ordinal_check CHECK (ordinal >= 0 AND ordinal <= 999999)
  , CONSTRAINT official_usage_staged_rows_row_data_check CHECK (jsonb_typeof(row_data) = CAST('object' AS text)
                                                            AND octet_length(CAST(row_data AS text)) <= 16384)
  , CONSTRAINT official_usage_staged_rows_pkey PRIMARY KEY (staging_id, ordinal)
);

CREATE TABLE official_usage_artifacts (
    id uuid NOT NULL
  , tenant_id text NOT NULL
  , kind text NOT NULL
  , file_hash text NOT NULL
  , parser_version text NOT NULL
  , schema_version text NOT NULL
  , first_accepted_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
  , expires_at timestamp with time zone
  , CONSTRAINT official_usage_artifacts_file_hash_check CHECK (file_hash ~ CAST('^[a-f0-9]{64}$' AS text))
  , CONSTRAINT official_usage_artifacts_kind_check CHECK (kind = ANY(ARRAY[CAST('agents' AS text)
                                                                         , CAST('userAgents' AS text)
                                                                         , CAST('users' AS text)]))
  , CONSTRAINT official_usage_artifacts_parser_version_check CHECK (length(parser_version) >= 1
                                                                AND length(parser_version) <= 64)
  , CONSTRAINT official_usage_artifacts_schema_version_check CHECK (length(schema_version) >= 1
                                                                AND length(schema_version) <= 128)
  , CONSTRAINT official_usage_artifacts_tenant_id_check CHECK (length(tenant_id) >= 1
                                                           AND length(tenant_id) <= 128)
  , CONSTRAINT official_usage_artifacts_id_tenant_id_kind_key UNIQUE (id, tenant_id, kind)
  , CONSTRAINT official_usage_artifacts_pkey PRIMARY KEY (id)
  , CONSTRAINT official_usage_artifacts_tenant_id_kind_file_hash_key UNIQUE (tenant_id, kind, file_hash)
);

CREATE TABLE official_usage_sets (
    id uuid NOT NULL
  , tenant_id text NOT NULL
  , bundle_id uuid NOT NULL
  , reporting_start date
  , reporting_end date
  , supersedes_set_id uuid
  , complete boolean DEFAULT FALSE NOT NULL
  , accepted_at timestamp with time zone
  , deleted_at timestamp with time zone
  , created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
  , expires_at timestamp with time zone
  , actor_principal_id text NOT NULL
  , period_provenance text NOT NULL
  , content_hash text
  , CONSTRAINT official_usage_sets_actor_check CHECK (length(actor_principal_id) >= 1
                                                  AND length(actor_principal_id) <= 256)
  , CONSTRAINT official_usage_sets_check CHECK (reporting_start <= reporting_end)
  , CONSTRAINT official_usage_sets_check1 CHECK ((complete AND accepted_at IS NOT NULL)
                                              OR (NOT complete AND accepted_at IS NULL))
  , CONSTRAINT official_usage_sets_content_hash_check CHECK (content_hash IS NULL
                                                          OR content_hash ~ CAST('^[a-f0-9]{64}$' AS text))
  , CONSTRAINT official_usage_sets_content_hash_state CHECK ((complete AND content_hash IS NOT NULL)
                                                          OR (NOT complete AND content_hash IS NULL))
  , CONSTRAINT official_usage_sets_period_provenance_check CHECK (period_provenance = ANY(ARRAY[CAST('source_metadata' AS text)
                                                                                              , CAST('operator_asserted' AS text)
                                                                                              , CAST('activity_range' AS text)]))
  , CONSTRAINT official_usage_sets_reporting_range_check CHECK ((reporting_start IS NULL
                                                             AND reporting_end IS NULL)
                                                             OR (reporting_start IS NOT NULL
                                                             AND reporting_end IS NOT NULL
                                                             AND reporting_start <= reporting_end))
  , CONSTRAINT official_usage_sets_tenant_id_check CHECK (length(tenant_id) >= 1
                                                      AND length(tenant_id) <= 128)
  , CONSTRAINT official_usage_sets_id_tenant_id_key UNIQUE (id, tenant_id)
  , CONSTRAINT official_usage_sets_pkey PRIMARY KEY (id)
  , CONSTRAINT official_usage_sets_tenant_id_bundle_id_key UNIQUE (tenant_id, bundle_id)
);

CREATE TABLE official_usage_versions (
    id uuid NOT NULL
  , tenant_id text NOT NULL
  , artifact_id uuid NOT NULL
  , staging_id uuid NOT NULL
  , kind text NOT NULL
  , reporting_start date
  , reporting_end date
  , period_provenance text NOT NULL
  , source_as_of timestamp with time zone
  , source_as_of_provenance text NOT NULL
  , source_freshness text NOT NULL
  , downloaded_at timestamp with time zone
  , row_count integer NOT NULL
  , warnings jsonb DEFAULT CAST('[]' AS jsonb) NOT NULL
  , accepted_by text NOT NULL
  , supersedes_version_id uuid
  , accepted_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
  , deleted_at timestamp with time zone
  , expires_at timestamp with time zone
  , reconciliation jsonb DEFAULT CAST('{}' AS jsonb) NOT NULL
  , content_hash text NOT NULL
  , CONSTRAINT official_usage_versions_accepted_by_check CHECK (length(accepted_by) >= 1
                                                            AND length(accepted_by) <= 256)
  , CONSTRAINT official_usage_versions_check CHECK (reporting_start <= reporting_end)
  , CONSTRAINT official_usage_versions_content_hash_check CHECK (content_hash IS NULL
                                                              OR content_hash ~ CAST('^[a-f0-9]{64}$' AS text))
  , CONSTRAINT official_usage_versions_kind_check CHECK (kind = ANY(ARRAY[CAST('agents' AS text)
                                                                        , CAST('userAgents' AS text)
                                                                        , CAST('users' AS text)]))
  , CONSTRAINT official_usage_versions_period_provenance_check CHECK (period_provenance = ANY(ARRAY[CAST('source_metadata' AS text)
                                                                                                  , CAST('operator_asserted' AS text)
                                                                                                  , CAST('activity_range' AS text)]))
  , CONSTRAINT official_usage_versions_reconciliation_check CHECK (jsonb_typeof(reconciliation) = CAST('object' AS text)
                                                               AND octet_length(CAST(reconciliation AS text)) <= 32768)
  , CONSTRAINT official_usage_versions_reporting_range_check CHECK ((reporting_start IS NULL
                                                                 AND reporting_end IS NULL)
                                                                 OR (reporting_start IS NOT NULL
                                                                 AND reporting_end IS NOT NULL
                                                                 AND reporting_start <= reporting_end))
  , CONSTRAINT official_usage_versions_row_count_check CHECK (row_count >= 0
                                                          AND row_count <= 1000000)
  , CONSTRAINT official_usage_versions_source_as_of_provenance_check CHECK (source_as_of_provenance = ANY(ARRAY[CAST('source_metadata' AS text)
                                                                                                              , CAST('operator_asserted' AS text)
                                                                                                              , CAST('absent' AS text)]))
  , CONSTRAINT official_usage_versions_source_freshness_check CHECK (source_freshness = ANY(ARRAY[CAST('known' AS text)
                                                                                                , CAST('unknown' AS text)]))
  , CONSTRAINT official_usage_versions_tenant_id_check CHECK (length(tenant_id) >= 1
                                                          AND length(tenant_id) <= 128)
  , CONSTRAINT official_usage_versions_warnings_check CHECK (jsonb_typeof(warnings) = CAST('array' AS text)
                                                         AND jsonb_array_length(warnings) <= 100
                                                         AND octet_length(CAST(warnings AS text)) <= 32768)
  , CONSTRAINT official_usage_versions_id_tenant_id_kind_key UNIQUE (id, tenant_id, kind)
  , CONSTRAINT official_usage_versions_pkey PRIMARY KEY (id)
  , CONSTRAINT official_usage_versions_staging_id_key UNIQUE (staging_id)
);

CREATE TABLE official_usage_version_rows (
    version_id uuid NOT NULL
  , tenant_id text NOT NULL
  , kind text NOT NULL
  , ordinal integer NOT NULL
  , payload_hash text NOT NULL
  , CONSTRAINT official_usage_version_rows_ordinal_check CHECK (ordinal >= 0 AND ordinal <= 999999)
  , CONSTRAINT official_usage_version_rows_pkey PRIMARY KEY (version_id, ordinal)
);

CREATE TABLE official_usage_set_versions (
    set_id uuid NOT NULL
  , tenant_id text NOT NULL
  , kind text NOT NULL
  , version_id uuid NOT NULL
  , CONSTRAINT official_usage_set_versions_kind_check CHECK (kind = ANY(ARRAY[CAST('agents' AS text)
                                                                            , CAST('userAgents' AS text)
                                                                            , CAST('users' AS text)]))
  , CONSTRAINT official_usage_set_versions_pkey PRIMARY KEY (set_id, kind)
);

CREATE TABLE official_usage_state (
    tenant_id text NOT NULL
  , active_set_id uuid
  , revision bigint DEFAULT 1 NOT NULL
  , updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
  , CONSTRAINT official_usage_state_revision_check CHECK (revision > 0)
  , CONSTRAINT official_usage_state_tenant_id_check CHECK (length(tenant_id) >= 1
                                                       AND length(tenant_id) <= 128)
  , CONSTRAINT official_usage_state_pkey PRIMARY KEY (tenant_id)
);

CREATE TABLE official_usage_confirmations (
    id uuid NOT NULL
  , tenant_id text NOT NULL
  , actor_principal_id text NOT NULL
  , operation text NOT NULL
  , target_set_id uuid NOT NULL
  , expected_revision bigint NOT NULL
  , confirmation_hash text NOT NULL
  , created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
  , expires_at timestamp with time zone DEFAULT clock_timestamp() + CAST('00:10:00' AS interval) NOT NULL
  , consumed_at timestamp with time zone
  , history_revision bigint
  , history_epoch bigint
  , CONSTRAINT official_usage_confirmations_actor_principal_id_check CHECK (length(actor_principal_id) >= 1
                                                                        AND length(actor_principal_id) <= 256)
  , CONSTRAINT official_usage_confirmations_confirmation_hash_check CHECK (confirmation_hash ~ CAST('^[a-f0-9]{64}$' AS text))
  , CONSTRAINT official_usage_confirmations_expected_revision_check CHECK (expected_revision > 0)
  , CONSTRAINT official_usage_confirmations_operation_check CHECK (operation = ANY(ARRAY[CAST('select' AS text)
                                                                                       , CAST('delete' AS text)]))
  , CONSTRAINT official_usage_confirmations_tenant_id_check CHECK (length(tenant_id) >= 1
                                                               AND length(tenant_id) <= 128)
  , CONSTRAINT official_usage_confirmations_pkey PRIMARY KEY (id)
);

CREATE TABLE official_usage_audit (
    id uuid NOT NULL
  , tenant_id text NOT NULL
  , actor_principal_id text NOT NULL
  , action text NOT NULL
  , target_kind text
  , target_id uuid
  , row_count integer
  , outcome text NOT NULL
  , error_code text
  , observed_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
  , expires_at timestamp with time zone DEFAULT clock_timestamp() + CAST('90 days' AS interval) NOT NULL
  , CONSTRAINT official_usage_audit_action_check CHECK (action IN ('staged', 'accepted', 'selected', 'deleted', 'discarded'))
  , CONSTRAINT official_usage_audit_actor_principal_id_check CHECK (length(actor_principal_id) >= 1
                                                                AND length(actor_principal_id) <= 256)
  , CONSTRAINT official_usage_audit_error_code_check CHECK (error_code IS NULL
                                                         OR (length(error_code) >= 1
                                                         AND length(error_code) <= 128))
  , CONSTRAINT official_usage_audit_outcome_check CHECK (outcome = ANY(ARRAY[CAST('succeeded' AS text)
                                                                           , CAST('rejected' AS text)]))
  , CONSTRAINT official_usage_audit_row_count_check CHECK (row_count >= 0 AND row_count <= 1000000)
  , CONSTRAINT official_usage_audit_target_kind_check CHECK (target_kind IS NULL
                                                          OR target_kind = ANY(ARRAY[CAST('agents' AS text)
                                                                                   , CAST('userAgents' AS text)
                                                                                   , CAST('users' AS text)]))
  , CONSTRAINT official_usage_audit_tenant_id_check CHECK (length(tenant_id) >= 1
                                                       AND length(tenant_id) <= 128)
  , CONSTRAINT official_usage_audit_pkey PRIMARY KEY (id)
);

CREATE TABLE official_usage_bundle_receipts (
    tenant_id text NOT NULL
  , actor_principal_id text NOT NULL
  , bundle_id uuid NOT NULL
  , bundle_hash text NOT NULL
  , expected_active_revision bigint NOT NULL
  , result_set_id uuid NOT NULL
  , result_version_id uuid NOT NULL
  , result_active_revision bigint NOT NULL
  , result_complete boolean NOT NULL
  , created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
  , expires_at timestamp with time zone DEFAULT clock_timestamp() + CAST('180 days' AS interval) NOT NULL
  , CONSTRAINT official_usage_bundle_receipts_actor_principal_id_check CHECK (length(actor_principal_id) >= 1
                                                                          AND length(actor_principal_id) <= 256)
  , CONSTRAINT official_usage_bundle_receipts_bundle_hash_check CHECK (bundle_hash ~ CAST('^[a-f0-9]{64}$' AS text))
  , CONSTRAINT official_usage_bundle_receipts_expected_active_revision_check CHECK (expected_active_revision > 0)
  , CONSTRAINT official_usage_bundle_receipts_result_active_revision_check CHECK (result_active_revision > 0)
  , CONSTRAINT official_usage_bundle_receipts_tenant_id_check CHECK (length(tenant_id) >= 1
                                                                 AND length(tenant_id) <= 128)
  , CONSTRAINT official_usage_bundle_receipts_pkey PRIMARY KEY (tenant_id, bundle_id)
);

CREATE TABLE purview_audit_qualifications (
    id uuid NOT NULL
  , tenant_id text NOT NULL
  , authorization_principal_id text NOT NULL
  , result_scope_id text NOT NULL
  , token_mode text NOT NULL
  , capability_id text NOT NULL
  , filters jsonb NOT NULL
  , request_hash text NOT NULL
  , contract_revision text NOT NULL
  , permission_revision text NOT NULL
  , configuration_revision bigint NOT NULL
  , status text DEFAULT CAST('approved' AS text) NOT NULL
  , approved_by text NOT NULL
  , approved_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
  , attempted_at timestamp with time zone
  , finished_at timestamp with time zone
  , expires_at timestamp with time zone DEFAULT clock_timestamp() + CAST('1 day' AS interval) NOT NULL
  , job_id uuid
  , error_code text
  , created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
  , updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
  , result_scope_kind text NOT NULL
  , result_scope_configuration_revision bigint
  , result_scope_configuration_key bigint GENERATED ALWAYS AS (COALESCE(result_scope_configuration_revision
                                                                      , CAST(0 AS bigint))) STORED
  , CONSTRAINT purview_audit_qualification_result_scope CHECK ((result_scope_kind = CAST('principal' AS text)
                                                            AND result_scope_configuration_revision IS NULL)
                                                            OR (result_scope_kind = CAST('application' AS text)
                                                            AND result_scope_configuration_revision > 0))
  , CONSTRAINT purview_audit_qualifications_approved_by_check CHECK (length(approved_by) >= 1
                                                                 AND length(approved_by) <= 256)
  , CONSTRAINT purview_audit_qualifications_authorization_principal_id_check CHECK (length(authorization_principal_id) >= 1
                                                                                AND length(authorization_principal_id) <= 256)
  , CONSTRAINT purview_audit_qualifications_capability_id_check CHECK (capability_id = ANY(ARRAY[CAST('purview.audit.search.delegated' AS text)
                                                                                               , CAST('purview.audit.search.application' AS text)]))
  , CONSTRAINT purview_audit_qualifications_check CHECK ((token_mode = CAST('delegated' AS text)
                                                      AND capability_id = CAST('purview.audit.search.delegated' AS text))
                                                      OR (token_mode = CAST('application' AS text)
                                                      AND capability_id = CAST('purview.audit.search.application' AS text)))
  , CONSTRAINT purview_audit_qualifications_configuration_revision_check CHECK (configuration_revision > 0)
  , CONSTRAINT purview_audit_qualifications_contract_revision_check CHECK (length(contract_revision) >= 1
                                                                       AND length(contract_revision) <= 128)
  , CONSTRAINT purview_audit_qualifications_error_code_check CHECK (length(error_code) <= 128)
  , CONSTRAINT purview_audit_qualifications_filters_check CHECK (jsonb_typeof(filters) = CAST('object' AS text)
                                                             AND octet_length(CAST(filters AS text)) <= 16384)
  , CONSTRAINT purview_audit_qualifications_permission_revision_check CHECK (length(permission_revision) >= 1
                                                                         AND length(permission_revision) <= 128)
  , CONSTRAINT purview_audit_qualifications_request_hash_check CHECK (request_hash ~ CAST('^[a-f0-9]{64}$' AS text))
  , CONSTRAINT purview_audit_qualifications_result_principal_id_check CHECK (length(result_scope_id) >= 1
                                                                         AND length(result_scope_id) <= 256)
  , CONSTRAINT purview_audit_qualifications_result_scope_kind_check CHECK (result_scope_kind = ANY(ARRAY[CAST('principal' AS text)
                                                                                                       , CAST('application' AS text)]))
  , CONSTRAINT purview_audit_qualifications_status_check CHECK (status = ANY(ARRAY[CAST('approved' AS text)
                                                                                 , CAST('running' AS text)
                                                                                 , CAST('qualified' AS text)
                                                                                 , CAST('failed' AS text)
                                                                                 , CAST('inconclusive' AS text)
                                                                                 , CAST('expired' AS text)]))
  , CONSTRAINT purview_audit_qualifications_tenant_id_check CHECK (length(tenant_id) >= 1
                                                               AND length(tenant_id) <= 128)
  , CONSTRAINT purview_audit_qualifications_token_mode_check CHECK (token_mode = ANY(ARRAY[CAST('delegated' AS text)
                                                                                         , CAST('application' AS text)]))
  , CONSTRAINT purview_audit_qualification_scope_identity_v17 UNIQUE (id, tenant_id, result_scope_kind, result_scope_id, result_scope_configuration_key)
  , CONSTRAINT purview_audit_qualifications_pkey PRIMARY KEY (id)
  , CONSTRAINT purview_audit_qualifications_tenant_id_id_key UNIQUE (tenant_id, id)
);

CREATE TABLE purview_audit_jobs (
    id uuid NOT NULL
  , tenant_id text NOT NULL
  , authorization_principal_id text NOT NULL
  , result_scope_id text NOT NULL
  , token_mode text NOT NULL
  , idempotency_key text NOT NULL
  , request_hash text NOT NULL
  , display_name text NOT NULL
  , filters jsonb NOT NULL
  , status text DEFAULT CAST('waiting_authorization' AS text) NOT NULL
  , provider_query_id text
  , provider_status text
  , local_request_id uuid NOT NULL
  , page_count integer DEFAULT 0 NOT NULL
  , provider_row_count integer DEFAULT 0 NOT NULL
  , stored_row_count integer DEFAULT 0 NOT NULL
  , byte_count integer DEFAULT 0 NOT NULL
  , unknown_field_count integer DEFAULT 0 NOT NULL
  , page_complete boolean DEFAULT FALSE NOT NULL
  , observed_start timestamp with time zone
  , observed_end timestamp with time zone
  , unobserved_start timestamp with time zone
  , unobserved_end timestamp with time zone
  , error_code text
  , message text
  , qualification_id uuid
  , cancel_requested boolean DEFAULT FALSE NOT NULL
  , remote_work_may_continue boolean DEFAULT FALSE NOT NULL
  , created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
  , attempted_at timestamp with time zone
  , updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
  , finished_at timestamp with time zone
  , deadline_at timestamp with time zone DEFAULT clock_timestamp() + CAST('48:00:00' AS interval) NOT NULL
  , expires_at timestamp with time zone DEFAULT clock_timestamp() + CAST('30 days' AS interval) NOT NULL
  , result_scope_kind text NOT NULL
  , result_scope_configuration_revision bigint
  , result_scope_configuration_key bigint GENERATED ALWAYS AS (COALESCE(result_scope_configuration_revision
                                                                      , CAST(0 AS bigint))) STORED
  , provider_request_id text
  , projection_version integer DEFAULT 1 NOT NULL
  , provider_request_count integer DEFAULT 0 NOT NULL
  , activation_count integer DEFAULT 0 NOT NULL
  , execution_version bigint DEFAULT 0 NOT NULL
  , execution_owner uuid
  , CONSTRAINT purview_audit_job_result_scope CHECK ((result_scope_kind = CAST('principal' AS text)
                                                  AND result_scope_configuration_revision IS NULL)
                                                  OR (result_scope_kind = CAST('application' AS text)
                                                  AND result_scope_configuration_revision > 0))
  , CONSTRAINT purview_audit_jobs_activation_count_check CHECK (activation_count >= 0
                                                            AND activation_count <= 12)
  , CONSTRAINT purview_audit_jobs_authorization_principal_id_check CHECK (length(authorization_principal_id) >= 1
                                                                      AND length(authorization_principal_id) <= 256)
  , CONSTRAINT purview_audit_jobs_byte_count_check CHECK (byte_count >= 0
                                                      AND byte_count <= 10000000)
  , CONSTRAINT purview_audit_jobs_check CHECK ((observed_start IS NULL) = (observed_end IS NULL))
  , CONSTRAINT purview_audit_jobs_check1 CHECK ((unobserved_start IS NULL) = (unobserved_end IS NULL))
  , CONSTRAINT purview_audit_jobs_display_name_check CHECK (display_name ~ CAST('^agent-control-audit:[a-f0-9-]{36}$' AS text))
  , CONSTRAINT purview_audit_jobs_error_code_check CHECK (length(error_code) <= 128)
  , CONSTRAINT purview_audit_jobs_execution_version_check CHECK (execution_version >= 0)
  , CONSTRAINT purview_audit_jobs_filters_check CHECK (jsonb_typeof(filters) = CAST('object' AS text)
                                                   AND octet_length(CAST(filters AS text)) <= 16384)
  , CONSTRAINT purview_audit_jobs_idempotency_key_check CHECK (length(idempotency_key) >= 1
                                                           AND length(idempotency_key) <= 128)
  , CONSTRAINT purview_audit_jobs_message_check CHECK (length(message) <= 1024)
  , CONSTRAINT purview_audit_jobs_page_count_check CHECK (page_count >= 0 AND page_count <= 20)
  , CONSTRAINT purview_audit_jobs_projection_version_check CHECK (projection_version = 1)
  , CONSTRAINT purview_audit_jobs_provider_query_id_check CHECK (length(provider_query_id) >= 1
                                                             AND length(provider_query_id) <= 512)
  , CONSTRAINT purview_audit_jobs_provider_request_count_check CHECK (provider_request_count >= 0
                                                                  AND provider_request_count <= 64)
  , CONSTRAINT purview_audit_jobs_provider_request_id_check CHECK (length(provider_request_id) >= 1
                                                               AND length(provider_request_id) <= 256)
  , CONSTRAINT purview_audit_jobs_provider_row_count_check CHECK (provider_row_count >= 0
                                                              AND provider_row_count <= 5001)
  , CONSTRAINT purview_audit_jobs_provider_status_check CHECK (provider_status = ANY(ARRAY[CAST('notStarted' AS text)
                                                                                         , CAST('running' AS text)
                                                                                         , CAST('succeeded' AS text)
                                                                                         , CAST('failed' AS text)
                                                                                         , CAST('cancelled' AS text)
                                                                                         , CAST('unknownFutureValue' AS text)]))
  , CONSTRAINT purview_audit_jobs_request_hash_check CHECK (request_hash ~ CAST('^[a-f0-9]{64}$' AS text))
  , CONSTRAINT purview_audit_jobs_result_principal_id_check CHECK (length(result_scope_id) >= 1
                                                               AND length(result_scope_id) <= 256)
  , CONSTRAINT purview_audit_jobs_result_scope_kind_check CHECK (result_scope_kind = ANY(ARRAY[CAST('principal' AS text)
                                                                                             , CAST('application' AS text)]))
  , CONSTRAINT purview_audit_jobs_status_check CHECK (status = ANY(ARRAY[CAST('waiting_authorization' AS text)
                                                                       , CAST('reconciling_create' AS text)
                                                                       , CAST('running' AS text)
                                                                       , CAST('succeeded' AS text)
                                                                       , CAST('failed' AS text)
                                                                       , CAST('cancelled' AS text)
                                                                       , CAST('partial' AS text)
                                                                       , CAST('inconclusive' AS text)]))
  , CONSTRAINT purview_audit_jobs_stored_row_count_check CHECK (stored_row_count >= 0
                                                            AND stored_row_count <= 5000)
  , CONSTRAINT purview_audit_jobs_tenant_id_check CHECK (length(tenant_id) >= 1
                                                     AND length(tenant_id) <= 128)
  , CONSTRAINT purview_audit_jobs_token_mode_check CHECK (token_mode = ANY(ARRAY[CAST('delegated' AS text)
                                                                               , CAST('application' AS text)]))
  , CONSTRAINT purview_audit_jobs_unknown_field_count_check CHECK (unknown_field_count >= 0
                                                               AND unknown_field_count <= 1000000)
  , CONSTRAINT purview_audit_job_scope_identity_v17 UNIQUE (id, tenant_id, result_scope_kind, result_scope_id, result_scope_configuration_key)
  , CONSTRAINT purview_audit_jobs_id_tenant_id_result_principal_id_key UNIQUE (id, tenant_id, result_scope_id)
  , CONSTRAINT purview_audit_jobs_pkey PRIMARY KEY (id)
  , CONSTRAINT purview_audit_jobs_result_scope_idempotency_v17 UNIQUE NULLS NOT DISTINCT (tenant_id, result_scope_kind, result_scope_id, result_scope_configuration_revision, token_mode, idempotency_key)
  , CONSTRAINT purview_audit_jobs_tenant_id_display_name_key UNIQUE (tenant_id, display_name)
);

CREATE TABLE purview_audit_records (
    job_id uuid NOT NULL
  , tenant_id text NOT NULL
  , result_scope_id text NOT NULL
  , wrapper_id text NOT NULL
  , native_event_id uuid
  , event_time timestamp with time zone NOT NULL
  , audit_log_record_type text NOT NULL
  , operation text NOT NULL
  , service text NOT NULL
  , result_status text
  , actor_user_id text
  , actor_user_principal_name text
  , actor_user_type text
  , object_id text
  , client_ip text
  , administrative_units jsonb NOT NULL
  , correlation_id text
  , agent_id text
  , app_identity text
  , app_host text
  , bot_id text
  , environment_id text
  , bot_component_id text
  , ai_plugin_operation_id text
  , messages jsonb NOT NULL
  , content_available boolean DEFAULT FALSE NOT NULL
  , unknown_field_count integer NOT NULL
  , association jsonb
  , observed_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
  , result_scope_kind text NOT NULL
  , result_scope_configuration_revision bigint
  , result_scope_configuration_key bigint GENERATED ALWAYS AS (COALESCE(result_scope_configuration_revision
                                                                      , CAST(0 AS bigint))) STORED
  , projection_version integer DEFAULT 1 NOT NULL
  , CONSTRAINT purview_audit_record_result_scope CHECK ((result_scope_kind = CAST('principal' AS text)
                                                     AND result_scope_configuration_revision IS NULL)
                                                     OR (result_scope_kind = CAST('application' AS text)
                                                     AND result_scope_configuration_revision > 0))
  , CONSTRAINT purview_audit_records_actor_user_id_check CHECK (length(actor_user_id) <= 512)
  , CONSTRAINT purview_audit_records_actor_user_principal_name_check CHECK (length(actor_user_principal_name) <= 512)
  , CONSTRAINT purview_audit_records_actor_user_type_check CHECK (length(actor_user_type) <= 128)
  , CONSTRAINT purview_audit_records_administrative_units_check CHECK (jsonb_typeof(administrative_units) = CAST('array' AS text)
                                                                   AND jsonb_array_length(administrative_units) <= 20
                                                                   AND octet_length(CAST(administrative_units AS text)) <= 4096)
  , CONSTRAINT purview_audit_records_agent_id_check CHECK (length(agent_id) <= 512)
  , CONSTRAINT purview_audit_records_ai_plugin_operation_id_check CHECK (length(ai_plugin_operation_id) <= 512)
  , CONSTRAINT purview_audit_records_app_host_check CHECK (length(app_host) <= 256)
  , CONSTRAINT purview_audit_records_app_identity_check CHECK (length(app_identity) <= 512)
  , CONSTRAINT purview_audit_records_association_check CHECK (association IS NULL
                                                           OR (jsonb_typeof(association) = CAST('object' AS text)
                                                           AND octet_length(CAST(association AS text)) <= 4096))
  , CONSTRAINT purview_audit_records_audit_log_record_type_check CHECK (length(audit_log_record_type) >= 1
                                                                    AND length(audit_log_record_type) <= 128)
  , CONSTRAINT purview_audit_records_bot_component_id_check CHECK (length(bot_component_id) <= 512)
  , CONSTRAINT purview_audit_records_bot_id_check CHECK (length(bot_id) <= 512)
  , CONSTRAINT purview_audit_records_client_ip_check CHECK (length(client_ip) <= 128)
  , CONSTRAINT purview_audit_records_content_available_check CHECK (NOT content_available)
  , CONSTRAINT purview_audit_records_correlation_id_check CHECK (length(correlation_id) <= 256)
  , CONSTRAINT purview_audit_records_environment_id_check CHECK (length(environment_id) <= 512)
  , CONSTRAINT purview_audit_records_messages_check CHECK (jsonb_typeof(messages) = CAST('array' AS text)
                                                       AND jsonb_array_length(messages) <= 100
                                                       AND octet_length(CAST(messages AS text)) <= 65536)
  , CONSTRAINT purview_audit_records_object_id_check CHECK (length(object_id) <= 1024)
  , CONSTRAINT purview_audit_records_operation_check CHECK (length(operation) >= 1
                                                        AND length(operation) <= 256)
  , CONSTRAINT purview_audit_records_projection_version_check CHECK (projection_version = 1)
  , CONSTRAINT purview_audit_records_result_scope_kind_check CHECK (result_scope_kind = ANY(ARRAY[CAST('principal' AS text)
                                                                                                , CAST('application' AS text)]))
  , CONSTRAINT purview_audit_records_result_status_check CHECK (length(result_status) <= 128)
  , CONSTRAINT purview_audit_records_service_check CHECK (length(service) >= 1
                                                      AND length(service) <= 128)
  , CONSTRAINT purview_audit_records_unknown_field_count_check CHECK (unknown_field_count >= 0
                                                                  AND unknown_field_count <= 100000)
  , CONSTRAINT purview_audit_records_wrapper_id_check CHECK (length(wrapper_id) >= 1
                                                         AND length(wrapper_id) <= 512)
  , CONSTRAINT purview_audit_records_pkey PRIMARY KEY (job_id, wrapper_id)
);

CREATE TABLE defender_hunting_jobs (
    id uuid NOT NULL
  , tenant_id text NOT NULL
  , authorization_principal_id text NOT NULL
  , result_scope_id text NOT NULL
  , result_scope_kind text NOT NULL
  , result_scope_configuration_revision bigint
  , result_scope_configuration_key bigint GENERATED ALWAYS AS (COALESCE(result_scope_configuration_revision
                                                                      , CAST(0 AS bigint))) STORED
  , token_mode text NOT NULL
  , template_id text NOT NULL
  , query_version integer DEFAULT 3 NOT NULL
  , idempotency_key text NOT NULL
  , request_hash text NOT NULL
  , filters jsonb NOT NULL
  , status text DEFAULT CAST('waiting_authorization' AS text) NOT NULL
  , local_request_id uuid NOT NULL
  , provider_request_id text
  , provider_request_count integer DEFAULT 0 NOT NULL
  , activation_count integer DEFAULT 0 NOT NULL
  , execution_version bigint DEFAULT 0 NOT NULL
  , execution_owner uuid
  , provider_row_count integer DEFAULT 0 NOT NULL
  , stored_row_count integer DEFAULT 0 NOT NULL
  , byte_count integer DEFAULT 0 NOT NULL
  , result_complete boolean DEFAULT FALSE NOT NULL
  , no_data boolean DEFAULT FALSE NOT NULL
  , partial_reason text
  , observed_start timestamp with time zone
  , observed_end timestamp with time zone
  , unobserved_start timestamp with time zone
  , unobserved_end timestamp with time zone
  , is_qualification boolean DEFAULT FALSE NOT NULL
  , capability_id text
  , contract_revision text
  , permission_revision text
  , qualification_configuration_revision bigint
  , approved_by text
  , error_code text
  , message text
  , cancel_requested boolean DEFAULT FALSE NOT NULL
  , created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
  , attempted_at timestamp with time zone
  , updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
  , finished_at timestamp with time zone
  , deadline_at timestamp with time zone DEFAULT clock_timestamp() + CAST('00:15:00' AS interval) NOT NULL
  , expires_at timestamp with time zone DEFAULT clock_timestamp() + CAST('30 days' AS interval) NOT NULL
  , target_scope_hash text
  , retained_scope_id uuid
  , CONSTRAINT defender_hunting_jobs_activation_count_check CHECK (activation_count >= 0
                                                               AND activation_count <= 4)
  , CONSTRAINT defender_hunting_jobs_approved_by_check CHECK (length(approved_by) >= 1
                                                          AND length(approved_by) <= 256)
  , CONSTRAINT defender_hunting_jobs_authorization_principal_id_check CHECK (length(authorization_principal_id) >= 1
                                                                         AND length(authorization_principal_id) <= 256)
  , CONSTRAINT defender_hunting_jobs_byte_count_check CHECK (byte_count >= 0
                                                         AND byte_count <= 2000000)
  , CONSTRAINT defender_hunting_jobs_capability_id_check CHECK (capability_id = ANY(ARRAY[CAST('defender.hunting.delegated' AS text)
                                                                                        , CAST('defender.hunting.application' AS text)]))
  , CONSTRAINT defender_hunting_jobs_check CHECK ((result_scope_kind = CAST('principal' AS text)
                                               AND result_scope_configuration_revision IS NULL
                                               AND token_mode = CAST('delegated' AS text))
                                               OR (result_scope_kind = CAST('application' AS text)
                                               AND result_scope_configuration_revision > 0
                                               AND token_mode = CAST('application' AS text)))
  , CONSTRAINT defender_hunting_jobs_check1 CHECK ((observed_start IS NULL) = (observed_end IS NULL))
  , CONSTRAINT defender_hunting_jobs_check2 CHECK ((unobserved_start IS NULL) = (unobserved_end IS NULL))
  , CONSTRAINT defender_hunting_jobs_check3 CHECK ((is_qualification
                                                AND capability_id IS NOT NULL
                                                AND contract_revision IS NOT NULL
                                                AND permission_revision IS NOT NULL
                                                AND qualification_configuration_revision IS NOT NULL
                                                AND approved_by IS NOT NULL)
                                                OR (NOT is_qualification
                                                AND capability_id IS NULL
                                                AND contract_revision IS NULL
                                                AND permission_revision IS NULL
                                                AND qualification_configuration_revision IS NULL
                                                AND approved_by IS NULL))
  , CONSTRAINT defender_hunting_jobs_check4 CHECK (capability_id IS NULL
                                                OR (token_mode = CAST('delegated' AS text)
                                                AND capability_id = CAST('defender.hunting.delegated' AS text))
                                                OR (token_mode = CAST('application' AS text)
                                                AND capability_id = CAST('defender.hunting.application' AS text)))
  , CONSTRAINT defender_hunting_jobs_check5 CHECK ((status = ANY(ARRAY[CAST('succeeded' AS text)
                                                                     , CAST('partial' AS text)])
                                                AND result_complete = (status = CAST('succeeded' AS text))
                                                AND no_data = (stored_row_count = 0
                                                           AND status = CAST('succeeded' AS text)))
                                                OR status <> ALL(ARRAY[CAST('succeeded' AS text)
                                                                     , CAST('partial' AS text)]))
  , CONSTRAINT defender_hunting_jobs_contract_revision_check CHECK (contract_revision ~ CAST('^[a-f0-9]{64}$' AS text))
  , CONSTRAINT defender_hunting_jobs_error_code_check CHECK (length(error_code) <= 128)
  , CONSTRAINT defender_hunting_jobs_execution_version_check CHECK (execution_version >= 0)
  , CONSTRAINT defender_hunting_jobs_filters_check CHECK (jsonb_typeof(filters) = CAST('object' AS text)
                                                      AND octet_length(CAST(filters AS text)) <= 16384)
  , CONSTRAINT defender_hunting_jobs_idempotency_key_check CHECK (idempotency_key ~ CAST('^[a-zA-Z0-9_-]{1,128}$' AS text))
  , CONSTRAINT defender_hunting_jobs_message_check CHECK (length(message) <= 1024)
  , CONSTRAINT defender_hunting_jobs_partial_reason_check CHECK (partial_reason = CAST('hunting_row_limit' AS text))
  , CONSTRAINT defender_hunting_jobs_permission_revision_check CHECK (permission_revision ~ CAST('^[a-f0-9]{64}$' AS text))
  , CONSTRAINT defender_hunting_jobs_provider_request_count_check CHECK (provider_request_count >= 0
                                                                     AND provider_request_count <= 12)
  , CONSTRAINT defender_hunting_jobs_provider_request_id_check CHECK (length(provider_request_id) >= 1
                                                                  AND length(provider_request_id) <= 256)
  , CONSTRAINT defender_hunting_jobs_provider_row_count_check CHECK (provider_row_count >= 0
                                                                 AND provider_row_count <= 201)
  , CONSTRAINT defender_hunting_jobs_qualification_configuration_revisio_check CHECK (qualification_configuration_revision > 0)
  , CONSTRAINT defender_hunting_jobs_query_version_check CHECK (query_version = 3)
  , CONSTRAINT defender_hunting_jobs_request_hash_check CHECK (request_hash ~ CAST('^[a-f0-9]{64}$' AS text))
  , CONSTRAINT defender_hunting_jobs_result_scope_id_check CHECK (length(result_scope_id) >= 1
                                                              AND length(result_scope_id) <= 256)
  , CONSTRAINT defender_hunting_jobs_result_scope_kind_check CHECK (result_scope_kind = ANY(ARRAY[CAST('principal' AS text)
                                                                                                , CAST('application' AS text)]))
  , CONSTRAINT defender_hunting_jobs_status_check CHECK (status = ANY(ARRAY[CAST('waiting_authorization' AS text)
                                                                          , CAST('running' AS text)
                                                                          , CAST('succeeded' AS text)
                                                                          , CAST('partial' AS text)
                                                                          , CAST('failed' AS text)
                                                                          , CAST('cancelled' AS text)
                                                                          , CAST('inconclusive' AS text)]))
  , CONSTRAINT defender_hunting_jobs_stored_row_count_check CHECK (stored_row_count >= 0
                                                               AND stored_row_count <= 200)
  , CONSTRAINT defender_hunting_jobs_target_scope_hash_check CHECK (target_scope_hash ~ CAST('^[a-f0-9]{64}$' AS text))
  , CONSTRAINT defender_hunting_jobs_template_id_check CHECK (template_id = ANY(ARRAY[CAST('agents_inventory' AS text)
                                                                                    , CAST('agent_activity' AS text)
                                                                                    , CAST('agent_tools' AS text)]))
  , CONSTRAINT defender_hunting_jobs_tenant_id_check CHECK (length(tenant_id) >= 1
                                                        AND length(tenant_id) <= 128)
  , CONSTRAINT defender_hunting_jobs_token_mode_check CHECK (token_mode = ANY(ARRAY[CAST('delegated' AS text)
                                                                                  , CAST('application' AS text)]))
  , CONSTRAINT defender_hunting_jobs_id_tenant_id_result_scope_kind_result_key UNIQUE (id, tenant_id, result_scope_kind, result_scope_id, result_scope_configuration_key)
  , CONSTRAINT defender_hunting_jobs_pkey PRIMARY KEY (id)
  , CONSTRAINT defender_hunting_jobs_tenant_id_result_scope_kind_result_sc_key UNIQUE NULLS NOT DISTINCT (tenant_id, result_scope_kind, result_scope_id, result_scope_configuration_revision, token_mode, idempotency_key)
);

CREATE TABLE defender_hunting_snapshots (
    id uuid NOT NULL
  , job_id uuid NOT NULL
  , tenant_id text NOT NULL
  , result_scope_id text NOT NULL
  , result_scope_kind text NOT NULL
  , result_scope_configuration_revision bigint
  , result_scope_configuration_key bigint GENERATED ALWAYS AS (COALESCE(result_scope_configuration_revision
                                                                      , CAST(0 AS bigint))) STORED
  , template_id text NOT NULL
  , source_table text NOT NULL
  , query_version integer DEFAULT 3 NOT NULL
  , filters jsonb NOT NULL
  , requested_start timestamp with time zone NOT NULL
  , requested_end timestamp with time zone NOT NULL
  , observed_start timestamp with time zone
  , observed_end timestamp with time zone
  , unobserved_start timestamp with time zone
  , unobserved_end timestamp with time zone
  , observation_time timestamp with time zone DEFAULT clock_timestamp() NOT NULL
  , result_complete boolean NOT NULL
  , no_data boolean NOT NULL
  , partial_reason text
  , provider_row_count integer NOT NULL
  , stored_row_count integer NOT NULL
  , byte_count integer NOT NULL
  , expires_at timestamp with time zone DEFAULT clock_timestamp() + CAST('30 days' AS interval) NOT NULL
  , CONSTRAINT defender_hunting_snapshots_byte_count_check CHECK (byte_count >= 0
                                                              AND byte_count <= 2000000)
  , CONSTRAINT defender_hunting_snapshots_check CHECK (requested_end > requested_start)
  , CONSTRAINT defender_hunting_snapshots_check1 CHECK ((observed_start IS NULL) = (observed_end IS NULL))
  , CONSTRAINT defender_hunting_snapshots_check2 CHECK ((unobserved_start IS NULL) = (unobserved_end IS NULL))
  , CONSTRAINT defender_hunting_snapshots_check3 CHECK (no_data = (result_complete
                                                               AND stored_row_count = 0))
  , CONSTRAINT defender_hunting_snapshots_check4 CHECK ((result_complete
                                                     AND partial_reason IS NULL
                                                     AND unobserved_start IS NULL)
                                                     OR (NOT result_complete
                                                     AND partial_reason IS NOT NULL
                                                     AND unobserved_start IS NOT NULL))
  , CONSTRAINT defender_hunting_snapshots_filters_check CHECK (jsonb_typeof(filters) = CAST('object' AS text)
                                                           AND octet_length(CAST(filters AS text)) <= 16384)
  , CONSTRAINT defender_hunting_snapshots_partial_reason_check CHECK (partial_reason = CAST('hunting_row_limit' AS text))
  , CONSTRAINT defender_hunting_snapshots_provider_row_count_check CHECK (provider_row_count >= 0
                                                                      AND provider_row_count <= 201)
  , CONSTRAINT defender_hunting_snapshots_query_version_check CHECK (query_version = 3)
  , CONSTRAINT defender_hunting_snapshots_result_scope_kind_check CHECK (result_scope_kind = ANY(ARRAY[CAST('principal' AS text)
                                                                                                     , CAST('application' AS text)]))
  , CONSTRAINT defender_hunting_snapshots_source_table_check CHECK (source_table = ANY(ARRAY[CAST('AgentsInfo' AS text)
                                                                                           , CAST('CloudAppEvents' AS text)]))
  , CONSTRAINT defender_hunting_snapshots_stored_row_count_check CHECK (stored_row_count >= 0
                                                                    AND stored_row_count <= 200)
  , CONSTRAINT defender_hunting_snapshots_template_id_check CHECK (template_id = ANY(ARRAY[CAST('agents_inventory' AS text)
                                                                                         , CAST('agent_activity' AS text)
                                                                                         , CAST('agent_tools' AS text)]))
  , CONSTRAINT defender_hunting_snapshots_id_tenant_id_result_scope_kind_r_key UNIQUE (id, tenant_id, result_scope_kind, result_scope_id, result_scope_configuration_key)
  , CONSTRAINT defender_hunting_snapshots_job_id_key UNIQUE (job_id)
  , CONSTRAINT defender_hunting_snapshots_pkey PRIMARY KEY (id)
);

CREATE TABLE defender_hunting_rows (
    snapshot_id uuid NOT NULL
  , row_ordinal integer NOT NULL
  , tenant_id text NOT NULL
  , result_scope_id text NOT NULL
  , result_scope_kind text NOT NULL
  , result_scope_configuration_revision bigint
  , result_scope_configuration_key bigint GENERATED ALWAYS AS (COALESCE(result_scope_configuration_revision
                                                                      , CAST(0 AS bigint))) STORED
  , source_table text NOT NULL
  , projection_version integer DEFAULT 3 NOT NULL
  , row_data jsonb NOT NULL
  , observed_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
  , CONSTRAINT defender_hunting_rows_projection_version_check CHECK (projection_version = 3)
  , CONSTRAINT defender_hunting_rows_result_scope_kind_check CHECK (result_scope_kind = ANY(ARRAY[CAST('principal' AS text)
                                                                                                , CAST('application' AS text)]))
  , CONSTRAINT defender_hunting_rows_row_data_check CHECK (jsonb_typeof(row_data) = CAST('object' AS text)
                                                       AND octet_length(CAST(row_data AS text)) <= 16384)
  , CONSTRAINT defender_hunting_rows_row_data_check1 CHECK (NOT row_data ?| ARRAY[CAST('RawEventData' AS text)
                                                                                , CAST('rawEventData' AS text)
                                                                                , CAST('Instructions' AS text)
                                                                                , CAST('instructions' AS text)
                                                                                , CAST('Memory' AS text)
                                                                                , CAST('memory' AS text)
                                                                                , CAST('InputMessages' AS text)
                                                                                , CAST('inputMessages' AS text)
                                                                                , CAST('OutputMessages' AS text)
                                                                                , CAST('outputMessages' AS text)
                                                                                , CAST('ToolArguments' AS text)
                                                                                , CAST('toolArguments' AS text)
                                                                                , CAST('ToolResult' AS text)
                                                                                , CAST('toolResult' AS text)])
  , CONSTRAINT defender_hunting_rows_row_data_check2 CHECK (row_data ->> CAST('contentAvailable' AS text) IS NULL
                                                         OR (row_data ->> CAST('contentAvailable' AS text)) = CAST('false' AS text))
  , CONSTRAINT defender_hunting_rows_row_ordinal_check CHECK (row_ordinal >= 0
                                                          AND row_ordinal <= 199)
  , CONSTRAINT defender_hunting_rows_source_table_check CHECK (source_table = ANY(ARRAY[CAST('AgentsInfo' AS text)
                                                                                      , CAST('CloudAppEvents' AS text)]))
  , CONSTRAINT defender_hunting_rows_pkey PRIMARY KEY (snapshot_id, row_ordinal)
);

CREATE TABLE defender_hunting_qualification_evidence (
    id uuid NOT NULL
  , tenant_id text NOT NULL
  , authorization_principal_id text NOT NULL
  , result_scope_id text NOT NULL
  , result_scope_kind text NOT NULL
  , result_scope_configuration_revision bigint
  , token_mode text NOT NULL
  , capability_id text NOT NULL
  , template_id text NOT NULL
  , target_scope_hash text NOT NULL
  , approved_scope jsonb NOT NULL
  , contract_revision text NOT NULL
  , permission_revision text NOT NULL
  , configuration_revision bigint NOT NULL
  , approved_by text NOT NULL
  , qualified_job_id uuid NOT NULL
  , provider_request_id text
  , qualified_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
  , expires_at timestamp with time zone DEFAULT clock_timestamp() + CAST('24:00:00' AS interval) NOT NULL
  , CONSTRAINT defender_hunting_qualification_authorization_principal_id_check CHECK (length(authorization_principal_id) >= 1
                                                                                  AND length(authorization_principal_id) <= 256)
  , CONSTRAINT defender_hunting_qualification_evi_configuration_revision_check CHECK (configuration_revision > 0)
  , CONSTRAINT defender_hunting_qualification_eviden_permission_revision_check CHECK (permission_revision ~ CAST('^[a-f0-9]{64}$' AS text))
  , CONSTRAINT defender_hunting_qualification_eviden_provider_request_id_check CHECK (length(provider_request_id) >= 1
                                                                                  AND length(provider_request_id) <= 256)
  , CONSTRAINT defender_hunting_qualification_evidence_approved_by_check CHECK (length(approved_by) >= 1
                                                                            AND length(approved_by) <= 256)
  , CONSTRAINT defender_hunting_qualification_evidence_approved_scope_check CHECK (jsonb_typeof(approved_scope) = CAST('object' AS text)
                                                                               AND octet_length(CAST(approved_scope AS text)) <= 8192)
  , CONSTRAINT defender_hunting_qualification_evidence_capability_id_check CHECK (capability_id = ANY(ARRAY[CAST('defender.hunting.delegated' AS text)
                                                                                                          , CAST('defender.hunting.application' AS text)]))
  , CONSTRAINT defender_hunting_qualification_evidence_check CHECK ((result_scope_kind = CAST('principal' AS text)
                                                                 AND result_scope_configuration_revision IS NULL
                                                                 AND token_mode = CAST('delegated' AS text)
                                                                 AND capability_id = CAST('defender.hunting.delegated' AS text)
                                                                 AND result_scope_id = authorization_principal_id)
                                                                 OR (result_scope_kind = CAST('application' AS text)
                                                                 AND result_scope_configuration_revision > 0
                                                                 AND token_mode = CAST('application' AS text)
                                                                 AND capability_id = CAST('defender.hunting.application' AS text)))
  , CONSTRAINT defender_hunting_qualification_evidence_contract_revision_check CHECK (contract_revision ~ CAST('^[a-f0-9]{64}$' AS text))
  , CONSTRAINT defender_hunting_qualification_evidence_result_scope_id_check CHECK (length(result_scope_id) >= 1
                                                                                AND length(result_scope_id) <= 256)
  , CONSTRAINT defender_hunting_qualification_evidence_result_scope_kind_check CHECK (result_scope_kind = ANY(ARRAY[CAST('principal' AS text)
                                                                                                                  , CAST('application' AS text)]))
  , CONSTRAINT defender_hunting_qualification_evidence_target_scope_hash_check CHECK (target_scope_hash ~ CAST('^[a-f0-9]{64}$' AS text))
  , CONSTRAINT defender_hunting_qualification_evidence_template_id_check CHECK (template_id = ANY(ARRAY[CAST('agents_inventory' AS text)
                                                                                                      , CAST('agent_activity' AS text)
                                                                                                      , CAST('agent_tools' AS text)]))
  , CONSTRAINT defender_hunting_qualification_evidence_tenant_id_check CHECK (length(tenant_id) >= 1
                                                                          AND length(tenant_id) <= 128)
  , CONSTRAINT defender_hunting_qualification_evidence_token_mode_check CHECK (token_mode = ANY(ARRAY[CAST('delegated' AS text)
                                                                                                    , CAST('application' AS text)]))
  , CONSTRAINT defender_hunting_qualification_evidence_pkey PRIMARY KEY (id)
  , CONSTRAINT defender_hunting_qualification_evidence_qualified_job_id_key UNIQUE (qualified_job_id)
);

CREATE TABLE defender_hunting_retained_scopes (
    id uuid NOT NULL
  , tenant_id text NOT NULL
  , authorization_principal_id text NOT NULL
  , result_scope_id text NOT NULL
  , result_scope_kind text NOT NULL
  , result_scope_configuration_revision bigint
  , result_scope_configuration_key bigint GENERATED ALWAYS AS (COALESCE(result_scope_configuration_revision
                                                                      , CAST(0 AS bigint))) STORED
  , token_mode text NOT NULL
  , capability_id text NOT NULL
  , template_id text NOT NULL
  , target_scope_hash text NOT NULL
  , approved_scope jsonb NOT NULL
  , query_version integer NOT NULL
  , contract_revision text NOT NULL
  , permission_revision text NOT NULL
  , configuration_revision bigint NOT NULL
  , approved_by text NOT NULL
  , source_qualification_job_id uuid NOT NULL
  , approved_at timestamp with time zone NOT NULL
  , qualified_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
  , expires_at timestamp with time zone NOT NULL
  , revoked_at timestamp with time zone
  , revoked_by text
  , CONSTRAINT defender_hunting_retained_scop_authorization_principal_id_check CHECK (length(authorization_principal_id) >= 1
                                                                                  AND length(authorization_principal_id) <= 256)
  , CONSTRAINT defender_hunting_retained_scopes_approved_by_check CHECK (length(approved_by) >= 1
                                                                     AND length(approved_by) <= 256)
  , CONSTRAINT defender_hunting_retained_scopes_approved_scope_check CHECK (jsonb_typeof(approved_scope) = CAST('object' AS text)
                                                                        AND octet_length(CAST(approved_scope AS text)) <= 8192)
  , CONSTRAINT defender_hunting_retained_scopes_capability_id_check CHECK (capability_id = ANY(ARRAY[CAST('defender.hunting.delegated' AS text)
                                                                                                   , CAST('defender.hunting.application' AS text)]))
  , CONSTRAINT defender_hunting_retained_scopes_check CHECK (qualified_at >= approved_at
                                                         AND expires_at = (approved_at + CAST('30 days' AS interval)))
  , CONSTRAINT defender_hunting_retained_scopes_check1 CHECK ((revoked_at IS NULL
                                                           AND revoked_by IS NULL)
                                                           OR (revoked_at IS NOT NULL
                                                           AND revoked_by IS NOT NULL))
  , CONSTRAINT defender_hunting_retained_scopes_check2 CHECK ((result_scope_kind = CAST('principal' AS text)
                                                           AND result_scope_configuration_revision IS NULL
                                                           AND token_mode = CAST('delegated' AS text)
                                                           AND capability_id = CAST('defender.hunting.delegated' AS text)
                                                           AND result_scope_id = authorization_principal_id)
                                                           OR (result_scope_kind = CAST('application' AS text)
                                                           AND result_scope_configuration_revision > 0
                                                           AND token_mode = CAST('application' AS text)
                                                           AND capability_id = CAST('defender.hunting.application' AS text)))
  , CONSTRAINT defender_hunting_retained_scopes_configuration_revision_check CHECK (configuration_revision > 0)
  , CONSTRAINT defender_hunting_retained_scopes_contract_revision_check CHECK (contract_revision ~ CAST('^[a-f0-9]{64}$' AS text))
  , CONSTRAINT defender_hunting_retained_scopes_permission_revision_check CHECK (permission_revision ~ CAST('^[a-f0-9]{64}$' AS text))
  , CONSTRAINT defender_hunting_retained_scopes_query_version_check CHECK (query_version = 3)
  , CONSTRAINT defender_hunting_retained_scopes_result_scope_id_check CHECK (length(result_scope_id) >= 1
                                                                         AND length(result_scope_id) <= 256)
  , CONSTRAINT defender_hunting_retained_scopes_result_scope_kind_check CHECK (result_scope_kind = ANY(ARRAY[CAST('principal' AS text)
                                                                                                           , CAST('application' AS text)]))
  , CONSTRAINT defender_hunting_retained_scopes_revoked_by_check CHECK (length(revoked_by) >= 1
                                                                    AND length(revoked_by) <= 256)
  , CONSTRAINT defender_hunting_retained_scopes_target_scope_hash_check CHECK (target_scope_hash ~ CAST('^[a-f0-9]{64}$' AS text))
  , CONSTRAINT defender_hunting_retained_scopes_template_id_check CHECK (template_id = ANY(ARRAY[CAST('agents_inventory' AS text)
                                                                                               , CAST('agent_activity' AS text)
                                                                                               , CAST('agent_tools' AS text)]))
  , CONSTRAINT defender_hunting_retained_scopes_tenant_id_check CHECK (length(tenant_id) >= 1
                                                                   AND length(tenant_id) <= 128)
  , CONSTRAINT defender_hunting_retained_scopes_token_mode_check CHECK (token_mode = ANY(ARRAY[CAST('delegated' AS text)
                                                                                             , CAST('application' AS text)]))
  , CONSTRAINT defender_hunting_retained_scopes_pkey PRIMARY KEY (id)
);

CREATE TABLE copilot_quarantine_status_observations (
    id uuid NOT NULL
  , tenant_id text NOT NULL
  , principal_id text NOT NULL
  , resource_native_id text NOT NULL
  , environment_id text NOT NULL
  , bot_id text NOT NULL
  , is_bot_quarantined boolean NOT NULL
  , provider_updated_at text NOT NULL
  , observed_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
  , correlation_id uuid NOT NULL
  , expires_at timestamp with time zone DEFAULT clock_timestamp() + CAST('30 days' AS interval) NOT NULL
  , verified_readback boolean DEFAULT FALSE NOT NULL
  , CONSTRAINT copilot_quarantine_status_observation_provider_updated_at_check CHECK (provider_updated_at ~ CAST('^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,7})?Z$' AS text))
  , CONSTRAINT copilot_quarantine_status_observations_bot_id_check CHECK (length(bot_id) >= 1
                                                                      AND length(bot_id) <= 512)
  , CONSTRAINT copilot_quarantine_status_observations_environment_id_check CHECK (length(environment_id) >= 1
                                                                              AND length(environment_id) <= 512)
  , CONSTRAINT copilot_quarantine_status_observations_principal_id_check CHECK (length(principal_id) >= 1
                                                                            AND length(principal_id) <= 256)
  , CONSTRAINT copilot_quarantine_status_observations_resource_native_id_check CHECK (length(resource_native_id) >= 1
                                                                                  AND length(resource_native_id) <= 512)
  , CONSTRAINT copilot_quarantine_status_observations_tenant_id_check CHECK (length(tenant_id) >= 1
                                                                         AND length(tenant_id) <= 128)
  , CONSTRAINT copilot_quarantine_status_observations_pkey PRIMARY KEY (id)
);

CREATE TABLE copilot_quarantine_jobs (
    id uuid NOT NULL
  , tenant_id text NOT NULL
  , principal_id text NOT NULL
  , idempotency_key text NOT NULL
  , request_hash text NOT NULL
  , action text NOT NULL
  , status text DEFAULT CAST('queued' AS text) NOT NULL
  , confirmation_hash text NOT NULL
  , confirmation_summary jsonb NOT NULL
  , actor_name text NOT NULL
  , actor_username text NOT NULL
  , request_path text NOT NULL
  , contract_revision text NOT NULL
  , permission_revision text NOT NULL
  , configuration_revision bigint NOT NULL
  , is_canary boolean DEFAULT FALSE NOT NULL
  , canary_approval_id uuid
  , cancel_requested boolean DEFAULT FALSE NOT NULL
  , lease_owner uuid
  , lease_version bigint DEFAULT 0 NOT NULL
  , lease_until timestamp with time zone
  , attempts integer DEFAULT 0 NOT NULL
  , created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
  , updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
  , deadline_at timestamp with time zone DEFAULT clock_timestamp() + CAST('00:30:00' AS interval) NOT NULL
  , expires_at timestamp with time zone DEFAULT clock_timestamp() + CAST('7 days' AS interval) NOT NULL
  , CONSTRAINT copilot_quarantine_jobs_action_check CHECK (action = ANY(ARRAY[CAST('quarantine' AS text)
                                                                            , CAST('unquarantine' AS text)]))
  , CONSTRAINT copilot_quarantine_jobs_actor_name_check CHECK (length(actor_name) >= 1
                                                           AND length(actor_name) <= 256)
  , CONSTRAINT copilot_quarantine_jobs_actor_username_check CHECK (length(actor_username) >= 1
                                                               AND length(actor_username) <= 256)
  , CONSTRAINT copilot_quarantine_jobs_attempts_check CHECK (attempts >= 0 AND attempts <= 10)
  , CONSTRAINT copilot_quarantine_jobs_check CHECK ((is_canary AND canary_approval_id IS NOT NULL)
                                                 OR (NOT is_canary AND canary_approval_id IS NULL))
  , CONSTRAINT copilot_quarantine_jobs_configuration_revision_check CHECK (configuration_revision > 0)
  , CONSTRAINT copilot_quarantine_jobs_confirmation_hash_check CHECK (confirmation_hash ~ CAST('^[a-f0-9]{64}$' AS text))
  , CONSTRAINT copilot_quarantine_jobs_confirmation_summary_check CHECK (jsonb_typeof(confirmation_summary) = CAST('object' AS text)
                                                                     AND octet_length(CAST(confirmation_summary AS text)) <= 65536)
  , CONSTRAINT copilot_quarantine_jobs_contract_revision_check CHECK (contract_revision ~ CAST('^[a-f0-9]{64}$' AS text))
  , CONSTRAINT copilot_quarantine_jobs_idempotency_key_check CHECK (idempotency_key ~ CAST('^[a-zA-Z0-9_-]{1,128}$' AS text))
  , CONSTRAINT copilot_quarantine_jobs_lease_version_check CHECK (lease_version >= 0)
  , CONSTRAINT copilot_quarantine_jobs_permission_revision_check CHECK (permission_revision ~ CAST('^[a-f0-9]{64}$' AS text))
  , CONSTRAINT copilot_quarantine_jobs_principal_id_check CHECK (length(principal_id) >= 1
                                                             AND length(principal_id) <= 256)
  , CONSTRAINT copilot_quarantine_jobs_request_hash_check CHECK (request_hash ~ CAST('^[a-f0-9]{64}$' AS text))
  , CONSTRAINT copilot_quarantine_jobs_request_path_check CHECK (length(request_path) >= 1
                                                             AND length(request_path) <= 1024)
  , CONSTRAINT copilot_quarantine_jobs_status_check CHECK (status = ANY(ARRAY[CAST('queued' AS text)
                                                                            , CAST('running' AS text)
                                                                            , CAST('waiting_authorization' AS text)
                                                                            , CAST('succeeded' AS text)
                                                                            , CAST('failed' AS text)
                                                                            , CAST('cancelled' AS text)
                                                                            , CAST('partial' AS text)
                                                                            , CAST('inconclusive' AS text)]))
  , CONSTRAINT copilot_quarantine_jobs_tenant_id_check CHECK (length(tenant_id) >= 1
                                                          AND length(tenant_id) <= 128)
  , CONSTRAINT copilot_quarantine_jobs_pkey PRIMARY KEY (id)
  , CONSTRAINT copilot_quarantine_jobs_tenant_id_principal_id_idempotency__key UNIQUE (tenant_id, principal_id, idempotency_key)
);

CREATE TABLE copilot_quarantine_job_items (
    id uuid NOT NULL
  , job_id uuid NOT NULL
  , ordinal integer NOT NULL
  , resource_native_id text NOT NULL
  , display_name text NOT NULL
  , snapshot_id uuid NOT NULL
  , inventory_observed_at timestamp with time zone NOT NULL
  , environment_id text NOT NULL
  , bot_id text NOT NULL
  , prestate boolean NOT NULL
  , prestate_provider_updated_at text NOT NULL
  , requested_state boolean NOT NULL
  , status text DEFAULT CAST('queued' AS text) NOT NULL
  , sent_at timestamp with time zone
  , correlation_id uuid
  , observed_state boolean
  , observed_provider_updated_at text
  , observed_at timestamp with time zone
  , readback_count integer DEFAULT 0 NOT NULL
  , reconciliation_status text DEFAULT CAST('not_required' AS text) NOT NULL
  , reconciled_at timestamp with time zone
  , error_code text
  , message text
  , updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
  , CONSTRAINT copilot_quarantine_job_items_bot_id_check CHECK (length(bot_id) >= 1
                                                            AND length(bot_id) <= 512)
  , CONSTRAINT copilot_quarantine_job_items_check CHECK ((observed_state IS NULL
                                                      AND observed_provider_updated_at IS NULL
                                                      AND observed_at IS NULL)
                                                      OR (observed_state IS NOT NULL
                                                      AND observed_provider_updated_at IS NOT NULL
                                                      AND observed_at IS NOT NULL))
  , CONSTRAINT copilot_quarantine_job_items_check1 CHECK ((reconciliation_status = ANY(ARRAY[CAST('not_required' AS text)
                                                                                           , CAST('required' AS text)])
                                                       AND reconciled_at IS NULL)
                                                       OR (reconciliation_status = ANY(ARRAY[CAST('verified_applied' AS text)
                                                                                           , CAST('verified_not_applied' AS text)
                                                                                           , CAST('conflict' AS text)])
                                                       AND reconciled_at IS NOT NULL))
  , CONSTRAINT copilot_quarantine_job_items_display_name_check CHECK (length(display_name) >= 1
                                                                  AND length(display_name) <= 512)
  , CONSTRAINT copilot_quarantine_job_items_environment_id_check CHECK (length(environment_id) >= 1
                                                                    AND length(environment_id) <= 512)
  , CONSTRAINT copilot_quarantine_job_items_error_code_check CHECK (length(error_code) <= 128)
  , CONSTRAINT copilot_quarantine_job_items_message_check CHECK (length(message) <= 1024)
  , CONSTRAINT copilot_quarantine_job_items_observed_provider_updated_at_check CHECK (observed_provider_updated_at IS NULL
                                                                                   OR observed_provider_updated_at ~ CAST('^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,7})?Z$' AS text))
  , CONSTRAINT copilot_quarantine_job_items_ordinal_check CHECK (ordinal >= 0 AND ordinal <= 24)
  , CONSTRAINT copilot_quarantine_job_items_prestate_provider_updated_at_check CHECK (prestate_provider_updated_at ~ CAST('^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,7})?Z$' AS text))
  , CONSTRAINT copilot_quarantine_job_items_readback_count_check CHECK (readback_count >= 0
                                                                    AND readback_count <= 20)
  , CONSTRAINT copilot_quarantine_job_items_reconciliation_status_check CHECK (reconciliation_status = ANY(ARRAY[CAST('not_required' AS text)
                                                                                                               , CAST('required' AS text)
                                                                                                               , CAST('verified_applied' AS text)
                                                                                                               , CAST('verified_not_applied' AS text)
                                                                                                               , CAST('conflict' AS text)]))
  , CONSTRAINT copilot_quarantine_job_items_resource_native_id_check CHECK (length(resource_native_id) >= 1
                                                                        AND length(resource_native_id) <= 512)
  , CONSTRAINT copilot_quarantine_job_items_status_check CHECK (status = ANY(ARRAY[CAST('queued' AS text)
                                                                                 , CAST('running' AS text)
                                                                                 , CAST('succeeded' AS text)
                                                                                 , CAST('failed' AS text)
                                                                                 , CAST('cancelled' AS text)
                                                                                 , CAST('inconclusive' AS text)
                                                                                 , CAST('skipped' AS text)]))
  , CONSTRAINT copilot_quarantine_job_items_job_id_environment_id_bot_id_key UNIQUE (job_id, environment_id, bot_id)
  , CONSTRAINT copilot_quarantine_job_items_job_id_ordinal_key UNIQUE (job_id, ordinal)
  , CONSTRAINT copilot_quarantine_job_items_pkey PRIMARY KEY (id)
);

CREATE TABLE copilot_quarantine_attempts (
    id uuid NOT NULL
  , job_id uuid NOT NULL
  , item_id uuid NOT NULL
  , lease_owner uuid NOT NULL
  , lease_version bigint NOT NULL
  , correlation_id uuid NOT NULL
  , started_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
  , sent_at timestamp with time zone
  , finished_at timestamp with time zone
  , outcome text
  , CONSTRAINT copilot_quarantine_attempts_outcome_check CHECK (outcome = ANY(ARRAY[CAST('succeeded' AS text)
                                                                                  , CAST('failed' AS text)
                                                                                  , CAST('cancelled' AS text)
                                                                                  , CAST('inconclusive' AS text)
                                                                                  , CAST('skipped' AS text)]))
  , CONSTRAINT copilot_quarantine_attempts_item_id_lease_version_key UNIQUE (item_id, lease_version)
  , CONSTRAINT copilot_quarantine_attempts_pkey PRIMARY KEY (id)
);

CREATE TABLE copilot_quarantine_audit (
    id uuid NOT NULL
  , tenant_id text NOT NULL
  , principal_id text NOT NULL
  , actor_username text NOT NULL
  , actor_name text NOT NULL
  , job_id uuid NOT NULL
  , item_id uuid
  , correlation_id uuid
  , action text NOT NULL
  , phase text NOT NULL
  , resource_native_id text NOT NULL
  , environment_id text NOT NULL
  , bot_id text NOT NULL
  , requested_state boolean NOT NULL
  , observed_state boolean
  , observed_provider_updated_at text
  , error_code text
  , message text
  , observed_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
  , expires_at timestamp with time zone DEFAULT clock_timestamp() + CAST('90 days' AS interval) NOT NULL
  , CONSTRAINT copilot_quarantine_audit_action_check CHECK (action = ANY(ARRAY[CAST('quarantine' AS text)
                                                                             , CAST('unquarantine' AS text)
                                                                             , CAST('reconcile' AS text)]))
  , CONSTRAINT copilot_quarantine_audit_actor_name_check CHECK (length(actor_name) >= 1
                                                            AND length(actor_name) <= 256)
  , CONSTRAINT copilot_quarantine_audit_actor_username_check CHECK (length(actor_username) >= 1
                                                                AND length(actor_username) <= 256)
  , CONSTRAINT copilot_quarantine_audit_bot_id_check CHECK (length(bot_id) >= 1
                                                        AND length(bot_id) <= 512)
  , CONSTRAINT copilot_quarantine_audit_check CHECK ((observed_state IS NULL) = (observed_provider_updated_at IS NULL))
  , CONSTRAINT copilot_quarantine_audit_environment_id_check CHECK (length(environment_id) >= 1
                                                                AND length(environment_id) <= 512)
  , CONSTRAINT copilot_quarantine_audit_error_code_check CHECK (length(error_code) <= 128)
  , CONSTRAINT copilot_quarantine_audit_message_check CHECK (length(message) <= 1024)
  , CONSTRAINT copilot_quarantine_audit_observed_provider_updated_at_check CHECK (observed_provider_updated_at IS NULL
                                                                               OR observed_provider_updated_at ~ CAST('^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,7})?Z$' AS text))
  , CONSTRAINT copilot_quarantine_audit_phase_check CHECK (phase = ANY(ARRAY[CAST('requested' AS text)
                                                                           , CAST('started' AS text)
                                                                           , CAST('sent' AS text)
                                                                           , CAST('succeeded' AS text)
                                                                           , CAST('skipped' AS text)
                                                                           , CAST('failed' AS text)
                                                                           , CAST('inconclusive' AS text)
                                                                           , CAST('reconciled' AS text)]))
  , CONSTRAINT copilot_quarantine_audit_principal_id_check CHECK (length(principal_id) >= 1
                                                              AND length(principal_id) <= 256)
  , CONSTRAINT copilot_quarantine_audit_resource_native_id_check CHECK (length(resource_native_id) >= 1
                                                                    AND length(resource_native_id) <= 512)
  , CONSTRAINT copilot_quarantine_audit_tenant_id_check CHECK (length(tenant_id) >= 1
                                                           AND length(tenant_id) <= 128)
  , CONSTRAINT copilot_quarantine_audit_pkey PRIMARY KEY (id)
);

CREATE TABLE copilot_quarantine_canary_approvals (
    id uuid NOT NULL
  , tenant_id text NOT NULL
  , approved_by_principal_id text NOT NULL
  , resource_native_id text NOT NULL
  , display_name text NOT NULL
  , snapshot_id uuid NOT NULL
  , inventory_observed_at timestamp with time zone NOT NULL
  , environment_id text NOT NULL
  , bot_id text NOT NULL
  , action text NOT NULL
  , prestate boolean NOT NULL
  , prestate_provider_updated_at text
  , poststate boolean NOT NULL
  , contract_revision text NOT NULL
  , permission_revision text NOT NULL
  , configuration_revision bigint NOT NULL
  , auth_mode text NOT NULL
  , status text DEFAULT CAST('approved' AS text) NOT NULL
  , paired_approval_id uuid
  , actor_principal_id text
  , job_id uuid
  , approved_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
  , attempted_at timestamp with time zone
  , finished_at timestamp with time zone
  , approval_expires_at timestamp with time zone DEFAULT clock_timestamp() + CAST('00:30:00' AS interval) NOT NULL
  , evidence_expires_at timestamp with time zone DEFAULT clock_timestamp() + CAST('30 days' AS interval) NOT NULL
  , error_code text
  , CONSTRAINT copilot_quarantine_canary_ap_prestate_provider_updated_at_check CHECK (prestate_provider_updated_at IS NULL
                                                                                   OR prestate_provider_updated_at ~ CAST('^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,7})?Z$' AS text))
  , CONSTRAINT copilot_quarantine_canary_approv_approved_by_principal_id_check CHECK (length(approved_by_principal_id) >= 1
                                                                                  AND length(approved_by_principal_id) <= 256)
  , CONSTRAINT copilot_quarantine_canary_approval_configuration_revision_check CHECK (configuration_revision > 0)
  , CONSTRAINT copilot_quarantine_canary_approvals_action_check CHECK (action = ANY(ARRAY[CAST('quarantine' AS text)
                                                                                        , CAST('unquarantine' AS text)]))
  , CONSTRAINT copilot_quarantine_canary_approvals_actor_principal_id_check CHECK (actor_principal_id IS NULL
                                                                                OR (length(actor_principal_id) >= 1
                                                                                AND length(actor_principal_id) <= 256))
  , CONSTRAINT copilot_quarantine_canary_approvals_auth_mode_check CHECK (auth_mode = CAST('delegated' AS text))
  , CONSTRAINT copilot_quarantine_canary_approvals_bot_id_check CHECK (length(bot_id) >= 1
                                                                   AND length(bot_id) <= 512)
  , CONSTRAINT copilot_quarantine_canary_approvals_check CHECK (prestate <> poststate)
  , CONSTRAINT copilot_quarantine_canary_approvals_check1 CHECK ((status = CAST('approved' AS text)
                                                              AND paired_approval_id IS NULL
                                                              AND actor_principal_id IS NULL
                                                              AND job_id IS NULL
                                                              AND attempted_at IS NULL)
                                                              OR status = CAST('expired' AS text)
                                                              OR (status <> ALL(ARRAY[CAST('approved' AS text)
                                                                                    , CAST('expired' AS text)])
                                                              AND paired_approval_id IS NOT NULL
                                                              AND actor_principal_id IS NOT NULL
                                                              AND attempted_at IS NOT NULL))
  , CONSTRAINT copilot_quarantine_canary_approvals_contract_revision_check CHECK (contract_revision ~ CAST('^[a-f0-9]{64}$' AS text))
  , CONSTRAINT copilot_quarantine_canary_approvals_display_name_check CHECK (length(display_name) >= 1
                                                                         AND length(display_name) <= 512)
  , CONSTRAINT copilot_quarantine_canary_approvals_environment_id_check CHECK (length(environment_id) >= 1
                                                                           AND length(environment_id) <= 512)
  , CONSTRAINT copilot_quarantine_canary_approvals_error_code_check CHECK (length(error_code) <= 128)
  , CONSTRAINT copilot_quarantine_canary_approvals_permission_revision_check CHECK (permission_revision ~ CAST('^[a-f0-9]{64}$' AS text))
  , CONSTRAINT copilot_quarantine_canary_approvals_resource_native_id_check CHECK (length(resource_native_id) >= 1
                                                                               AND length(resource_native_id) <= 512)
  , CONSTRAINT copilot_quarantine_canary_approvals_status_check CHECK (status = ANY(ARRAY[CAST('approved' AS text)
                                                                                        , CAST('claimed' AS text)
                                                                                        , CAST('qualified' AS text)
                                                                                        , CAST('failed' AS text)
                                                                                        , CAST('inconclusive' AS text)
                                                                                        , CAST('conflict' AS text)
                                                                                        , CAST('expired' AS text)]))
  , CONSTRAINT copilot_quarantine_canary_approvals_tenant_id_check CHECK (length(tenant_id) >= 1
                                                                      AND length(tenant_id) <= 128)
  , CONSTRAINT copilot_quarantine_canary_approvals_pkey PRIMARY KEY (id)
);

CREATE TABLE copilot_quarantine_qualifications (
    id uuid NOT NULL
  , tenant_id text NOT NULL
  , target_environment_id text NOT NULL
  , target_bot_id text NOT NULL
  , original_approval_id uuid NOT NULL
  , restoration_approval_id uuid NOT NULL
  , original_job_id uuid NOT NULL
  , restoration_job_id uuid NOT NULL
  , contract_revision text NOT NULL
  , permission_revision text NOT NULL
  , configuration_revision bigint NOT NULL
  , auth_mode text NOT NULL
  , qualified_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
  , expires_at timestamp with time zone DEFAULT clock_timestamp() + CAST('30 days' AS interval) NOT NULL
  , CONSTRAINT copilot_quarantine_qualifications_auth_mode_check CHECK (auth_mode = CAST('delegated' AS text))
  , CONSTRAINT copilot_quarantine_qualifications_check CHECK (original_approval_id <> restoration_approval_id)
  , CONSTRAINT copilot_quarantine_qualifications_check1 CHECK (original_job_id <> restoration_job_id)
  , CONSTRAINT copilot_quarantine_qualifications_configuration_revision_check CHECK (configuration_revision > 0)
  , CONSTRAINT copilot_quarantine_qualifications_contract_revision_check CHECK (contract_revision ~ CAST('^[a-f0-9]{64}$' AS text))
  , CONSTRAINT copilot_quarantine_qualifications_permission_revision_check CHECK (permission_revision ~ CAST('^[a-f0-9]{64}$' AS text))
  , CONSTRAINT copilot_quarantine_qualifications_target_bot_id_check CHECK (length(target_bot_id) >= 1
                                                                        AND length(target_bot_id) <= 512)
  , CONSTRAINT copilot_quarantine_qualifications_target_environment_id_check CHECK (length(target_environment_id) >= 1
                                                                                AND length(target_environment_id) <= 512)
  , CONSTRAINT copilot_quarantine_qualifications_tenant_id_check CHECK (length(tenant_id) >= 1
                                                                    AND length(tenant_id) <= 128)
  , CONSTRAINT copilot_quarantine_qualifications_pkey PRIMARY KEY (id)
);

CREATE TABLE operational_state (
    singleton boolean DEFAULT TRUE NOT NULL
  , mode text NOT NULL
  , provider_work_enabled boolean NOT NULL
  , restored_from_at timestamp with time zone
  , deletion_reviewed_at timestamp with time zone
  , access_reviewed_at timestamp with time zone
  , updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
  , CONSTRAINT operational_state_check CHECK ((restored_from_at IS NULL
                                           AND deletion_reviewed_at IS NULL
                                           AND access_reviewed_at IS NULL)
                                           OR (restored_from_at IS NOT NULL
                                           AND deletion_reviewed_at IS NOT NULL
                                           AND access_reviewed_at IS NOT NULL))
  , CONSTRAINT operational_state_mode_check CHECK (mode = ANY(ARRAY[CAST('normal' AS text)
                                                                  , CAST('maintenance' AS text)]))
  , CONSTRAINT operational_state_singleton_check CHECK (singleton)
  , CONSTRAINT operational_state_pkey PRIMARY KEY (singleton)
);

CREATE TABLE official_usage_row_facts (
    tenant_id text NOT NULL
  , kind text NOT NULL
  , payload_hash text NOT NULL
  , row_data jsonb NOT NULL
  , first_observed_at timestamp with time zone NOT NULL
  , identity_key text COLLATE pg_catalog."C"
  , agent_id text COLLATE pg_catalog."C"
  , username text
  , agent_name text
  , display_name text
  , creator_type text
  , responses bigint
  , agents_used bigint
  , licensed_users bigint
  , unlicensed_users bigint
  , last_activity date
  , CONSTRAINT official_usage_row_facts_agents_used_check CHECK (agents_used >= 0
                                                             AND agents_used <= CAST('9007199254740991' AS bigint))
  , CONSTRAINT official_usage_row_facts_check CHECK (jsonb_typeof(row_data) = CAST('object' AS text)
                                                 AND octet_length(CAST(row_data AS text)) <= 16384
                                                 AND payload_hash = public.official_usage_payload_hash(row_data))
  , CONSTRAINT official_usage_row_facts_kind_check CHECK (kind = ANY(ARRAY[CAST('agents' AS text)
                                                                         , CAST('userAgents' AS text)
                                                                         , CAST('users' AS text)]))
  , CONSTRAINT official_usage_row_facts_licensed_users_check CHECK (licensed_users >= 0
                                                                AND licensed_users <= CAST('9007199254740991' AS bigint))
  , CONSTRAINT official_usage_row_facts_payload_hash_check CHECK (payload_hash ~ CAST('^[a-f0-9]{64}$' AS text))
  , CONSTRAINT official_usage_row_facts_responses_check CHECK (responses >= 0
                                                           AND responses <= CAST('9007199254740991' AS bigint))
  , CONSTRAINT official_usage_row_facts_tenant_id_check CHECK (length(tenant_id) >= 1
                                                           AND length(tenant_id) <= 128)
  , CONSTRAINT official_usage_row_facts_unlicensed_users_check CHECK (unlicensed_users >= 0
                                                                  AND unlicensed_users <= CAST('9007199254740991' AS bigint))
  , CONSTRAINT official_usage_typed_fact CHECK ((responses IS NOT NULL
                                             AND (kind = 'agents'
                                              AND agent_id IS NOT NULL
                                              AND agent_name IS NOT NULL
                                              AND creator_type IS NOT NULL
                                              AND licensed_users IS NOT NULL
                                              AND unlicensed_users IS NOT NULL))
                                             OR (kind = 'users'
                                             AND identity_key IS NOT NULL
                                             AND username IS NOT NULL
                                             AND display_name IS NOT NULL
                                             AND responses IS NOT NULL
                                             AND agents_used IS NOT NULL)
                                             OR (kind = 'userAgents'
                                             AND identity_key IS NOT NULL
                                             AND username IS NOT NULL
                                             AND agent_id IS NOT NULL
                                             AND agent_name IS NOT NULL
                                             AND creator_type IS NOT NULL
                                             AND responses IS NOT NULL))
  , CONSTRAINT official_usage_typed_payload CHECK (identity_key IS NOT DISTINCT FROM lower(pg_catalog.normalize(pg_catalog.btrim(row_data ->> 'username')
                                                                                                              , 'NFKC'))
                                               AND agent_id IS NOT DISTINCT FROM row_data ->> 'agentId'
                                               AND username IS NOT DISTINCT FROM row_data ->> 'username'
                                               AND agent_name IS NOT DISTINCT FROM row_data ->> 'agentName'
                                               AND display_name IS NOT DISTINCT FROM row_data ->> 'displayName'
                                               AND creator_type IS NOT DISTINCT FROM row_data ->> 'creatorType'
                                               AND responses IS NOT DISTINCT FROM CAST(COALESCE(row_data ->> 'responsesSentToUsers'
                                                                                              , row_data ->> 'agentResponsesReceived') AS bigint)
                                               AND agents_used IS NOT DISTINCT FROM CAST(row_data ->> 'numberOfAgentsUsed' AS bigint)
                                               AND licensed_users IS NOT DISTINCT FROM CAST(row_data ->> 'activeUsersLicensed' AS bigint)
                                               AND unlicensed_users IS NOT DISTINCT FROM CAST(row_data ->> 'activeUsersUnlicensed' AS bigint)
                                               AND last_activity IS NOT DISTINCT FROM CAST(row_data ->> 'lastActivityDateUtc' AS date))
  , CONSTRAINT official_usage_row_facts_pkey PRIMARY KEY (tenant_id, kind, payload_hash)
);

CREATE TABLE data_sync_runs (
    id uuid NOT NULL
  , tenant_id text NOT NULL
  , principal_id text NOT NULL
  , mode text NOT NULL
  , source_ids jsonb NOT NULL
  , request_hash text NOT NULL
  , status text DEFAULT CAST('running' AS text) NOT NULL
  , started_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
  , updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
  , completed_at timestamp with time zone
  , expires_at timestamp with time zone DEFAULT clock_timestamp() + CAST('30 days' AS interval) NOT NULL
  , clear_saved_data boolean DEFAULT FALSE NOT NULL
  , automatic boolean DEFAULT FALSE NOT NULL
  , CONSTRAINT automatic_data_sync_scope CHECK (NOT automatic
                                             OR (mode = CAST('incremental' AS text)
                                             AND NOT clear_saved_data
                                             AND NOT source_ids ? CAST('usage_reports' AS text)))
  , CONSTRAINT data_sync_cleanup_full_scope CHECK (NOT clear_saved_data
                                                OR (mode = CAST('full' AS text)
                                                AND source_ids @> CAST('["users", "graph_packages", "power_platform"]' AS jsonb)
                                                AND jsonb_array_length(source_ids) = 3))
  , CONSTRAINT data_sync_runs_mode_check CHECK (mode = ANY(ARRAY[CAST('initial' AS text)
                                                               , CAST('incremental' AS text)
                                                               , CAST('full' AS text)]))
  , CONSTRAINT data_sync_runs_principal_id_check CHECK (length(principal_id) >= 1
                                                    AND length(principal_id) <= 256)
  , CONSTRAINT data_sync_runs_request_hash_check CHECK (request_hash ~ CAST('^[a-f0-9]{64}$' AS text))
  , CONSTRAINT data_sync_runs_source_ids_check CHECK (jsonb_typeof(source_ids) = CAST('array' AS text)
                                                  AND (jsonb_array_length(source_ids) >= 1
                                                   AND jsonb_array_length(source_ids) <= 4)
                                                  AND octet_length(CAST(source_ids AS text)) <= 256)
  , CONSTRAINT data_sync_runs_status_check CHECK (status = ANY(ARRAY[CAST('running' AS text)
                                                                   , CAST('waiting' AS text)
                                                                   , CAST('completed' AS text)
                                                                   , CAST('partial' AS text)
                                                                   , CAST('cancelled' AS text)]))
  , CONSTRAINT data_sync_runs_tenant_id_check CHECK (length(tenant_id) >= 1
                                                 AND length(tenant_id) <= 128)
  , CONSTRAINT data_sync_runs_id_tenant_id_principal_id_key UNIQUE (id, tenant_id, principal_id)
  , CONSTRAINT data_sync_runs_pkey PRIMARY KEY (id)
);

CREATE TABLE data_sync_run_sources (
    run_id uuid NOT NULL
  , tenant_id text NOT NULL
  , principal_id text NOT NULL
  , source_id text NOT NULL
  , status text NOT NULL
  , job_id uuid
  , attempt integer DEFAULT 1 NOT NULL
  , count integer
  , last_success_at timestamp with time zone
  , updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
  , message text NOT NULL
  , can_retry boolean DEFAULT FALSE NOT NULL
  , CONSTRAINT data_sync_run_sources_attempt_check CHECK (attempt >= 1 AND attempt <= 20)
  , CONSTRAINT data_sync_run_sources_count_check CHECK (count IS NULL OR count >= 0)
  , CONSTRAINT data_sync_run_sources_message_check CHECK (length(message) >= 1
                                                      AND length(message) <= 1024)
  , CONSTRAINT data_sync_run_sources_principal_id_check CHECK (length(principal_id) >= 1
                                                           AND length(principal_id) <= 256)
  , CONSTRAINT data_sync_run_sources_source_id_check CHECK (source_id = ANY(ARRAY[CAST('users' AS text)
                                                                                , CAST('graph_packages' AS text)
                                                                                , CAST('power_platform' AS text)
                                                                                , CAST('usage_reports' AS text)]))
  , CONSTRAINT data_sync_run_sources_status_check CHECK (status = ANY(ARRAY[CAST('not_started' AS text)
                                                                          , CAST('queued' AS text)
                                                                          , CAST('running' AS text)
                                                                          , CAST('waiting_authorization' AS text)
                                                                          , CAST('permission_required' AS text)
                                                                          , CAST('awaiting_upload' AS text)
                                                                          , CAST('succeeded' AS text)
                                                                          , CAST('partial' AS text)
                                                                          , CAST('failed' AS text)
                                                                          , CAST('cancelled' AS text)]))
  , CONSTRAINT data_sync_run_sources_tenant_id_check CHECK (length(tenant_id) >= 1
                                                        AND length(tenant_id) <= 128)
  , CONSTRAINT data_sync_run_sources_pkey PRIMARY KEY (run_id, source_id)
);

CREATE TABLE data_sync_source_jobs (
    run_id uuid NOT NULL
  , tenant_id text NOT NULL
  , principal_id text NOT NULL
  , source_id text NOT NULL
  , attempt integer NOT NULL
  , job_id uuid NOT NULL
  , created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
  , CONSTRAINT data_sync_source_jobs_attempt_check CHECK (attempt >= 1 AND attempt <= 20)
  , CONSTRAINT data_sync_source_jobs_principal_id_check CHECK (length(principal_id) >= 1
                                                           AND length(principal_id) <= 256)
  , CONSTRAINT data_sync_source_jobs_source_id_check CHECK (source_id = ANY(ARRAY[CAST('users' AS text)
                                                                                , CAST('graph_packages' AS text)
                                                                                , CAST('power_platform' AS text)]))
  , CONSTRAINT data_sync_source_jobs_tenant_id_check CHECK (length(tenant_id) >= 1
                                                        AND length(tenant_id) <= 128)
  , CONSTRAINT data_sync_source_jobs_job_id_key UNIQUE (job_id)
  , CONSTRAINT data_sync_source_jobs_pkey PRIMARY KEY (run_id, source_id, attempt)
);

CREATE TABLE data_sync_success_markers (
    tenant_id text NOT NULL
  , principal_id text NOT NULL
  , source_id text NOT NULL
  , count integer
  , last_success_at timestamp with time zone NOT NULL
  , updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
  , CONSTRAINT data_sync_success_markers_count_check CHECK (count IS NULL OR count >= 0)
  , CONSTRAINT data_sync_success_markers_principal_id_check CHECK (length(principal_id) >= 1
                                                               AND length(principal_id) <= 256)
  , CONSTRAINT data_sync_success_markers_source_id_check CHECK (source_id = ANY(ARRAY[CAST('users' AS text)
                                                                                    , CAST('graph_packages' AS text)
                                                                                    , CAST('power_platform' AS text)
                                                                                    , CAST('usage_reports' AS text)]))
  , CONSTRAINT data_sync_success_markers_tenant_id_check CHECK (length(tenant_id) >= 1
                                                            AND length(tenant_id) <= 128)
  , CONSTRAINT data_sync_success_markers_pkey PRIMARY KEY (tenant_id, principal_id, source_id)
);

CREATE TABLE agent_usage_state (
    tenant_id text NOT NULL
  , revision bigint DEFAULT 1 NOT NULL
  , CONSTRAINT agent_usage_state_revision_check CHECK (revision > 0)
  , CONSTRAINT agent_usage_state_tenant_id_check CHECK (length(tenant_id) >= 1
                                                    AND length(tenant_id) <= 128)
  , CONSTRAINT agent_usage_state_pkey PRIMARY KEY (tenant_id)
);

CREATE TABLE agent_usage_associations (
    tenant_id text NOT NULL
  , report_set_id uuid NOT NULL
  , report_agent_id text NOT NULL
  , source text NOT NULL
  , native_id text NOT NULL
  , environment_id text NOT NULL
  , normalized_environment_id text GENERATED ALWAYS AS (CASE
                                                          WHEN source = CAST('power_platform' AS text)
                                                            THEN lower(environment_id)
                                                          ELSE environment_id
                                                        END) STORED
  , normalized_native_id text GENERATED ALWAYS AS (CASE
                                                     WHEN source = CAST('power_platform' AS text)
                                                      AND length(native_id) = 36
                                                      AND native_id ~* CAST('^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' AS text)
                                                       THEN lower(native_id)
                                                     ELSE native_id
                                                   END) STORED
  , basis text DEFAULT CAST('admin_reviewed' AS text) NOT NULL
  , reviewed_by text NOT NULL
  , reviewed_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
  , CONSTRAINT agent_usage_associations_basis_check CHECK (basis = CAST('admin_reviewed' AS text))
  , CONSTRAINT agent_usage_associations_check CHECK (source <> CAST('graph_packages' AS text)
                                                  OR environment_id = CAST('' AS text))
  , CONSTRAINT agent_usage_associations_environment_id_check CHECK (length(environment_id) <= 512
                                                                AND environment_id !~ CAST('[[:cntrl:]]' AS text))
  , CONSTRAINT agent_usage_associations_native_id_check CHECK (length(native_id) >= 1
                                                           AND length(native_id) <= 512
                                                           AND native_id !~ CAST('[[:cntrl:]]' AS text))
  , CONSTRAINT agent_usage_associations_report_agent_id_check CHECK (length(report_agent_id) >= 1
                                                                 AND length(report_agent_id) <= 512
                                                                 AND report_agent_id !~ CAST('[[:cntrl:]]' AS text))
  , CONSTRAINT agent_usage_associations_reviewed_by_check CHECK (length(reviewed_by) >= 1
                                                             AND length(reviewed_by) <= 256)
  , CONSTRAINT agent_usage_associations_source_check CHECK (source = ANY(ARRAY[CAST('graph_packages' AS text)
                                                                             , CAST('power_platform' AS text)]))
  , CONSTRAINT agent_usage_associations_tenant_id_check CHECK (length(tenant_id) >= 1
                                                           AND length(tenant_id) <= 128)
  , CONSTRAINT agent_usage_associations_pkey PRIMARY KEY (tenant_id, report_set_id, report_agent_id)
);

CREATE TABLE agent_people_cache (
    tenant_id text NOT NULL
  , principal_id text NOT NULL
  , object_id uuid NOT NULL
  , revision uuid NOT NULL
  , status text NOT NULL
  , display_name text
  , user_principal_name text
  , checked_at timestamp with time zone NOT NULL
  , resolved_at timestamp with time zone
  , expires_at timestamp with time zone NOT NULL
  , error_code text
  , CONSTRAINT agent_people_cache_check CHECK (expires_at > checked_at)
  , CONSTRAINT agent_people_cache_check1 CHECK ((status = CAST('lookup_failed' AS text)) = (error_code IS NOT NULL))
  , CONSTRAINT agent_people_cache_check2 CHECK (status <> CAST('not_found' AS text)
                                             OR (display_name IS NULL
                                             AND user_principal_name IS NULL
                                             AND resolved_at IS NULL))
  , CONSTRAINT agent_people_cache_display_name_check CHECK (length(display_name) >= 1
                                                        AND length(display_name) <= 512)
  , CONSTRAINT agent_people_cache_error_code_check CHECK (error_code ~ CAST('^[a-z][a-z0-9_]{0,127}$' AS text))
  , CONSTRAINT agent_people_cache_principal_id_check CHECK (length(principal_id) >= 1
                                                        AND length(principal_id) <= 256)
  , CONSTRAINT agent_people_cache_status_check CHECK (status = ANY(ARRAY[CAST('resolved' AS text)
                                                                       , CAST('not_found' AS text)
                                                                       , CAST('lookup_failed' AS text)]))
  , CONSTRAINT agent_people_cache_tenant_id_check CHECK (length(tenant_id) >= 1
                                                     AND length(tenant_id) <= 128)
  , CONSTRAINT agent_people_cache_user_principal_name_check CHECK (length(user_principal_name) >= 1
                                                               AND length(user_principal_name) <= 320)
  , CONSTRAINT agent_people_cache_pkey PRIMARY KEY (tenant_id, principal_id, object_id)
);

CREATE TABLE agent_identity_cache (
    tenant_id text NOT NULL
  , principal_id text NOT NULL
  , record_id text NOT NULL
  , snapshot_id uuid NOT NULL
  , native_id text NOT NULL
  , environment_id text NOT NULL
  , source_revision text NOT NULL
  , candidate_id uuid NOT NULL
  , application_id uuid
  , checked_at timestamp with time zone NOT NULL
  , expires_at timestamp with time zone NOT NULL
  , outcome text DEFAULT CAST('resolved' AS text) NOT NULL
  , runtime_status text DEFAULT CAST('unverified' AS text) NOT NULL
  , last_error_code text
  , runtime_provenance text
  , CONSTRAINT agent_identity_cache_application_id_check CHECK (application_id <> CAST('00000000-0000-0000-0000-000000000000' AS uuid))
  , CONSTRAINT agent_identity_cache_candidate_id_check CHECK (candidate_id <> CAST('00000000-0000-0000-0000-000000000000' AS uuid))
  , CONSTRAINT agent_identity_cache_canonical_record CHECK (record_id ~ CAST('^agent:[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' AS text))
  , CONSTRAINT agent_identity_cache_check CHECK (expires_at > checked_at
                                             AND expires_at <= (checked_at + CAST('01:00:00' AS interval)))
  , CONSTRAINT agent_identity_cache_client_id_provenance CHECK ((outcome = CAST('resolved' AS text)) = (runtime_provenance IS NOT NULL)
                                                            AND (runtime_provenance IS NULL
                                                              OR (runtime_status = CAST('available' AS text)
                                                              AND application_id = candidate_id)))
  , CONSTRAINT agent_identity_cache_environment_id_check CHECK (length(environment_id) >= 1
                                                            AND length(environment_id) <= 512)
  , CONSTRAINT agent_identity_cache_last_error_code_check CHECK (last_error_code ~ CAST('^[A-Za-z][A-Za-z0-9_.-]{0,127}$' AS text))
  , CONSTRAINT agent_identity_cache_native_id_check CHECK (length(native_id) >= 1
                                                       AND length(native_id) <= 512)
  , CONSTRAINT agent_identity_cache_outcome_check CHECK (outcome = ANY(ARRAY[CAST('resolved' AS text)
                                                                           , CAST('authorization_required' AS text)
                                                                           , CAST('not_found' AS text)
                                                                           , CAST('provider_error' AS text)
                                                                           , CAST('setup_required' AS text)]))
  , CONSTRAINT agent_identity_cache_outcome_fields CHECK ((outcome = CAST('resolved' AS text)) = (last_error_code IS NULL)
                                                      AND (runtime_status = CAST('available' AS text)) = (application_id IS NOT NULL)
                                                      AND (outcome = CAST('resolved' AS text)
                                                        OR runtime_status = CAST('unverified' AS text)))
  , CONSTRAINT agent_identity_cache_principal_id_check CHECK (length(principal_id) >= 1
                                                          AND length(principal_id) <= 256)
  , CONSTRAINT agent_identity_cache_record_id_check CHECK (length(record_id) >= 1
                                                       AND length(record_id) <= 2048)
  , CONSTRAINT agent_identity_cache_runtime_provenance_check CHECK (runtime_provenance IS NULL
                                                                 OR runtime_provenance = CAST('verified-entra-agent-identity-client-id' AS text))
  , CONSTRAINT agent_identity_cache_runtime_status_check CHECK (runtime_status = ANY(ARRAY[CAST('available' AS text)
                                                                                         , CAST('missing' AS text)
                                                                                         , CAST('shared' AS text)
                                                                                         , CAST('unverified' AS text)]))
  , CONSTRAINT agent_identity_cache_source_revision_check CHECK (source_revision ~ CAST('^[a-f0-9]{64}$' AS text))
  , CONSTRAINT agent_identity_cache_tenant_id_check CHECK (length(tenant_id) >= 1
                                                       AND length(tenant_id) <= 128)
  , CONSTRAINT agent_identity_cache_pkey PRIMARY KEY (tenant_id, principal_id, record_id)
);

CREATE TABLE data_principal_epochs (
    tenant_id text NOT NULL
  , principal_id text NOT NULL
  , epoch bigint DEFAULT 0 NOT NULL
  , CONSTRAINT data_principal_epochs_epoch_check CHECK (epoch >= 0)
  , CONSTRAINT data_principal_epochs_principal_id_check CHECK (length(principal_id) >= 1
                                                           AND length(principal_id) <= 256)
  , CONSTRAINT data_principal_epochs_tenant_id_check CHECK (length(tenant_id) >= 1
                                                        AND length(tenant_id) <= 128)
  , CONSTRAINT data_principal_epochs_pkey PRIMARY KEY (tenant_id, principal_id)
);

CREATE TABLE data_scope_epochs (
    id uuid NOT NULL
  , tenant_id text NOT NULL
  , scope_kind text NOT NULL
  , principal_id text
  , token_mode text NOT NULL
  , source text NOT NULL
  , selector text NOT NULL
  , epoch bigint DEFAULT 0 NOT NULL
  , session_epoch bigint DEFAULT 0 NOT NULL
  , CONSTRAINT data_scope_epochs_check CHECK ((scope_kind = CAST('tenant' AS text)
                                           AND principal_id IS NULL
                                           AND token_mode = CAST('tenant' AS text))
                                           OR (scope_kind = CAST('principal' AS text)
                                           AND principal_id IS NOT NULL
                                           AND token_mode <> CAST('tenant' AS text)))
  , CONSTRAINT data_scope_epochs_epoch_check CHECK (epoch >= 0)
  , CONSTRAINT data_scope_epochs_principal_id_check CHECK (length(principal_id) >= 1
                                                       AND length(principal_id) <= 256)
  , CONSTRAINT data_scope_epochs_scope_kind_check CHECK (scope_kind = ANY(ARRAY[CAST('tenant' AS text)
                                                                              , CAST('principal' AS text)]))
  , CONSTRAINT data_scope_epochs_selector_check CHECK (octet_length(selector) <= 1024)
  , CONSTRAINT data_scope_epochs_session_epoch_check CHECK (session_epoch >= 0)
  , CONSTRAINT data_scope_epochs_source_check CHECK (length(source) >= 1 AND length(source) <= 128)
  , CONSTRAINT data_scope_epochs_tenant_id_check CHECK (length(tenant_id) >= 1
                                                    AND length(tenant_id) <= 128)
  , CONSTRAINT data_scope_epochs_token_mode_check CHECK (token_mode = ANY(ARRAY[CAST('tenant' AS text)
                                                                              , CAST('delegated' AS text)
                                                                              , CAST('application' AS text)]))
  , CONSTRAINT data_scope_epochs_id_tenant_id_key UNIQUE (id, tenant_id)
  , CONSTRAINT data_scope_epochs_pkey PRIMARY KEY (id)
  , CONSTRAINT data_scope_epochs_tenant_id_scope_kind_principal_id_token_m_key UNIQUE NULLS NOT DISTINCT (tenant_id, scope_kind, principal_id, token_mode, source, selector)
);

CREATE TABLE data_generations (
    id uuid NOT NULL
  , scope_id uuid NOT NULL
  , tenant_id text NOT NULL
  , state text DEFAULT CAST('staging' AS text) NOT NULL
  , schema_version integer NOT NULL
  , scope_epoch bigint NOT NULL
  , session_epoch bigint NOT NULL
  , expected_revision bigint NOT NULL
  , job_id uuid NOT NULL
  , run_id uuid
  , job_kind text NOT NULL
  , owner uuid NOT NULL
  , lease_version integer NOT NULL
  , lease_until timestamp with time zone NOT NULL
  , deadline_at timestamp with time zone NOT NULL
  , cancellation bigint DEFAULT 0 NOT NULL
  , reserved_bytes bigint NOT NULL
  , byte_count bigint DEFAULT 0 NOT NULL
  , row_count integer DEFAULT 0 NOT NULL
  , child_count integer DEFAULT 0 NOT NULL
  , batch_count integer DEFAULT 0 NOT NULL
  , page_count integer DEFAULT 0 NOT NULL
  , wire_count integer DEFAULT 0 NOT NULL
  , validated boolean DEFAULT FALSE NOT NULL
  , validation_phase text DEFAULT CAST('directory' AS text) NOT NULL
  , validation_cursor text
  , validated_rows integer DEFAULT 0 NOT NULL
  , validated_children integer DEFAULT 0 NOT NULL
  , created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
  , observed_at timestamp with time zone NOT NULL
  , expires_at timestamp with time zone NOT NULL
  , content_hash text
  , collected_at timestamp with time zone
  , CONSTRAINT data_generations_batch_count_check CHECK (batch_count >= 0)
  , CONSTRAINT data_generations_cancellation_check CHECK (cancellation >= 0)
  , CONSTRAINT data_generations_check CHECK (byte_count >= 0
                                         AND byte_count <= CAST('8589934592' AS bigint)
                                         AND byte_count <= reserved_bytes)
  , CONSTRAINT data_generations_check1 CHECK (row_count >= 0
                                          AND row_count <= 200000
                                          AND (job_kind = CAST('derived' AS text)
                                            OR row_count <= 100000))
  , CONSTRAINT data_generations_check2 CHECK (expires_at > observed_at)
  , CONSTRAINT data_generations_check3 CHECK (deadline_at > created_at)
  , CONSTRAINT data_generations_check4 CHECK (collected_at IS NULL
                                           OR state = CAST('deleting' AS text))
  , CONSTRAINT data_generations_child_count_check CHECK (child_count >= 0)
  , CONSTRAINT data_generations_content_hash_check CHECK (content_hash ~ CAST('^[a-f0-9]{64}$' AS text))
  , CONSTRAINT data_generations_expected_revision_check CHECK (expected_revision >= 0)
  , CONSTRAINT data_generations_job_kind_check CHECK (job_kind = ANY(ARRAY[CAST('data_sync' AS text)
                                                                         , CAST('package_refresh' AS text)
                                                                         , CAST('power_platform_refresh' AS text)
                                                                         , CAST('derived' AS text)
                                                                         , CAST('fixture' AS text)]))
  , CONSTRAINT data_generations_lease_version_check CHECK (lease_version > 0)
  , CONSTRAINT data_generations_page_count_check CHECK (page_count >= 0 AND page_count <= 10000)
  , CONSTRAINT data_generations_reserved_bytes_check CHECK (reserved_bytes >= 0
                                                        AND reserved_bytes <= CAST('8589934592' AS bigint))
  , CONSTRAINT data_generations_schema_version_check CHECK (schema_version > 0)
  , CONSTRAINT data_generations_state_check CHECK (state = ANY(ARRAY[CAST('staging' AS text)
                                                                   , CAST('validating' AS text)
                                                                   , CAST('published' AS text)
                                                                   , CAST('retired' AS text)
                                                                   , CAST('deleting' AS text)
                                                                   , CAST('failed' AS text)
                                                                   , CAST('cancelled' AS text)]))
  , CONSTRAINT data_generations_validated_children_check CHECK (validated_children >= 0
                                                            AND validated_children <= 100000000)
  , CONSTRAINT data_generations_validated_rows_check CHECK (validated_rows >= 0
                                                        AND validated_rows <= 200000)
  , CONSTRAINT data_generations_validation_cursor_check CHECK (length(validation_cursor) <= 512)
  , CONSTRAINT data_generations_validation_phase_check CHECK (validation_phase = ANY(ARRAY[CAST('directory' AS text)
                                                                                         , CAST('activity' AS text)
                                                                                         , CAST('complete' AS text)]))
  , CONSTRAINT data_generations_wire_count_check CHECK (wire_count >= 0 AND wire_count <= 5000000)
  , CONSTRAINT data_generations_id_scope_id_tenant_id_key UNIQUE (id, scope_id, tenant_id)
  , CONSTRAINT data_generations_pkey PRIMARY KEY (id)
);

CREATE TABLE data_generation_heads (
    scope_id uuid NOT NULL
  , tenant_id text NOT NULL
  , generation_id uuid
  , revision bigint DEFAULT 0 NOT NULL
  , CONSTRAINT data_generation_heads_revision_check CHECK (revision >= 0)
  , CONSTRAINT data_generation_heads_pkey PRIMARY KEY (scope_id)
);

CREATE TABLE data_generation_batches (
    generation_id uuid NOT NULL
  , scope_id uuid NOT NULL
  , tenant_id text NOT NULL
  , ordinal integer NOT NULL
  , digest text NOT NULL
  , row_count integer NOT NULL
  , parameter_bytes integer NOT NULL
  , CONSTRAINT data_generation_batches_digest_check CHECK (digest ~ CAST('^[a-f0-9]{64}$' AS text))
  , CONSTRAINT data_generation_batches_ordinal_check CHECK (ordinal >= 0)
  , CONSTRAINT data_generation_batches_parameter_bytes_check CHECK (parameter_bytes >= 1
                                                                AND parameter_bytes <= 1048576)
  , CONSTRAINT data_generation_batches_row_count_check CHECK (row_count >= 0 AND row_count <= 250)
  , CONSTRAINT data_generation_batches_pkey PRIMARY KEY (generation_id, ordinal)
);

CREATE TABLE data_generation_pages (
    generation_id uuid NOT NULL
  , scope_id uuid NOT NULL
  , tenant_id text NOT NULL
  , ordinal integer NOT NULL
  , token_hash text NOT NULL
  , wire_rows integer NOT NULL
  , CONSTRAINT data_generation_pages_ordinal_check CHECK (ordinal >= 0 AND ordinal <= 9999)
  , CONSTRAINT data_generation_pages_token_hash_check CHECK (token_hash ~ CAST('^[a-f0-9]{64}$' AS text))
  , CONSTRAINT data_generation_pages_wire_rows_check CHECK (wire_rows >= 0 AND wire_rows <= 5000000)
  , CONSTRAINT data_generation_pages_generation_id_token_hash_key UNIQUE (generation_id, token_hash)
  , CONSTRAINT data_generation_pages_pkey PRIMARY KEY (generation_id, ordinal)
);

CREATE TABLE directory_user_rows (
    generation_id uuid NOT NULL
  , scope_id uuid NOT NULL
  , tenant_id text NOT NULL
  , identity text NOT NULL
  , schema_version integer NOT NULL
  , content_hash text NOT NULL
  , upn text NOT NULL
  , upn_key text NOT NULL
  , display_name text
  , sort_key text COLLATE pg_catalog."C"
  , company text
  , department text
  , account_enabled boolean
  , user_type text
  , employee_type text
  , service_state text NOT NULL
  , plan_count integer NOT NULL
  , residual jsonb DEFAULT CAST('{}' AS jsonb) NOT NULL
  , CONSTRAINT directory_user_rows_company_check CHECK (length(company) <= 1024)
  , CONSTRAINT directory_user_rows_content_hash_check CHECK (content_hash ~ CAST('^[a-f0-9]{64}$' AS text))
  , CONSTRAINT directory_user_rows_department_check CHECK (length(department) <= 1024)
  , CONSTRAINT directory_user_rows_display_name_check CHECK (length(display_name) <= 1024)
  , CONSTRAINT directory_user_rows_employee_type_check CHECK (length(employee_type) <= 128)
  , CONSTRAINT directory_user_rows_identity_check CHECK (length(identity) >= 1
                                                     AND length(identity) <= 512)
  , CONSTRAINT directory_user_rows_plan_count_check CHECK (plan_count >= 0 AND plan_count <= 1000)
  , CONSTRAINT directory_user_rows_residual_check CHECK (jsonb_typeof(residual) = CAST('object' AS text)
                                                     AND octet_length(CAST(residual AS text)) <= 262144)
  , CONSTRAINT directory_user_rows_schema_version_check CHECK (schema_version > 0)
  , CONSTRAINT directory_user_rows_service_state_check CHECK (service_state = ANY(ARRAY[CAST('enabled' AS text)
                                                                                      , CAST('warning' AS text)
                                                                                      , CAST('partially_enabled' AS text)
                                                                                      , CAST('disabled' AS text)
                                                                                      , CAST('suspended' AS text)
                                                                                      , CAST('locked_out' AS text)
                                                                                      , CAST('unknown' AS text)]))
  , CONSTRAINT directory_user_rows_sort_key_check CHECK (length(sort_key) <= 1024)
  , CONSTRAINT directory_user_rows_upn_check CHECK (length(upn) <= 512)
  , CONSTRAINT directory_user_rows_upn_key_check CHECK (length(upn_key) <= 512)
  , CONSTRAINT directory_user_rows_user_type_check CHECK (length(user_type) <= 128)
  , CONSTRAINT directory_user_rows_generation_id_scope_id_tenant_id_identi_key UNIQUE (generation_id, scope_id, tenant_id, identity)
  , CONSTRAINT directory_user_rows_pkey PRIMARY KEY (generation_id, identity)
);

CREATE TABLE directory_service_plan_rows (
    generation_id uuid NOT NULL
  , scope_id uuid NOT NULL
  , tenant_id text NOT NULL
  , identity text NOT NULL
  , user_id text NOT NULL
  , plan_id text NOT NULL
  , schema_version integer NOT NULL
  , content_hash text NOT NULL
  , service text NOT NULL
  , display_name text NOT NULL
  , state text NOT NULL
  , capability_status text
  , assigned_at timestamp with time zone
  , residual jsonb DEFAULT CAST('{}' AS jsonb) NOT NULL
  , CONSTRAINT directory_service_plan_rows_capability_status_check CHECK (capability_status = ANY(ARRAY[CAST('Enabled' AS text)
                                                                                                      , CAST('Warning' AS text)
                                                                                                      , CAST('Suspended' AS text)
                                                                                                      , CAST('Deleted' AS text)
                                                                                                      , CAST('LockedOut' AS text)]))
  , CONSTRAINT directory_service_plan_rows_content_hash_check CHECK (content_hash ~ CAST('^[a-f0-9]{64}$' AS text))
  , CONSTRAINT directory_service_plan_rows_display_name_check CHECK (length(display_name) <= 1024)
  , CONSTRAINT directory_service_plan_rows_identity_check CHECK (length(identity) >= 1
                                                             AND length(identity) <= 512)
  , CONSTRAINT directory_service_plan_rows_plan_id_check CHECK (length(plan_id) >= 1
                                                            AND length(plan_id) <= 128)
  , CONSTRAINT directory_service_plan_rows_residual_check CHECK (jsonb_typeof(residual) = CAST('object' AS text)
                                                             AND octet_length(CAST(residual AS text)) <= 262144)
  , CONSTRAINT directory_service_plan_rows_schema_version_check CHECK (schema_version > 0)
  , CONSTRAINT directory_service_plan_rows_service_check CHECK (length(service) <= 256)
  , CONSTRAINT directory_service_plan_rows_state_check CHECK (state = ANY(ARRAY[CAST('enabled' AS text)
                                                                              , CAST('warning' AS text)
                                                                              , CAST('disabled' AS text)
                                                                              , CAST('suspended' AS text)
                                                                              , CAST('locked_out' AS text)
                                                                              , CAST('unknown' AS text)]))
  , CONSTRAINT directory_service_plan_rows_generation_id_user_id_plan_id_key UNIQUE (generation_id, user_id, plan_id)
  , CONSTRAINT directory_service_plan_rows_pkey PRIMARY KEY (generation_id, identity)
);

CREATE TABLE app_activity_rows (
    generation_id uuid NOT NULL
  , scope_id uuid NOT NULL
  , tenant_id text NOT NULL
  , identity text NOT NULL
  , schema_version integer NOT NULL
  , content_hash text NOT NULL
  , upn_key text NOT NULL
  , report_refresh_date date
  , last_activity_date date
  , chat_date date
  , teams_date date
  , word_date date
  , excel_date date
  , powerpoint_date date
  , outlook_date date
  , onenote_date date
  , loop_date date
  , period text NOT NULL
  , residual jsonb DEFAULT CAST('{}' AS jsonb) NOT NULL
  , CONSTRAINT app_activity_rows_content_hash_check CHECK (content_hash ~ CAST('^[a-f0-9]{64}$' AS text))
  , CONSTRAINT app_activity_rows_identity_check CHECK (length(identity) >= 1
                                                   AND length(identity) <= 512)
  , CONSTRAINT app_activity_rows_period_check CHECK (period = ANY(ARRAY[CAST('D28' AS text)
                                                                      , CAST('D30' AS text)]))
  , CONSTRAINT app_activity_rows_residual_check CHECK (jsonb_typeof(residual) = CAST('object' AS text)
                                                   AND octet_length(CAST(residual AS text)) <= 262144)
  , CONSTRAINT app_activity_rows_schema_version_check CHECK (schema_version > 0)
  , CONSTRAINT app_activity_rows_upn_key_check CHECK (length(upn_key) <= 512)
  , CONSTRAINT app_activity_rows_pkey PRIMARY KEY (generation_id, identity)
);

CREATE TABLE data_read_selections (
    id uuid NOT NULL
  , tenant_id text NOT NULL
  , principal_id text NOT NULL
  , authorization_hash text NOT NULL
  , session_epoch bigint NOT NULL
  , root_count integer NOT NULL
  , endpoint text NOT NULL
  , query_hash text NOT NULL
  , query_json jsonb NOT NULL
  , evaluated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
  , expires_at timestamp with time zone NOT NULL
  , invalidated_at timestamp with time zone
  , revision uuid NOT NULL
  , CONSTRAINT data_read_selections_authorization_hash_check CHECK (authorization_hash ~ CAST('^[a-f0-9]{64}$' AS text))
  , CONSTRAINT data_read_selections_check CHECK (expires_at <= (evaluated_at + CAST('00:10:00' AS interval)))
  , CONSTRAINT data_read_selections_endpoint_check CHECK (length(endpoint) >= 1
                                                      AND length(endpoint) <= 256)
  , CONSTRAINT data_read_selections_query_hash_check CHECK (query_hash ~ CAST('^[a-f0-9]{64}$' AS text))
  , CONSTRAINT data_read_selections_query_json_check CHECK (jsonb_typeof(query_json) = CAST('object' AS text)
                                                        AND octet_length(CAST(query_json AS text)) <= 4096)
  , CONSTRAINT data_read_selections_root_count_check CHECK (root_count >= 1 AND root_count <= 16)
  , CONSTRAINT data_read_selections_session_epoch_check CHECK (session_epoch >= 0)
  , CONSTRAINT data_read_selections_id_tenant_id_key UNIQUE (id, tenant_id)
  , CONSTRAINT data_read_selections_pkey PRIMARY KEY (id)
);

CREATE TABLE data_generation_pins (
    selection_id uuid NOT NULL
  , tenant_id text NOT NULL
  , ordinal integer NOT NULL
  , scope_id uuid NOT NULL
  , scope_epoch bigint NOT NULL
  , session_epoch bigint NOT NULL
  , root_kind text NOT NULL
  , generation_id uuid
  , revision bigint NOT NULL
  , expires_at timestamp with time zone NOT NULL
  , CONSTRAINT data_generation_pins_check CHECK ((root_kind = ANY(ARRAY[CAST('tenant_history' AS text)
                                                                      , CAST('user_sources' AS text)])
                                              AND generation_id IS NULL)
                                              OR (root_kind = ANY(ARRAY[CAST('generation' AS text)
                                                                      , CAST('inventory_delta' AS text)])
                                              AND generation_id IS NOT NULL))
  , CONSTRAINT data_generation_pins_ordinal_check CHECK (ordinal >= 0 AND ordinal <= 15)
  , CONSTRAINT data_generation_pins_revision_check CHECK (revision >= 0)
  , CONSTRAINT data_generation_pins_root_kind_check CHECK (root_kind = ANY(ARRAY[CAST('generation' AS text)
                                                                               , CAST('tenant_history' AS text)
                                                                               , CAST('inventory_delta' AS text)
                                                                               , CAST('user_sources' AS text)]))
  , CONSTRAINT data_generation_pins_pkey PRIMARY KEY (selection_id, ordinal)
);

CREATE TABLE data_exports (
    id uuid NOT NULL
  , tenant_id text NOT NULL
  , principal_id text NOT NULL
  , selection_id uuid NOT NULL
  , query_hash text NOT NULL
  , kind text NOT NULL
  , selection_mode text NOT NULL
  , status text NOT NULL
  , filename text NOT NULL
  , owner uuid
  , lease_version integer DEFAULT 0 NOT NULL
  , lease_until timestamp with time zone
  , created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
  , deadline_at timestamp with time zone NOT NULL
  , expires_at timestamp with time zone NOT NULL
  , row_count integer DEFAULT 0 NOT NULL
  , byte_count bigint DEFAULT 0 NOT NULL
  , chunk_count integer DEFAULT 0 NOT NULL
  , checksum text
  , error_code text
  , error_limit bigint
  , error_observed bigint
  , actor jsonb
  , idempotency_key uuid
  , request_hash text
  , CONSTRAINT data_exports_actor_check CHECK (actor IS NULL
                                            OR (jsonb_typeof(actor) = CAST('object' AS text)
                                            AND octet_length(CAST(actor AS text)) <= 4096))
  , CONSTRAINT data_exports_byte_count_check CHECK (byte_count >= 0 AND byte_count <= 1073741824)
  , CONSTRAINT data_exports_check CHECK (deadline_at <= (created_at + CAST('00:15:00' AS interval)))
  , CONSTRAINT data_exports_check1 CHECK (expires_at <= (created_at + CAST('00:30:00' AS interval)))
  , CONSTRAINT data_exports_checksum_check CHECK (checksum ~ CAST('^[a-f0-9]{64}$' AS text))
  , CONSTRAINT data_exports_chunk_count_check CHECK (chunk_count >= 0)
  , CONSTRAINT data_exports_error_code_check CHECK (length(error_code) <= 128)
  , CONSTRAINT data_exports_error_limit_check CHECK (error_limit >= 0)
  , CONSTRAINT data_exports_error_observed_check CHECK (error_observed >= 0)
  , CONSTRAINT data_exports_filename_check CHECK (filename ~ CAST('^[a-zA-Z0-9][a-zA-Z0-9.-]{0,126}\.csv$' AS text)
                                              AND filename !~~ CAST('%..%' AS text))
  , CONSTRAINT data_exports_kind_check CHECK (kind = ANY(ARRAY[CAST('copilot_users' AS text)
                                                             , CAST('official_agents' AS text)
                                                             , CAST('official_users' AS text)
                                                             , CAST('graph_packages' AS text)
                                                             , CAST('power_platform_agents' AS text)
                                                             , CAST('unified_agents' AS text)]))
  , CONSTRAINT data_exports_query_hash_check CHECK (query_hash ~ CAST('^[a-f0-9]{64}$' AS text))
  , CONSTRAINT data_exports_request_hash_check CHECK (request_hash ~ CAST('^[a-f0-9]{64}$' AS text))
  , CONSTRAINT data_exports_row_count_check CHECK (row_count >= 0 AND row_count <= 2000000)
  , CONSTRAINT data_exports_selection_mode_check CHECK (selection_mode = ANY(ARRAY[CAST('all' AS text)
                                                                                 , CAST('explicit' AS text)]))
  , CONSTRAINT data_exports_status_check CHECK (status = ANY(ARRAY[CAST('queued' AS text)
                                                                 , CAST('building' AS text)
                                                                 , CAST('ready' AS text)
                                                                 , CAST('failed' AS text)
                                                                 , CAST('cancelled' AS text)
                                                                 , CAST('expired' AS text)]))
  , CONSTRAINT export_idempotency_complete CHECK ((idempotency_key IS NULL) = (request_hash IS NULL))
  , CONSTRAINT data_exports_id_tenant_id_key UNIQUE (id, tenant_id)
  , CONSTRAINT data_exports_pkey PRIMARY KEY (id)
);

CREATE TABLE data_export_items (
    export_id uuid NOT NULL
  , tenant_id text NOT NULL
  , ordinal integer NOT NULL
  , identity text NOT NULL
  , CONSTRAINT data_export_items_identity_check CHECK (length(identity) >= 1
                                                   AND length(identity) <= 512)
  , CONSTRAINT data_export_items_ordinal_check CHECK (ordinal >= 0 AND ordinal <= 4999)
  , CONSTRAINT data_export_items_export_id_identity_key UNIQUE (export_id, identity)
  , CONSTRAINT data_export_items_pkey PRIMARY KEY (export_id, ordinal)
);

CREATE TABLE data_export_chunks (
    export_id uuid NOT NULL
  , tenant_id text NOT NULL
  , ordinal integer NOT NULL
  , bytes bytea NOT NULL
  , byte_count integer NOT NULL
  , checksum text NOT NULL
  , CONSTRAINT data_export_chunks_bytes_check CHECK (octet_length(bytes) >= 1
                                                 AND octet_length(bytes) <= 262144)
  , CONSTRAINT data_export_chunks_check CHECK (byte_count = octet_length(bytes))
  , CONSTRAINT data_export_chunks_check1 CHECK (checksum = encode(sha256(bytes)
                                                                , CAST('hex' AS text)))
  , CONSTRAINT data_export_chunks_ordinal_check CHECK (ordinal >= 0)
  , CONSTRAINT data_export_chunks_pkey PRIMARY KEY (export_id, ordinal)
);

CREATE TABLE user_source_attempts (
    generation_id uuid NOT NULL
  , scope_id uuid NOT NULL
  , tenant_id text NOT NULL
  , source text NOT NULL
  , status text DEFAULT CAST('running' AS text) NOT NULL
  , error_code text
  , message text
  , observed_count integer
  , report_refresh_date date
  , report_period text DEFAULT CAST('D30' AS text) NOT NULL
  , CONSTRAINT user_source_attempts_error_code_check CHECK (error_code ~ CAST('^[a-z][a-z0-9_]{0,127}$' AS text))
  , CONSTRAINT user_source_attempts_message_check CHECK (length(message) <= 1024)
  , CONSTRAINT user_source_attempts_observed_count_check CHECK (observed_count >= 0
                                                            AND observed_count <= 100000)
  , CONSTRAINT user_source_attempts_report_period_check CHECK (report_period = ANY(ARRAY[CAST('D28' AS text)
                                                                                       , CAST('D30' AS text)]))
  , CONSTRAINT user_source_attempts_source_check CHECK (source = ANY(ARRAY[CAST('directory' AS text)
                                                                         , CAST('app_activity' AS text)]))
  , CONSTRAINT user_source_attempts_status_check CHECK (status = ANY(ARRAY[CAST('running' AS text)
                                                                         , CAST('available' AS text)
                                                                         , CAST('failed' AS text)
                                                                         , CAST('cancelled' AS text)
                                                                         , CAST('waiting_authorization' AS text)
                                                                         , CAST('permission_required' AS text)]))
  , CONSTRAINT user_source_attempts_pkey PRIMARY KEY (generation_id)
);

CREATE TABLE user_source_queries (
    generation_id uuid NOT NULL
  , scope_id uuid NOT NULL
  , tenant_id text NOT NULL
  , query_key text NOT NULL
  , kind text NOT NULL
  , expected_count integer
  , wire_count integer DEFAULT 0 NOT NULL
  , page_count integer DEFAULT 0 NOT NULL
  , complete boolean DEFAULT FALSE NOT NULL
  , CONSTRAINT user_source_queries_expected_count_check CHECK (expected_count >= 0
                                                           AND expected_count <= 100000)
  , CONSTRAINT user_source_queries_kind_check CHECK (kind = ANY(ARRAY[CAST('catalog' AS text)
                                                                    , CAST('discovery' AS text)
                                                                    , CAST('identity' AS text)
                                                                    , CAST('activity' AS text)]))
  , CONSTRAINT user_source_queries_page_count_check CHECK (page_count >= 0 AND page_count <= 10000)
  , CONSTRAINT user_source_queries_query_key_check CHECK (query_key ~ CAST('^[a-f0-9]{64}$' AS text))
  , CONSTRAINT user_source_queries_wire_count_check CHECK (wire_count >= 0
                                                       AND wire_count <= 5000000)
  , CONSTRAINT user_source_queries_pkey PRIMARY KEY (generation_id, query_key)
);

CREATE TABLE user_source_query_members (
    generation_id uuid NOT NULL
  , query_key text NOT NULL
  , identity text NOT NULL
  , CONSTRAINT user_source_query_members_identity_check CHECK (length(identity) >= 1
                                                           AND length(identity) <= 512)
  , CONSTRAINT user_source_query_members_pkey PRIMARY KEY (generation_id, query_key, identity)
);

CREATE TABLE user_source_skus (
    generation_id uuid NOT NULL
  , scope_id uuid NOT NULL
  , tenant_id text NOT NULL
  , sku_id uuid NOT NULL
  , plan_ids text[] NOT NULL
  , CONSTRAINT user_source_skus_plan_ids_check CHECK (cardinality(plan_ids) <= 3)
  , CONSTRAINT user_source_skus_pkey PRIMARY KEY (generation_id, sku_id)
);

CREATE TABLE user_source_identity_inputs (
    generation_id uuid NOT NULL
  , scope_id uuid NOT NULL
  , tenant_id text NOT NULL
  , identity text NOT NULL
  , checked boolean DEFAULT FALSE NOT NULL
  , CONSTRAINT user_source_identity_inputs_identity_check CHECK (length(identity) >= 1
                                                             AND length(identity) <= 320)
  , CONSTRAINT user_source_identity_inputs_pkey PRIMARY KEY (generation_id, identity)
);

CREATE TABLE user_source_read_contexts (
    selection_id uuid NOT NULL
  , tenant_id text NOT NULL
  , token_mode text NOT NULL
  , metadata jsonb NOT NULL
  , CONSTRAINT user_source_read_contexts_metadata_check CHECK (jsonb_typeof(metadata) = CAST('object' AS text)
                                                           AND octet_length(CAST(metadata AS text)) <= 8192)
  , CONSTRAINT user_source_read_contexts_token_mode_check CHECK (token_mode = ANY(ARRAY[CAST('delegated' AS text)
                                                                                      , CAST('application' AS text)]))
  , CONSTRAINT user_source_read_contexts_pkey PRIMARY KEY (selection_id)
);

CREATE TABLE official_usage_history_state (
    tenant_id text NOT NULL
  , scope_id uuid NOT NULL
  , revision bigint DEFAULT 0 NOT NULL
  , invalidation_epoch bigint DEFAULT 0 NOT NULL
  , CONSTRAINT official_usage_history_state_invalidation_epoch_check CHECK (invalidation_epoch >= 0)
  , CONSTRAINT official_usage_history_state_revision_check CHECK (revision >= 0)
  , CONSTRAINT official_usage_history_state_pkey PRIMARY KEY (tenant_id)
  , CONSTRAINT official_usage_history_state_scope_id_key UNIQUE (scope_id)
);

CREATE TABLE official_usage_history_memberships (
    tenant_id text NOT NULL
  , set_id uuid NOT NULL
  , valid_from_revision bigint NOT NULL
  , valid_to_revision bigint
  , visibility text NOT NULL
  , CONSTRAINT official_usage_history_memberships_check CHECK (valid_to_revision > valid_from_revision)
  , CONSTRAINT official_usage_history_memberships_valid_from_revision_check CHECK (valid_from_revision > 0)
  , CONSTRAINT official_usage_history_memberships_visibility_check CHECK (visibility = ANY(ARRAY[CAST('retained' AS text)
                                                                                               , CAST('superseded' AS text)]))
  , CONSTRAINT official_usage_history_memberships_pkey PRIMARY KEY (tenant_id, set_id, valid_from_revision)
);

CREATE TABLE official_usage_ingestions (
    id uuid NOT NULL
  , tenant_id text NOT NULL
  , principal_id text NOT NULL
  , bundle_id uuid NOT NULL
  , correction_of uuid
  , reject_duplicate_kind boolean DEFAULT FALSE NOT NULL
  , owner uuid NOT NULL
  , session_epoch bigint NOT NULL
  , state text NOT NULL
  , lease_until timestamp with time zone NOT NULL
  , deadline_at timestamp with time zone NOT NULL
  , expires_at timestamp with time zone NOT NULL
  , wire_bytes bigint DEFAULT 0 NOT NULL
  , stored_bytes bigint DEFAULT 0 NOT NULL
  , row_count integer DEFAULT 0 NOT NULL
  , kind text
  , staging_id uuid
  , version_id uuid
  , created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
  , acceptance_revision bigint
  , CONSTRAINT official_usage_ingestions_acceptance_revision_check CHECK (acceptance_revision > 0)
  , CONSTRAINT official_usage_ingestions_kind_check CHECK (kind = ANY(ARRAY[CAST('agents' AS text)
                                                                          , CAST('userAgents' AS text)
                                                                          , CAST('users' AS text)]))
  , CONSTRAINT official_usage_ingestions_row_count_check CHECK (row_count >= 0
                                                            AND row_count <= 1000000)
  , CONSTRAINT official_usage_ingestions_state_check CHECK (state = ANY(ARRAY[CAST('streaming' AS text)
                                                                            , CAST('validating' AS text)
                                                                            , CAST('ready' AS text)
                                                                            , CAST('accepting' AS text)
                                                                            , CAST('accepted' AS text)
                                                                            , CAST('cancelled' AS text)
                                                                            , CAST('failed' AS text)]))
  , CONSTRAINT official_usage_ingestions_stored_bytes_check CHECK (stored_bytes >= 0
                                                               AND stored_bytes <= CAST('8589934592' AS bigint))
  , CONSTRAINT official_usage_ingestions_wire_bytes_check CHECK (wire_bytes >= 0
                                                             AND wire_bytes <= 268435456)
  , CONSTRAINT official_usage_ingestions_id_tenant_id_principal_id_key UNIQUE (id, tenant_id, principal_id)
  , CONSTRAINT official_usage_ingestions_pkey PRIMARY KEY (id)
  , CONSTRAINT official_usage_ingestions_staging_id_key UNIQUE (staging_id)
);

CREATE TABLE official_usage_ingestion_rows (
    ingestion_id uuid NOT NULL
  , tenant_id text NOT NULL
  , principal_id text NOT NULL
  , ordinal integer NOT NULL
  , natural_key text NOT NULL
  , payload_hash text NOT NULL
  , row_data jsonb NOT NULL
  , CONSTRAINT official_usage_ingestion_rows_ordinal_check CHECK (ordinal >= 0
                                                              AND ordinal <= 999999)
  , CONSTRAINT official_usage_ingestion_rows_row_data_check CHECK (jsonb_typeof(row_data) = CAST('object' AS text)
                                                               AND octet_length(CAST(row_data AS text)) <= 16384)
  , CONSTRAINT official_usage_ingestion_rows_ingestion_id_natural_key_key UNIQUE (ingestion_id, natural_key)
  , CONSTRAINT official_usage_ingestion_rows_pkey PRIMARY KEY (ingestion_id, ordinal)
);

CREATE TABLE official_usage_read_contexts (
    selection_id uuid NOT NULL
  , tenant_id text NOT NULL
  , token_mode text NOT NULL
  , metadata jsonb NOT NULL
  , report_metadata jsonb NOT NULL
  , set_id uuid
  , history_revision bigint NOT NULL
  , history_epoch bigint NOT NULL
  , CONSTRAINT official_usage_read_contexts_metadata_check CHECK (octet_length(CAST(metadata AS text)) <= 32768)
  , CONSTRAINT official_usage_read_contexts_report_metadata_check CHECK (octet_length(CAST(report_metadata AS text)) <= 32768)
  , CONSTRAINT official_usage_read_contexts_token_mode_check CHECK (token_mode = ANY(ARRAY[CAST('delegated' AS text)
                                                                                         , CAST('application' AS text)]))
  , CONSTRAINT official_usage_read_contexts_pkey PRIMARY KEY (selection_id)
);

CREATE TABLE inventory_attempts (
    generation_id uuid NOT NULL
  , scope_id uuid NOT NULL
  , tenant_id text NOT NULL
  , domain text NOT NULL
  , mode text NOT NULL
  , channel text NOT NULL
  , baseline_id uuid
  , base_revision bigint NOT NULL
  , read_started_at timestamp with time zone NOT NULL
  , environment_id text
  , resource_types text[] DEFAULT CAST('{}' AS text[]) NOT NULL
  , exact_targets text[] DEFAULT CAST('{}' AS text[]) NOT NULL
  , expected_count integer
  , complete boolean DEFAULT FALSE NOT NULL
  , target_job_id uuid
  , role_scope text DEFAULT CAST('unknown' AS text) NOT NULL
  , omitted_fields integer DEFAULT 0 NOT NULL
  , membership_prepared boolean DEFAULT FALSE NOT NULL
  , prepared_changed_count integer
  , CONSTRAINT inventory_attempts_base_revision_check CHECK (base_revision >= 0)
  , CONSTRAINT inventory_attempts_channel_check CHECK (channel = ANY(ARRAY[CAST('catalog' AS text)
                                                                         , CAST('exact' AS text)
                                                                         , CAST('detail' AS text)
                                                                         , CAST('control' AS text)
                                                                         , CAST('canonical' AS text)]))
  , CONSTRAINT inventory_attempts_check1 CHECK (domain = CAST('canonical' AS text)
                                             OR expected_count <= 100000)
  , CONSTRAINT inventory_attempts_check2 CHECK (domain <> CAST('power_platform' AS text)
                                             OR (cardinality(resource_types) > 0
                                             AND resource_types <@ ARRAY[CAST('microsoft.copilotstudio/agents' AS text)
                                                                       , CAST('microsoft.powerplatform/environments' AS text)]))
  , CONSTRAINT inventory_attempts_domain_check CHECK (domain = ANY(ARRAY[CAST('packages' AS text)
                                                                       , CAST('power_platform' AS text)
                                                                       , CAST('canonical' AS text)]))
  , CONSTRAINT inventory_attempts_exact_targets_check CHECK (cardinality(exact_targets) <= 100)
  , CONSTRAINT inventory_attempts_expected_count_check CHECK (expected_count >= 0
                                                          AND expected_count <= 200000)
  , CONSTRAINT inventory_attempts_mode_check CHECK (mode = ANY(ARRAY[CAST('baseline' AS text)
                                                                   , CAST('delta' AS text)
                                                                   , CAST('compact' AS text)]))
  , CONSTRAINT inventory_attempts_omitted_fields_check CHECK (omitted_fields >= 0)
  , CONSTRAINT inventory_attempts_prepared_changed_count_check CHECK (prepared_changed_count >= 0
                                                                  AND prepared_changed_count <= 200000)
  , CONSTRAINT inventory_attempts_role_scope_check CHECK (role_scope = ANY(ARRAY[CAST('full' AS text)
                                                                               , CAST('ai' AS text)
                                                                               , CAST('unknown' AS text)]))
  , CONSTRAINT inventory_exact_target_source CHECK (domain = CAST('canonical' AS text)
                                                 OR mode <> CAST('delta' AS text)
                                                 OR cardinality(exact_targets) > 0
                                                 OR target_job_id IS NOT NULL)
  , CONSTRAINT inventory_preparation_complete CHECK (membership_prepared = (prepared_changed_count IS NOT NULL))
  , CONSTRAINT inventory_attempts_pkey PRIMARY KEY (generation_id)
);

CREATE TABLE inventory_roots (
    baseline_id uuid NOT NULL
  , scope_id uuid NOT NULL
  , tenant_id text NOT NULL
  , domain text NOT NULL
  , first_revision bigint NOT NULL
  , revision bigint NOT NULL
  , row_count integer NOT NULL
  , current boolean DEFAULT TRUE NOT NULL
  , collected_before bigint DEFAULT 0 NOT NULL
  , observation_epoch bigint NOT NULL
  , catalog_observed_at timestamp with time zone
  , catalog_expires_at timestamp with time zone
  , catalog_complete boolean DEFAULT FALSE NOT NULL
  , catalog_page_count integer DEFAULT 0 NOT NULL
  , catalog_omitted_fields integer DEFAULT 0 NOT NULL
  , CONSTRAINT inventory_roots_catalog_omitted_fields_check CHECK (catalog_omitted_fields >= 0)
  , CONSTRAINT inventory_roots_catalog_page_count_check CHECK (catalog_page_count >= 0
                                                           AND catalog_page_count <= 10000)
  , CONSTRAINT inventory_roots_check CHECK (domain = CAST('canonical' AS text)
                                         OR row_count <= 100000)
  , CONSTRAINT inventory_roots_check1 CHECK (NOT catalog_complete
                                          OR (catalog_observed_at IS NOT NULL
                                          AND catalog_expires_at IS NOT NULL))
  , CONSTRAINT inventory_roots_check2 CHECK (revision >= first_revision
                                         AND collected_before <= revision)
  , CONSTRAINT inventory_roots_domain_check CHECK (domain = ANY(ARRAY[CAST('packages' AS text)
                                                                    , CAST('power_platform' AS text)
                                                                    , CAST('canonical' AS text)]))
  , CONSTRAINT inventory_roots_observation_epoch_check CHECK (observation_epoch >= 0)
  , CONSTRAINT inventory_roots_row_count_check CHECK (row_count >= 0 AND row_count <= 200000)
  , CONSTRAINT inventory_roots_baseline_id_scope_id_tenant_id_key UNIQUE (baseline_id, scope_id, tenant_id)
  , CONSTRAINT inventory_roots_pkey PRIMARY KEY (baseline_id)
);

CREATE TABLE inventory_keys (
    generation_id uuid NOT NULL
  , scope_id uuid NOT NULL
  , tenant_id text NOT NULL
  , identity text COLLATE pg_catalog."C" NOT NULL
  , schema_version integer NOT NULL
  , content_hash text NOT NULL
  , deleted boolean DEFAULT FALSE NOT NULL
  , CONSTRAINT inventory_keys_content_hash_check CHECK (content_hash ~ CAST('^[a-f0-9]{64}$' AS text))
  , CONSTRAINT inventory_keys_identity_check CHECK (length(identity) >= 1
                                                AND length(identity) <= 512)
  , CONSTRAINT inventory_keys_schema_version_check CHECK (schema_version = 1)
  , CONSTRAINT inventory_keys_generation_id_scope_id_tenant_id_identity_key UNIQUE (generation_id, scope_id, tenant_id, identity)
  , CONSTRAINT inventory_keys_pkey PRIMARY KEY (generation_id, identity)
);

CREATE TABLE package_record_rows (
    generation_id uuid NOT NULL
  , scope_id uuid NOT NULL
  , tenant_id text NOT NULL
  , identity text NOT NULL
  , schema_version integer NOT NULL
  , content_hash text NOT NULL
  , display_name text NOT NULL
  , sort_key text NOT NULL
  , native_id text NOT NULL
  , environment_id text
  , resource_type text
  , publisher text
  , modified_at timestamp with time zone
  , observed_at timestamp with time zone NOT NULL
  , expires_at timestamp with time zone NOT NULL
  , read_started_at timestamp with time zone NOT NULL
  , catalog_generation uuid
  , detail_generation uuid
  , control_generation uuid
  , residual jsonb NOT NULL
  , identity_expires_at timestamp with time zone
  , presence text
  , link_state text
  , availability text
  , management text
  , CONSTRAINT package_record_rows_classification CHECK (num_nonnulls(presence, link_state, availability, management) = 4
                                                     AND presence = CAST('graph_packages' AS text)
                                                     AND link_state = ANY(ARRAY[CAST('matched' AS text)
                                                                              , CAST('unmatched' AS text)
                                                                              , CAST('ambiguous' AS text)
                                                                              , CAST('conflicting' AS text)])
                                                     AND availability = ANY(ARRAY[CAST('available' AS text)
                                                                                , CAST('unavailable' AS text)
                                                                                , CAST('unknown' AS text)])
                                                     AND management = ANY(ARRAY[CAST('user_managed' AS text)
                                                                              , CAST('organization_managed' AS text)
                                                                              , CAST('unknown' AS text)]))
  , CONSTRAINT package_record_rows_content_hash_check CHECK (content_hash ~ CAST('^[a-f0-9]{64}$' AS text))
  , CONSTRAINT package_record_rows_display_name_check CHECK (length(display_name) <= 512)
  , CONSTRAINT package_record_rows_native_id_check CHECK (length(native_id) <= 512)
  , CONSTRAINT package_record_rows_residual_check CHECK (jsonb_typeof(residual) = CAST('object' AS text)
                                                     AND octet_length(CAST(residual AS text)) <= 262144)
  , CONSTRAINT package_record_rows_schema_version_check CHECK (schema_version = 1)
  , CONSTRAINT package_record_rows_pkey PRIMARY KEY (generation_id, identity)
);

CREATE TABLE power_platform_record_rows (
    generation_id uuid NOT NULL
  , scope_id uuid NOT NULL
  , tenant_id text NOT NULL
  , identity text NOT NULL
  , schema_version integer NOT NULL
  , content_hash text NOT NULL
  , display_name text NOT NULL
  , sort_key text NOT NULL
  , native_id text NOT NULL
  , environment_id text
  , resource_type text
  , publisher text
  , modified_at timestamp with time zone
  , observed_at timestamp with time zone NOT NULL
  , expires_at timestamp with time zone NOT NULL
  , read_started_at timestamp with time zone NOT NULL
  , catalog_generation uuid
  , detail_generation uuid
  , control_generation uuid
  , residual jsonb NOT NULL
  , identity_expires_at timestamp with time zone
  , presence text
  , link_state text
  , availability text
  , management text
  , CONSTRAINT power_platform_record_rows_classification CHECK ((num_nonnulls(presence, link_state, availability, management) = 4
                                                             AND presence = CAST('power_platform' AS text)
                                                             AND link_state = ANY(ARRAY[CAST('matched' AS text)
                                                                                      , CAST('unmatched' AS text)
                                                                                      , CAST('ambiguous' AS text)
                                                                                      , CAST('conflicting' AS text)])
                                                             AND availability = ANY(ARRAY[CAST('available' AS text)
                                                                                        , CAST('unavailable' AS text)
                                                                                        , CAST('unknown' AS text)])
                                                             AND management = ANY(ARRAY[CAST('user_managed' AS text)
                                                                                      , CAST('organization_managed' AS text)
                                                                                      , CAST('unknown' AS text)]))
                                                             OR (resource_type = CAST('microsoft.powerplatform/environments' AS text)
                                                             AND num_nonnulls(presence, link_state, availability, management) = 0))
  , CONSTRAINT power_platform_record_rows_content_hash_check CHECK (content_hash ~ CAST('^[a-f0-9]{64}$' AS text))
  , CONSTRAINT power_platform_record_rows_display_name_check CHECK (length(display_name) <= 512)
  , CONSTRAINT power_platform_record_rows_native_id_check CHECK (length(native_id) <= 512)
  , CONSTRAINT power_platform_record_rows_residual_check CHECK (jsonb_typeof(residual) = CAST('object' AS text)
                                                            AND octet_length(CAST(residual AS text)) <= 262144)
  , CONSTRAINT power_platform_record_rows_schema_version_check CHECK (schema_version = 1)
  , CONSTRAINT power_platform_record_rows_pkey PRIMARY KEY (generation_id, identity)
);

CREATE TABLE unified_agent_rows (
    generation_id uuid NOT NULL
  , scope_id uuid NOT NULL
  , tenant_id text NOT NULL
  , identity text NOT NULL
  , schema_version integer NOT NULL
  , content_hash text NOT NULL
  , display_name text NOT NULL
  , sort_key text NOT NULL
  , native_id text NOT NULL
  , environment_id text
  , resource_type text
  , publisher text
  , modified_at timestamp with time zone
  , observed_at timestamp with time zone NOT NULL
  , expires_at timestamp with time zone NOT NULL
  , read_started_at timestamp with time zone NOT NULL
  , catalog_generation uuid
  , detail_generation uuid
  , control_generation uuid
  , residual jsonb NOT NULL
  , identity_expires_at timestamp with time zone
  , presence text
  , link_state text
  , availability text
  , management text
  , CONSTRAINT unified_agent_rows_classification CHECK (num_nonnulls(presence, link_state, availability, management) = 4
                                                    AND presence = ANY(ARRAY[CAST('graph_packages' AS text)
                                                                           , CAST('power_platform' AS text)
                                                                           , CAST('both' AS text)])
                                                    AND link_state = ANY(ARRAY[CAST('matched' AS text)
                                                                             , CAST('unmatched' AS text)
                                                                             , CAST('ambiguous' AS text)
                                                                             , CAST('conflicting' AS text)])
                                                    AND availability = ANY(ARRAY[CAST('available' AS text)
                                                                               , CAST('unavailable' AS text)
                                                                               , CAST('unknown' AS text)])
                                                    AND management = ANY(ARRAY[CAST('user_managed' AS text)
                                                                             , CAST('organization_managed' AS text)
                                                                             , CAST('unknown' AS text)]))
  , CONSTRAINT unified_agent_rows_content_hash_check CHECK (content_hash ~ CAST('^[a-f0-9]{64}$' AS text))
  , CONSTRAINT unified_agent_rows_display_name_check CHECK (length(display_name) <= 512)
  , CONSTRAINT unified_agent_rows_native_id_check CHECK (length(native_id) <= 512)
  , CONSTRAINT unified_agent_rows_residual_check CHECK (jsonb_typeof(residual) = CAST('object' AS text)
                                                    AND octet_length(CAST(residual AS text)) <= 262144)
  , CONSTRAINT unified_agent_rows_schema_version_check CHECK (schema_version = 1)
  , CONSTRAINT unified_agent_rows_pkey PRIMARY KEY (generation_id, identity)
);

CREATE TABLE inventory_exact_heads (
    scope_id uuid NOT NULL
  , tenant_id text NOT NULL
  , observation_epoch bigint NOT NULL
  , identity text NOT NULL
  , generation_id uuid NOT NULL
  , read_started_at timestamp with time zone NOT NULL
  , CONSTRAINT inventory_exact_heads_observation_epoch_check CHECK (observation_epoch >= 0)
  , CONSTRAINT inventory_exact_heads_pkey PRIMARY KEY (scope_id, observation_epoch, identity)
);

CREATE TABLE inventory_facts (
    generation_id uuid NOT NULL
  , scope_id uuid NOT NULL
  , tenant_id text NOT NULL
  , identity text NOT NULL
  , schema_version integer NOT NULL
  , ordinal integer NOT NULL
  , kind text NOT NULL
  , value text NOT NULL
  , text_value text
  , number_value numeric
  , boolean_value boolean
  , payload jsonb DEFAULT CAST('{}' AS jsonb) NOT NULL
  , CONSTRAINT inventory_facts_check CHECK (kind !~~ CAST('match:%' AS text)
                                         OR octet_length(value) <= 256)
  , CONSTRAINT inventory_facts_kind_check CHECK (length(kind) <= 64)
  , CONSTRAINT inventory_facts_ordinal_check CHECK (ordinal >= 0 AND ordinal <= 9999)
  , CONSTRAINT inventory_facts_payload_check CHECK (octet_length(CAST(payload AS text)) <= 262144)
  , CONSTRAINT inventory_facts_schema_version_check CHECK (schema_version = 1)
  , CONSTRAINT inventory_facts_text_value_check CHECK (octet_length(text_value) <= 262144)
  , CONSTRAINT inventory_facts_value_check CHECK (length(value) <= 4096)
  , CONSTRAINT inventory_facts_pkey PRIMARY KEY (generation_id, identity, ordinal)
);

CREATE TABLE inventory_memberships (
    baseline_id uuid NOT NULL
  , scope_id uuid NOT NULL
  , tenant_id text NOT NULL
  , identity text NOT NULL
  , valid_from_revision bigint NOT NULL
  , valid_to_revision bigint
  , generation_id uuid NOT NULL
  , CONSTRAINT inventory_memberships_check CHECK (valid_to_revision IS NULL
                                               OR valid_to_revision > valid_from_revision)
  , CONSTRAINT inventory_memberships_pkey PRIMARY KEY (baseline_id, identity, valid_from_revision)
);

CREATE TABLE inventory_revisions (
    scope_id uuid NOT NULL
  , tenant_id text NOT NULL
  , revision bigint NOT NULL
  , baseline_id uuid NOT NULL
  , generation_id uuid NOT NULL
  , row_count integer NOT NULL
  , inputs jsonb DEFAULT CAST('[]' AS jsonb) NOT NULL
  , CONSTRAINT inventory_revisions_inputs_check CHECK (jsonb_typeof(inputs) = CAST('array' AS text)
                                                   AND jsonb_array_length(inputs) <= 16
                                                   AND octet_length(CAST(inputs AS text)) <= 16384)
  , CONSTRAINT inventory_revisions_row_count_check CHECK (row_count >= 0 AND row_count <= 200000)
  , CONSTRAINT inventory_revisions_pkey PRIMARY KEY (scope_id, revision)
);

CREATE TABLE inventory_compaction_refs (
    generation_id uuid NOT NULL
  , scope_id uuid NOT NULL
  , tenant_id text NOT NULL
  , identity text NOT NULL
  , source_generation_id uuid NOT NULL
  , schema_version integer NOT NULL
  , CONSTRAINT inventory_compaction_refs_schema_version_check CHECK (schema_version = 1)
  , CONSTRAINT inventory_compaction_refs_pkey PRIMARY KEY (generation_id, identity)
);

CREATE TABLE inventory_canonical_ids (
    id uuid NOT NULL
  , scope_id uuid NOT NULL
  , tenant_id text NOT NULL
  , created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
  , CONSTRAINT inventory_canonical_ids_pkey PRIMARY KEY (id)
);

CREATE TABLE inventory_changes (
    scope_id uuid NOT NULL
  , tenant_id text NOT NULL
  , revision bigint NOT NULL
  , identity text NOT NULL
  , CONSTRAINT inventory_changes_pkey PRIMARY KEY (scope_id, revision, identity)
);

CREATE TABLE inventory_pages (
    generation_id uuid NOT NULL
  , scope_id uuid NOT NULL
  , tenant_id text NOT NULL
  , ordinal integer NOT NULL
  , token_hash text NOT NULL
  , next_hash text
  , raw_count integer
  , unique_count integer
  , expected_count integer
  , accepted boolean DEFAULT FALSE NOT NULL
  , CONSTRAINT inventory_pages_check CHECK (raw_count >= 0
                                        AND raw_count <= 5000000
                                        AND (unique_count >= 0 AND unique_count <= 100000))
  , CONSTRAINT inventory_pages_expected_count_check CHECK (expected_count >= 0
                                                       AND expected_count <= 100000)
  , CONSTRAINT inventory_pages_ordinal_check CHECK (ordinal >= 1 AND ordinal <= 10000)
  , CONSTRAINT inventory_pages_generation_id_token_hash_key UNIQUE (generation_id, token_hash)
  , CONSTRAINT inventory_pages_pkey PRIMARY KEY (generation_id, ordinal)
);

CREATE TABLE inventory_worker_pins (
    worker_id uuid NOT NULL
  , scope_id uuid NOT NULL
  , tenant_id text NOT NULL
  , baseline_id uuid NOT NULL
  , revision bigint NOT NULL
  , epoch bigint NOT NULL
  , expires_at timestamp with time zone NOT NULL
  , CONSTRAINT inventory_worker_pins_pkey PRIMARY KEY (worker_id, scope_id)
);

CREATE TABLE inventory_reconciliation (
    scope_id uuid NOT NULL
  , tenant_id text NOT NULL
  , active_id uuid
  , active_inputs jsonb
  , active_epoch bigint
  , active_deadline timestamp with time zone
  , active_until timestamp with time zone
  , pending_inputs jsonb
  , pending_deadline timestamp with time zone
  , published_inputs jsonb
  , pending_sequence bigint DEFAULT 0 NOT NULL
  , published_sequence bigint DEFAULT 0 NOT NULL
  , active_sequence bigint
  , status text DEFAULT CAST('idle' AS text) NOT NULL
  , CONSTRAINT inventory_reconciliation_check CHECK (octet_length(CAST(active_inputs AS text)) <= 16384
                                                 AND octet_length(CAST(pending_inputs AS text)) <= 16384)
  , CONSTRAINT inventory_reconciliation_check1 CHECK (pending_inputs IS NULL
                                                   OR pending_deadline IS NOT NULL)
  , CONSTRAINT inventory_reconciliation_status_check CHECK (status = ANY(ARRAY[CAST('idle' AS text)
                                                                             , CAST('running' AS text)
                                                                             , CAST('catching_up' AS text)
                                                                             , CAST('failed' AS text)]))
  , CONSTRAINT inventory_reconciliation_pkey PRIMARY KEY (scope_id)
);

CREATE TABLE inventory_reconciliation_keys (
    scope_id uuid NOT NULL
  , sequence bigint NOT NULL
  , source_scope_id uuid NOT NULL
  , identity text NOT NULL
  , CONSTRAINT inventory_reconciliation_keys_pkey PRIMARY KEY (scope_id, sequence, source_scope_id, identity)
);

CREATE TABLE inventory_frontier (
    worker_id uuid NOT NULL
  , source_scope_id uuid NOT NULL
  , identity text NOT NULL
  , component text
  , expanded boolean DEFAULT FALSE NOT NULL
  , CONSTRAINT inventory_frontier_pkey PRIMARY KEY (worker_id, source_scope_id, identity)
);

CREATE TABLE inventory_candidate_edges (
    worker_id uuid NOT NULL
  , left_scope uuid NOT NULL
  , left_id text NOT NULL
  , right_scope uuid NOT NULL
  , right_id text NOT NULL
  , CONSTRAINT inventory_candidate_edges_pkey PRIMARY KEY (worker_id, left_scope, left_id, right_scope, right_id)
);

CREATE TABLE unified_agent_memberships (
    generation_id uuid NOT NULL
  , scope_id uuid NOT NULL
  , tenant_id text NOT NULL
  , identity text NOT NULL
  , schema_version integer NOT NULL
  , source_scope_id uuid NOT NULL
  , source_identity text NOT NULL
  , source_generation_id uuid NOT NULL
  , evidence jsonb NOT NULL
  , CONSTRAINT unified_agent_memberships_evidence_check CHECK (octet_length(CAST(evidence AS text)) <= 16384)
  , CONSTRAINT unified_agent_memberships_schema_version_check CHECK (schema_version = 1)
  , CONSTRAINT unified_agent_memberships_pkey PRIMARY KEY (generation_id, identity, source_scope_id, source_identity)
);

CREATE TABLE inventory_read_contexts (
    selection_id uuid NOT NULL
  , tenant_id text NOT NULL
  , report_context jsonb NOT NULL
  , association_revision bigint NOT NULL
  , root_scope_id uuid NOT NULL
  , query_values jsonb NOT NULL
  , CONSTRAINT inventory_read_contexts_query_values_check CHECK (jsonb_typeof(query_values) = CAST('object' AS text)
                                                             AND octet_length(CAST(query_values AS text)) <= 65536)
  , CONSTRAINT inventory_read_contexts_report_context_check CHECK (octet_length(CAST(report_context AS text)) <= 16384)
  , CONSTRAINT inventory_read_contexts_pkey PRIMARY KEY (selection_id)
);

CREATE TABLE inventory_refresh_targets (
    job_id uuid NOT NULL
  , ordinal integer NOT NULL
  , target_id text NOT NULL
  , catalog_revision_hash text
  , CONSTRAINT inventory_refresh_targets_catalog_revision_hash_check CHECK (catalog_revision_hash IS NULL
                                                                         OR catalog_revision_hash ~ CAST('^[a-f0-9]{64}$' AS text))
  , CONSTRAINT inventory_refresh_targets_ordinal_check CHECK (ordinal >= 0 AND ordinal <= 4999)
  , CONSTRAINT inventory_refresh_targets_target_id_check CHECK (length(target_id) >= 1
                                                            AND length(target_id) <= 512)
  , CONSTRAINT inventory_refresh_targets_job_id_target_id_key UNIQUE (job_id, target_id)
  , CONSTRAINT inventory_refresh_targets_pkey PRIMARY KEY (job_id, ordinal)
);

CREATE TABLE inventory_control_pending (
    tenant_id text NOT NULL
  , principal_id text NOT NULL
  , target_id text NOT NULL
  , observation_id uuid NOT NULL
  , updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
  , CONSTRAINT inventory_control_pending_target_id_check CHECK (length(target_id) >= 1
                                                            AND length(target_id) <= 512)
  , CONSTRAINT inventory_control_pending_pkey PRIMARY KEY (tenant_id, principal_id, target_id)
);

CREATE TABLE inventory_mutation_stages (
    id uuid NOT NULL
  , tenant_id text NOT NULL
  , principal_id text NOT NULL
  , authorization_hash text NOT NULL
  , selection_id uuid NOT NULL
  , intent jsonb NOT NULL
  , target_count integer DEFAULT 0 NOT NULL
  , confirmation_hash text
  , request_hash text
  , summary jsonb
  , job_id uuid
  , created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
  , expires_at timestamp with time zone NOT NULL
  , target_filter_hash text DEFAULT repeat(CAST('0' AS text), 64) NOT NULL
  , CONSTRAINT inventory_mutation_stages_confirmation_hash_check CHECK (confirmation_hash ~ CAST('^[a-f0-9]{64}$' AS text))
  , CONSTRAINT inventory_mutation_stages_intent_check CHECK (octet_length(CAST(intent AS text)) <= 65536)
  , CONSTRAINT inventory_mutation_stages_request_hash_check CHECK (request_hash ~ CAST('^[a-f0-9]{64}$' AS text))
  , CONSTRAINT inventory_mutation_stages_summary_check CHECK (octet_length(CAST(summary AS text)) <= 524288)
  , CONSTRAINT inventory_mutation_stages_target_count_check CHECK (target_count >= 0
                                                               AND target_count <= 5000)
  , CONSTRAINT inventory_mutation_stages_target_filter_hash_check CHECK (target_filter_hash ~ CAST('^[a-f0-9]{64}$' AS text))
  , CONSTRAINT inventory_mutation_stages_pkey PRIMARY KEY (id)
);

CREATE TABLE inventory_mutation_targets (
    stage_id uuid NOT NULL
  , ordinal integer NOT NULL
  , target_id text NOT NULL
  , display_name text NOT NULL
  , source_generation_id uuid NOT NULL
  , source_identity text NOT NULL
  , prestate jsonb NOT NULL
  , prestate_hash text NOT NULL
  , agent_id uuid NOT NULL
  , authority_expires_at timestamp with time zone NOT NULL
  , CONSTRAINT inventory_mutation_targets_display_name_check CHECK (length(display_name) >= 1
                                                                AND length(display_name) <= 256)
  , CONSTRAINT inventory_mutation_targets_ordinal_check CHECK (ordinal >= 0 AND ordinal <= 4999)
  , CONSTRAINT inventory_mutation_targets_prestate_check CHECK (octet_length(CAST(prestate AS text)) <= 65500)
  , CONSTRAINT inventory_mutation_targets_prestate_hash_check CHECK (prestate_hash ~ CAST('^[a-f0-9]{64}$' AS text))
  , CONSTRAINT inventory_mutation_targets_target_id_check CHECK (length(target_id) >= 1
                                                             AND length(target_id) <= 512)
  , CONSTRAINT inventory_mutation_targets_pkey PRIMARY KEY (stage_id, target_id)
  , CONSTRAINT inventory_mutation_targets_stage_id_ordinal_key UNIQUE (stage_id, ordinal)
);

CREATE TABLE inventory_native_control_pending (
    tenant_id text NOT NULL
  , principal_id text NOT NULL
  , scope_id uuid NOT NULL
  , identity text NOT NULL
  , observation_id uuid NOT NULL
  , updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
  , CONSTRAINT inventory_native_control_pending_pkey PRIMARY KEY (scope_id, identity)
);

CREATE TABLE inventory_people_revisions (
    tenant_id text NOT NULL
  , principal_id text NOT NULL
  , revision bigint DEFAULT 1 NOT NULL
  , CONSTRAINT inventory_people_revisions_principal_id_check CHECK (length(principal_id) >= 1
                                                                AND length(principal_id) <= 256)
  , CONSTRAINT inventory_people_revisions_revision_check CHECK (revision > 0)
  , CONSTRAINT inventory_people_revisions_tenant_id_check CHECK (length(tenant_id) >= 1
                                                             AND length(tenant_id) <= 256)
  , CONSTRAINT inventory_people_revisions_pkey PRIMARY KEY (tenant_id, principal_id)
);

CREATE TABLE data_lifecycle_progress (
    worker text NOT NULL
  , cursor jsonb DEFAULT CAST('{}' AS jsonb) NOT NULL
  , slices bigint DEFAULT 0 NOT NULL
  , rows_collected bigint DEFAULT 0 NOT NULL
  , bytes_collected bigint DEFAULT 0 NOT NULL
  , updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
  , CONSTRAINT data_lifecycle_progress_bytes_collected_check CHECK (bytes_collected >= 0)
  , CONSTRAINT data_lifecycle_progress_cursor_check CHECK (octet_length(CAST(cursor AS text)) <= 4096)
  , CONSTRAINT data_lifecycle_progress_rows_collected_check CHECK (rows_collected >= 0)
  , CONSTRAINT data_lifecycle_progress_slices_check CHECK (slices >= 0)
  , CONSTRAINT data_lifecycle_progress_worker_check CHECK (worker = ANY(ARRAY[CAST('records' AS text)
                                                                            , CAST('inventory' AS text)
                                                                            , CAST('inventory_metadata' AS text)
                                                                            , CAST('operator' AS text)
                                                                            , CAST('report_payloads' AS text)
                                                                            , CAST('report_staging' AS text)]))
  , CONSTRAINT data_lifecycle_progress_pkey PRIMARY KEY (worker)
);

CREATE TABLE inventory_collection_progress (
    scope_id uuid NOT NULL
  , tenant_id text NOT NULL
  , after_generation uuid
  , after_identity text
  , after_inclusive boolean DEFAULT FALSE NOT NULL
  , CONSTRAINT inventory_collection_progress_after_identity_check CHECK (after_identity IS NULL
                                                                      OR (length(after_identity) >= 1
                                                                      AND length(after_identity) <= 512))
  , CONSTRAINT inventory_collection_progress_check CHECK ((after_generation IS NULL) = (after_identity IS NULL))
  , CONSTRAINT inventory_collection_progress_check1 CHECK (NOT after_inclusive
                                                        OR after_generation IS NOT NULL)
  , CONSTRAINT inventory_collection_progress_pkey PRIMARY KEY (scope_id)
);

CREATE TABLE data_generation_charges (
    scope_id uuid NOT NULL
  , tenant_id text NOT NULL
  , generation_bytes bigint NOT NULL
  , CONSTRAINT data_generation_charges_generation_bytes_check CHECK (generation_bytes >= 0)
  , CONSTRAINT data_generation_charges_pkey PRIMARY KEY (scope_id)
);

CREATE TABLE official_usage_membership_counts (
    version_id uuid NOT NULL
  , tenant_id text NOT NULL
  , kind text NOT NULL
  , row_count bigint NOT NULL
  , CONSTRAINT official_usage_membership_counts_row_count_check CHECK (row_count >= 0
                                                                   AND row_count <= 1000000)
  , CONSTRAINT official_usage_membership_counts_pkey PRIMARY KEY (version_id)
);

CREATE VIEW audit_projection
  AS SELECT DISTINCT ON (tenant_id, principal_id, event_id) id
                                                          , event_id
                                                          , operation_id
                                                          , tenant_id
                                                          , principal_id
                                                          , actor_username
                                                          , actor_name
                                                          , scope
                                                          , action
                                                          , target_blocked_state
                                                          , agent_id
                                                          , agent_display_name
                                                          , started_at
                                                          , observed_at
                                                          , completed_at
                                                          , status
                                                          , message
                                                          , error_code
                                                          , request_path
                                                          , metadata
     FROM public.audit_events
     ORDER BY tenant_id
            , principal_id
            , event_id
            , observed_at DESC
            , status <> CAST('started' AS text) DESC
            , id DESC;

CREATE VIEW inventory_records
  AS (SELECT CAST('packages' AS text) AS domain
           , r.generation_id
           , r.scope_id
           , r.tenant_id
           , r.identity
           , r.schema_version
           , r.content_hash
           , r.display_name
           , r.sort_key
           , r.native_id
           , r.environment_id
           , r.resource_type
           , r.publisher
           , r.modified_at
           , r.observed_at
           , r.expires_at
           , r.read_started_at
           , r.catalog_generation
           , r.detail_generation
           , r.control_generation
           , r.residual
           , r.identity_expires_at
           , r.presence
           , r.link_state
           , r.availability
           , r.management
      FROM public.package_record_rows AS r

      UNION ALL

      SELECT CAST('power_platform' AS text) AS domain
           , r.generation_id
           , r.scope_id
           , r.tenant_id
           , r.identity
           , r.schema_version
           , r.content_hash
           , r.display_name
           , r.sort_key
           , r.native_id
           , r.environment_id
           , r.resource_type
           , r.publisher
           , r.modified_at
           , r.observed_at
           , r.expires_at
           , r.read_started_at
           , r.catalog_generation
           , r.detail_generation
           , r.control_generation
           , r.residual
           , r.identity_expires_at
           , r.presence
           , r.link_state
           , r.availability
           , r.management
      FROM public.power_platform_record_rows AS r)

     UNION ALL

     SELECT CAST('canonical' AS text) AS domain
          , r.generation_id
          , r.scope_id
          , r.tenant_id
          , r.identity
          , r.schema_version
          , r.content_hash
          , r.display_name
          , r.sort_key
          , r.native_id
          , r.environment_id
          , r.resource_type
          , r.publisher
          , r.modified_at
          , r.observed_at
          , r.expires_at
          , r.read_started_at
          , r.catalog_generation
          , r.detail_generation
          , r.control_generation
          , r.residual
          , r.identity_expires_at
          , r.presence
          , r.link_state
          , r.availability
          , r.management
     FROM public.unified_agent_rows AS r;

CREATE VIEW inventory_live_sources
  AS SELECT canonical.identity AS agent_id
          , canonical.generation_id AS control_revision
          , r.tenant_id
          , scope.principal_id
          , scope.id AS canonical_scope_id
          , CASE
              WHEN r.domain = CAST('packages' AS text) THEN CAST('graph_packages' AS text)
              ELSE CAST('power_platform' AS text)
            END AS source
          , r.native_id
          , COALESCE(r.environment_id, CAST('' AS text)) AS environment_id
          , r.identity AS source_identity
          , r.scope_id AS source_scope_id
          , r.generation_id AS source_generation_id
          , CASE
              WHEN r.domain = CAST('power_platform' AS text)
               AND r.native_id ~* CAST('^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' AS text)
                THEN lower(r.native_id)
              ELSE r.native_id
            END AS normalized_native_id
          , CASE
              WHEN r.domain = CAST('packages' AS text) THEN CAST('' AS text)
              ELSE COALESCE(lower(r.environment_id), CAST('' AS text))
            END AS normalized_environment_id
          , CASE
              WHEN r.domain = CAST('packages' AS text) THEN r.generation_id
              ELSE CAST(NULL AS uuid)
            END AS package_snapshot_id
          , CASE
              WHEN r.domain = CAST('power_platform' AS text) THEN r.generation_id
              ELSE CAST(NULL AS uuid)
            END AS power_platform_snapshot_id
          , r.read_started_at AS updated_at
          , r.expires_at
          , LEAST(canonical.identity_expires_at
                , generation.expires_at
                , canonical.expires_at
                , r.expires_at
                , source_generation.expires_at
                , (SELECT min(input."expiresAt") AS min
                   FROM jsonb_to_recordset(revision.inputs) AS input("expiresAt" timestamp with time zone))) AS authority_expires_at
     FROM public.data_scope_epochs AS scope
          INNER JOIN public.inventory_roots AS root ON root.scope_id = scope.id AND root.current
          INNER JOIN public.inventory_revisions AS revision ON revision.scope_id = root.scope_id
                                                           AND revision.revision = root.revision
          INNER JOIN public.data_generations AS generation ON generation.id = revision.generation_id
          INNER JOIN public.data_principal_epochs AS principal ON principal.tenant_id = scope.tenant_id
                                                              AND principal.principal_id = scope.principal_id
          INNER JOIN public.inventory_memberships AS membership ON membership.baseline_id = root.baseline_id
                                                               AND membership.valid_from_revision <= root.revision
                                                               AND (membership.valid_to_revision IS NULL
                                                                 OR membership.valid_to_revision > root.revision)
          INNER JOIN public.unified_agent_rows AS canonical ON canonical.generation_id = membership.generation_id
                                                           AND canonical.identity = membership.identity
          INNER JOIN public.unified_agent_memberships AS member ON member.generation_id = canonical.generation_id
                                                               AND member.identity = canonical.identity
          INNER JOIN public.inventory_records AS r ON r.generation_id = member.source_generation_id
                                                  AND r.identity = member.source_identity
          INNER JOIN public.data_scope_epochs AS source_scope ON source_scope.id = r.scope_id
          INNER JOIN public.data_generations AS source_generation ON source_generation.id = r.generation_id
     WHERE scope.source = CAST('inventory_canonical' AS text)
       AND scope.token_mode = CAST('delegated' AS text)
       AND scope.selector = CAST('complete' AS text)
       AND generation.scope_epoch = scope.epoch
       AND generation.session_epoch = principal.epoch
       AND generation.session_epoch = scope.session_epoch
       AND generation.state = CAST('published' AS text)
       AND generation.validated
       AND generation.expires_at > clock_timestamp()
       AND canonical.expires_at > clock_timestamp()
       AND r.expires_at > clock_timestamp()
       AND source_scope.tenant_id = scope.tenant_id
       AND source_scope.principal_id = scope.principal_id
       AND source_scope.token_mode = CAST('delegated' AS text)
       AND source_generation.session_epoch = source_scope.session_epoch
       AND source_generation.state = ANY(ARRAY[CAST('published' AS text), CAST('retired' AS text)])
       AND source_generation.validated
       AND source_generation.expires_at > clock_timestamp()
       AND NOT EXISTS (SELECT 1
                       FROM public.inventory_control_pending AS pending
                       WHERE pending.tenant_id = scope.tenant_id
                         AND pending.principal_id = scope.principal_id)
       AND NOT EXISTS (SELECT 1
                       FROM public.inventory_reconciliation AS work
                       WHERE work.scope_id = scope.id
                         AND (work.status <> CAST('idle' AS text)
                           OR work.pending_inputs IS NOT NULL))
       AND NOT EXISTS (SELECT 1
                       FROM jsonb_to_recordset(revision.inputs) AS input("scopeId" uuid
                                                                       , "baselineId" uuid
                                                                       , revision bigint
                                                                       , epoch bigint
                                                                       , "expiresAt" timestamp with time zone)
                            LEFT JOIN public.inventory_roots AS current ON current.scope_id = input."scopeId"
                                                                       AND current.current
                            LEFT JOIN public.data_scope_epochs AS epoch ON epoch.id = input."scopeId"
                       WHERE current.baseline_id IS DISTINCT FROM input."baselineId"
                          OR current.revision IS DISTINCT FROM input.revision
                          OR epoch.epoch IS DISTINCT FROM input.epoch
                          OR input."expiresAt" <= clock_timestamp())
       AND NOT EXISTS (SELECT 1
                       FROM public.inventory_roots AS candidate
                            INNER JOIN public.data_scope_epochs AS cs ON cs.id = candidate.scope_id
                            INNER JOIN public.inventory_revisions AS cv ON cv.scope_id = candidate.scope_id
                                                                       AND cv.revision = candidate.revision
                            INNER JOIN public.data_generations AS cg ON cg.id = cv.generation_id
                       WHERE candidate.current
                         AND candidate.tenant_id = scope.tenant_id
                         AND cs.principal_id = scope.principal_id
                         AND cs.token_mode = CAST('delegated' AS text)
                         AND candidate.domain = ANY(ARRAY[CAST('packages' AS text)
                                                        , CAST('power_platform' AS text)])
                         AND cg.scope_epoch = cs.epoch
                         AND cg.session_epoch = cs.session_epoch
                         AND cg.expires_at > clock_timestamp()
                         AND NOT EXISTS (SELECT 1
                                         FROM jsonb_to_recordset(revision.inputs) AS input("scopeId" uuid)
                                         WHERE input."scopeId" = candidate.scope_id));

CREATE FUNCTION protect_job_intent()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.tenant_id,NEW.principal_id,NEW.token_mode,NEW.capability,NEW.action,NEW.request_hash,NEW.idempotency_key,NEW.access_update,NEW.confirmation_hash,NEW.confirmation_summary,NEW.confirmed_at,NEW.reassign_user_id,NEW.created_at,NEW.deadline_at,NEW.expires_at)
    IS DISTINCT FROM (OLD.tenant_id,OLD.principal_id,OLD.token_mode,OLD.capability,OLD.action,OLD.request_hash,OLD.idempotency_key,OLD.access_update,OLD.confirmation_hash,OLD.confirmation_summary,OLD.confirmed_at,OLD.reassign_user_id,OLD.created_at,OLD.deadline_at,OLD.expires_at)
  THEN RAISE EXCEPTION 'job intent is immutable'; END IF;
  RETURN NEW;
END$$;

CREATE FUNCTION protect_item_target()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.job_id,NEW.target_id,NEW.display_name,NEW.ordinal,NEW.prestate_hash,NEW.prestate)
    IS DISTINCT FROM (OLD.job_id,OLD.target_id,OLD.display_name,OLD.ordinal,OLD.prestate_hash,OLD.prestate)
  THEN RAISE EXCEPTION 'item target is immutable'; END IF;
  RETURN NEW;
END$$;

CREATE FUNCTION protect_official_usage_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.id,NEW.tenant_id,NEW.artifact_id,NEW.staging_id,NEW.kind,NEW.content_hash,
      NEW.reporting_start,NEW.reporting_end,NEW.period_provenance,NEW.source_as_of,
      NEW.source_as_of_provenance,NEW.source_freshness,NEW.downloaded_at,NEW.row_count,
      NEW.warnings,NEW.reconciliation,NEW.accepted_by,NEW.supersedes_version_id,NEW.accepted_at)
    IS DISTINCT FROM
     (OLD.id,OLD.tenant_id,OLD.artifact_id,OLD.staging_id,OLD.kind,OLD.content_hash,
      OLD.reporting_start,OLD.reporting_end,OLD.period_provenance,OLD.source_as_of,
      OLD.source_as_of_provenance,OLD.source_freshness,OLD.downloaded_at,OLD.row_count,
      OLD.warnings,OLD.reconciliation,OLD.accepted_by,OLD.supersedes_version_id,OLD.accepted_at)
  THEN RAISE EXCEPTION 'official usage version is immutable'; END IF;
  RETURN NEW;
END$$;

CREATE FUNCTION protect_official_usage_staging()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_user<>'agentcontrol_app' THEN RETURN NEW; END IF;
  IF (NEW.id,NEW.tenant_id,NEW.actor_principal_id,NEW.revision,NEW.kind,NEW.file_hash,NEW.content_hash,
      NEW.parser_version,NEW.schema_version,NEW.bundle_id,NEW.correction_of_set_id,NEW.reporting_start,
      NEW.reporting_end,NEW.period_provenance,NEW.source_as_of,NEW.source_as_of_provenance,
      NEW.source_freshness,NEW.downloaded_at,NEW.row_count,NEW.stored_bytes,NEW.warnings,
      NEW.reconciliation,NEW.active_revision,NEW.created_at,NEW.expires_at)
    IS DISTINCT FROM
     (OLD.id,OLD.tenant_id,OLD.actor_principal_id,OLD.revision,OLD.kind,OLD.file_hash,OLD.content_hash,
      OLD.parser_version,OLD.schema_version,OLD.bundle_id,OLD.correction_of_set_id,OLD.reporting_start,
      OLD.reporting_end,OLD.period_provenance,OLD.source_as_of,OLD.source_as_of_provenance,
      OLD.source_freshness,OLD.downloaded_at,OLD.row_count,OLD.stored_bytes,OLD.warnings,
      OLD.reconciliation,OLD.active_revision,OLD.created_at,OLD.expires_at)
  THEN RAISE EXCEPTION 'official usage staging intent is immutable'; END IF;
  IF OLD.status<>'active' OR NEW.status NOT IN ('accepted','replaced','expired','cancelled')
  THEN RAISE EXCEPTION 'official usage staging transition is invalid'; END IF;
  IF NEW.status='accepted' THEN
    IF NEW.accepted_version_id IS NULL OR NEW.accepted_set_id IS NULL OR NEW.accepted_at IS NULL
      OR NEW.accepted_result_revision IS NULL
    THEN RAISE EXCEPTION 'official usage acceptance receipt is incomplete'; END IF;
  ELSIF (NEW.accepted_version_id,NEW.accepted_set_id,NEW.accepted_at,NEW.accepted_result_revision)
    IS DISTINCT FROM (OLD.accepted_version_id,OLD.accepted_set_id,OLD.accepted_at,OLD.accepted_result_revision)
  THEN RAISE EXCEPTION 'official usage staging receipt is invalid'; END IF;
  RETURN NEW;
END$$;

CREATE FUNCTION protect_official_usage_artifact()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_user<>'agentcontrol_app' THEN RETURN NEW; END IF;
  IF (NEW.id,NEW.tenant_id,NEW.kind,NEW.file_hash,NEW.parser_version,NEW.schema_version,NEW.first_accepted_at)
    IS DISTINCT FROM (OLD.id,OLD.tenant_id,OLD.kind,OLD.file_hash,OLD.parser_version,OLD.schema_version,OLD.first_accepted_at)
    OR NEW.expires_at<OLD.expires_at
  THEN RAISE EXCEPTION 'official usage artifact is immutable'; END IF;
  RETURN NEW;
END$$;

CREATE FUNCTION protect_official_usage_set()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_user<>'agentcontrol_app' THEN RETURN NEW; END IF;
  IF (NEW.id,NEW.tenant_id,NEW.bundle_id,NEW.actor_principal_id,NEW.period_provenance,
      NEW.supersedes_set_id,NEW.created_at,NEW.expires_at)
    IS DISTINCT FROM
     (OLD.id,OLD.tenant_id,OLD.bundle_id,OLD.actor_principal_id,OLD.period_provenance,
      OLD.supersedes_set_id,OLD.created_at,OLD.expires_at)
  THEN RAISE EXCEPTION 'official usage set identity is immutable'; END IF;
  IF OLD.complete AND (NEW.reporting_start,NEW.reporting_end,NEW.content_hash)
    IS DISTINCT FROM (OLD.reporting_start,OLD.reporting_end,OLD.content_hash)
  THEN RAISE EXCEPTION 'official usage complete set observation is immutable'; END IF;
  IF NOT OLD.complete AND (
    (OLD.reporting_start IS NOT NULL AND (NEW.reporting_start IS NULL OR NEW.reporting_start>OLD.reporting_start))
    OR (OLD.reporting_end IS NOT NULL AND (NEW.reporting_end IS NULL OR NEW.reporting_end<OLD.reporting_end)))
  THEN RAISE EXCEPTION 'official usage set activity range cannot narrow'; END IF;
  IF NOT OLD.complete AND NEW.content_hash IS NOT NULL AND NOT NEW.complete
  THEN RAISE EXCEPTION 'official usage incomplete set cannot have a content hash'; END IF;
  IF NEW.complete AND NEW.content_hash IS NULL
  THEN RAISE EXCEPTION 'official usage set completion requires a content hash'; END IF;
  IF OLD.complete AND (NOT NEW.complete OR NEW.accepted_at IS DISTINCT FROM OLD.accepted_at)
  THEN RAISE EXCEPTION 'official usage set completion is immutable'; END IF;
  IF NOT OLD.complete AND NEW.complete AND NEW.accepted_at IS NULL
  THEN RAISE EXCEPTION 'official usage set completion requires acceptance time'; END IF;
  IF NOT OLD.complete AND NOT NEW.complete AND NEW.accepted_at IS DISTINCT FROM OLD.accepted_at
  THEN RAISE EXCEPTION 'official usage incomplete set cannot have acceptance time'; END IF;
  IF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at
  THEN RAISE EXCEPTION 'official usage set deletion is immutable'; END IF;
  RETURN NEW;
END$$;

CREATE FUNCTION protect_official_usage_membership()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE parent_deleted timestamptz; parent_complete boolean;
BEGIN
  IF current_user<>'agentcontrol_app' THEN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END IF;
  IF TG_OP='INSERT' THEN
    SELECT deleted_at,complete INTO parent_deleted,parent_complete FROM official_usage_sets
      WHERE id=NEW.set_id AND tenant_id=NEW.tenant_id;
    IF parent_deleted IS NOT NULL OR parent_complete
    THEN RAISE EXCEPTION 'official usage complete or deleted set membership is immutable'; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'official usage set membership is immutable'; END IF;
  SELECT deleted_at INTO parent_deleted FROM official_usage_sets
    WHERE id=OLD.set_id AND tenant_id=OLD.tenant_id;
  IF parent_deleted IS NULL THEN RAISE EXCEPTION 'official usage live set membership is immutable'; END IF;
  RETURN OLD;
END$$;

CREATE FUNCTION protect_official_usage_version_row()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE parent_deleted timestamptz; parent_published boolean;
BEGIN
  IF current_user<>'agentcontrol_app' THEN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END IF;
  IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'official usage accepted row is immutable'; END IF;
  IF TG_OP='DELETE' THEN
    SELECT deleted_at INTO parent_deleted FROM official_usage_versions WHERE id=OLD.version_id;
    IF parent_deleted IS NULL THEN RAISE EXCEPTION 'official usage live accepted row is immutable'; END IF;
    RETURN OLD;
  END IF;
  SELECT version.deleted_at,EXISTS(SELECT 1 FROM official_usage_set_versions membership WHERE membership.version_id=version.id)
    INTO parent_deleted,parent_published FROM official_usage_versions version WHERE version.id=NEW.version_id;
  IF parent_deleted IS NOT NULL OR parent_published
  THEN RAISE EXCEPTION 'official usage published or deleted version cannot receive rows'; END IF;
  RETURN NEW;
END$$;

CREATE FUNCTION protect_official_usage_state()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE live_kinds integer;
BEGIN
  IF current_user<>'agentcontrol_app' THEN RETURN NEW; END IF;
  IF NEW.tenant_id<>OLD.tenant_id OR NEW.revision<>OLD.revision+1 OR NEW.updated_at<OLD.updated_at
  THEN RAISE EXCEPTION 'official usage selection revision is invalid'; END IF;
  IF NEW.active_set_id IS NOT NULL THEN
    SELECT count(*) INTO live_kinds FROM official_usage_sets report_set
      JOIN official_usage_set_versions membership ON membership.set_id=report_set.id
        AND membership.tenant_id=report_set.tenant_id
      JOIN official_usage_versions version ON version.id=membership.version_id
        AND version.tenant_id=membership.tenant_id AND version.kind=membership.kind
      WHERE report_set.id=NEW.active_set_id AND report_set.tenant_id=NEW.tenant_id
        AND report_set.complete AND report_set.deleted_at IS NULL AND version.deleted_at IS NULL;
    IF live_kinds<>3 THEN RAISE EXCEPTION 'official usage selection requires three live report kinds'; END IF;
  END IF;
  RETURN NEW;
END$$;

CREATE FUNCTION protect_copilot_quarantine_job_intent()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.id,NEW.tenant_id,NEW.principal_id,NEW.idempotency_key,NEW.request_hash,NEW.action,NEW.confirmation_hash,
      NEW.confirmation_summary,NEW.actor_name,NEW.actor_username,NEW.request_path,NEW.contract_revision,
      NEW.permission_revision,NEW.configuration_revision,NEW.is_canary,NEW.canary_approval_id,NEW.created_at,NEW.deadline_at,NEW.expires_at)
    IS DISTINCT FROM
     (OLD.id,OLD.tenant_id,OLD.principal_id,OLD.idempotency_key,OLD.request_hash,OLD.action,OLD.confirmation_hash,
      OLD.confirmation_summary,OLD.actor_name,OLD.actor_username,OLD.request_path,OLD.contract_revision,
      OLD.permission_revision,OLD.configuration_revision,OLD.is_canary,OLD.canary_approval_id,OLD.created_at,OLD.deadline_at,OLD.expires_at)
  THEN RAISE EXCEPTION 'quarantine job intent is immutable'; END IF;
  RETURN NEW;
END$$;

CREATE FUNCTION protect_copilot_quarantine_item_target()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.id,NEW.job_id,NEW.ordinal,NEW.resource_native_id,NEW.display_name,NEW.snapshot_id,NEW.inventory_observed_at,
      NEW.environment_id,NEW.bot_id,NEW.prestate,NEW.prestate_provider_updated_at,NEW.requested_state)
    IS DISTINCT FROM
     (OLD.id,OLD.job_id,OLD.ordinal,OLD.resource_native_id,OLD.display_name,OLD.snapshot_id,OLD.inventory_observed_at,
      OLD.environment_id,OLD.bot_id,OLD.prestate,OLD.prestate_provider_updated_at,OLD.requested_state)
  THEN RAISE EXCEPTION 'quarantine item target is immutable'; END IF;
  RETURN NEW;
END$$;

CREATE FUNCTION protect_official_usage_row_fact()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_user='agentcontrol_app' AND TG_OP<>'INSERT'
  THEN RAISE EXCEPTION 'official usage row fact is immutable'; END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END$$;

CREATE FUNCTION protect_data_sync_run_intent()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.id,NEW.tenant_id,NEW.principal_id,NEW.mode,NEW.source_ids,NEW.request_hash,NEW.started_at,NEW.expires_at,NEW.clear_saved_data,NEW.automatic)
    IS DISTINCT FROM
     (OLD.id,OLD.tenant_id,OLD.principal_id,OLD.mode,OLD.source_ids,OLD.request_hash,OLD.started_at,OLD.expires_at,OLD.clear_saved_data,OLD.automatic)
  THEN RAISE EXCEPTION 'data sync run intent is immutable'; END IF;
  RETURN NEW;
END$$;

CREATE FUNCTION protect_data_sync_source_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.run_id,NEW.tenant_id,NEW.principal_id,NEW.source_id)
    IS DISTINCT FROM (OLD.run_id,OLD.tenant_id,OLD.principal_id,OLD.source_id)
  THEN RAISE EXCEPTION 'data sync source identity is immutable'; END IF;
  RETURN NEW;
END$$;

CREATE FUNCTION clear_admitted_data_sync_snapshots()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $$
DECLARE source_scope record; removed integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('data-sync:'||NEW.tenant_id||':'||NEW.principal_id,0));
  PERFORM pg_advisory_xact_lock(hashtextextended('package-refresh:'||NEW.tenant_id||':'||NEW.principal_id,0));
  PERFORM pg_advisory_xact_lock(hashtextextended('power-platform:'||NEW.tenant_id||':'||NEW.principal_id,0));
  IF EXISTS(SELECT 1 FROM public.package_refresh_jobs WHERE tenant_id=NEW.tenant_id AND principal_id=NEW.principal_id
    AND status IN ('waiting_authorization','running') AND expires_at>clock_timestamp() AND deadline_at>clock_timestamp())
    OR EXISTS(SELECT 1 FROM public.power_platform_refresh_jobs WHERE tenant_id=NEW.tenant_id AND principal_id=NEW.principal_id
    AND status IN ('waiting_authorization','running') AND expires_at>clock_timestamp() AND deadline_at>clock_timestamp())
  THEN RAISE EXCEPTION USING ERRCODE='PDS01',
    MESSAGE='Finish or cancel active Graph package and Power Platform refresh jobs before clearing saved data.'; END IF;
  FOR source_scope IN SELECT id,source FROM public.data_scope_epochs WHERE tenant_id=NEW.tenant_id AND principal_id=NEW.principal_id
    AND source IN ('directory','app_activity','user_sources','agent_people','inventory_packages','inventory_power_platform','inventory_canonical')
    ORDER BY id FOR UPDATE
  LOOP
    PERFORM scope_id FROM public.data_generation_heads WHERE scope_id=source_scope.id FOR UPDATE;
    UPDATE public.data_scope_epochs SET epoch=epoch+1 WHERE id=source_scope.id;
    UPDATE public.data_generations SET state='cancelled',cancellation=cancellation+1,reserved_bytes=byte_count
      WHERE scope_id=source_scope.id AND state IN ('staging','validating');
    UPDATE public.data_generations SET state='retired' WHERE scope_id=source_scope.id AND state='published';
    IF source_scope.source IN ('inventory_packages','inventory_power_platform','inventory_canonical') THEN
      UPDATE public.inventory_roots SET current=false WHERE scope_id=source_scope.id AND current;
      UPDATE public.data_generation_heads SET generation_id=NULL,revision=revision+1 WHERE scope_id=source_scope.id AND generation_id IS NOT NULL;
      UPDATE public.inventory_reconciliation SET active_id=NULL,active_inputs=NULL,active_until=NULL,active_deadline=NULL,
        active_epoch=NULL,active_sequence=NULL,pending_inputs=NULL,pending_deadline=NULL,published_inputs=NULL,
        published_sequence=pending_sequence,status='idle' WHERE scope_id=source_scope.id;
    ELSE
      DELETE FROM public.data_generation_heads WHERE scope_id=source_scope.id;
    END IF;
  END LOOP;
  LOOP
    DELETE FROM public.inventory_native_control_pending WHERE (scope_id,identity) IN (
      SELECT scope_id,identity FROM public.inventory_native_control_pending
      WHERE tenant_id=NEW.tenant_id AND principal_id=NEW.principal_id ORDER BY scope_id,identity LIMIT 250);
    GET DIAGNOSTICS removed=ROW_COUNT;
    EXIT WHEN removed=0;
  END LOOP;
  DELETE FROM public.package_inventory_snapshots WHERE tenant_id=NEW.tenant_id AND principal_id=NEW.principal_id;
  DELETE FROM public.data_sync_success_markers WHERE tenant_id=NEW.tenant_id AND principal_id=NEW.principal_id
    AND source_id IN ('users','graph_packages','power_platform');
  RETURN NEW;
END$$;

CREATE FUNCTION protect_agent_usage_association()
RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('data-sync:'||NEW.tenant_id||':'||NEW.reviewed_by,0));
  IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'reviewed usage associations are immutable; remove before reassignment'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.official_usage_state state
    JOIN public.official_usage_sets report_set ON report_set.id=state.active_set_id AND report_set.tenant_id=state.tenant_id
    JOIN public.official_usage_set_versions membership ON membership.set_id=report_set.id
      AND membership.tenant_id=report_set.tenant_id AND membership.kind='agents'
    JOIN public.official_usage_versions version ON version.id=membership.version_id
      AND version.tenant_id=membership.tenant_id AND version.kind=membership.kind
    JOIN public.official_usage_artifacts artifact ON artifact.id=version.artifact_id
      AND artifact.tenant_id=version.tenant_id AND artifact.kind=version.kind
    JOIN public.official_usage_version_rows row ON row.version_id=version.id
      AND row.tenant_id=version.tenant_id AND row.kind=version.kind
    JOIN public.official_usage_row_facts fact ON fact.tenant_id=row.tenant_id
      AND fact.kind=row.kind AND fact.payload_hash=row.payload_hash
    WHERE state.tenant_id=NEW.tenant_id AND report_set.id=NEW.report_set_id
      AND report_set.complete AND report_set.deleted_at IS NULL
      AND (report_set.expires_at IS NULL OR report_set.expires_at>clock_timestamp())
      AND version.deleted_at IS NULL AND (version.expires_at IS NULL OR version.expires_at>clock_timestamp())
      AND (artifact.expires_at IS NULL OR artifact.expires_at>clock_timestamp())
      AND fact.row_data->>'agentId'=NEW.report_agent_id
  ) THEN RAISE EXCEPTION 'usage association requires an agent in the active accepted Agents export'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.data_scope_epochs scope
    JOIN public.inventory_roots root ON root.scope_id=scope.id AND root.current
    JOIN public.inventory_revisions revision ON revision.scope_id=root.scope_id AND revision.revision=root.revision
    JOIN public.data_generations generation ON generation.id=revision.generation_id
    JOIN public.data_principal_epochs principal ON principal.tenant_id=scope.tenant_id AND principal.principal_id=scope.principal_id
    JOIN public.inventory_memberships membership ON membership.baseline_id=root.baseline_id
      AND membership.valid_from_revision<=root.revision AND (membership.valid_to_revision IS NULL OR membership.valid_to_revision>root.revision)
    JOIN public.unified_agent_rows canonical ON canonical.generation_id=membership.generation_id AND canonical.identity=membership.identity
    JOIN public.unified_agent_memberships member ON member.generation_id=canonical.generation_id AND member.identity=canonical.identity
    JOIN public.inventory_records r ON r.generation_id=member.source_generation_id AND r.identity=member.source_identity
    JOIN public.data_scope_epochs source_scope ON source_scope.id=r.scope_id
    JOIN public.data_generations source_generation ON source_generation.id=r.generation_id
    WHERE scope.tenant_id=NEW.tenant_id AND scope.principal_id=NEW.reviewed_by
      AND scope.source='inventory_canonical' AND scope.token_mode='delegated' AND scope.selector='complete'
      AND generation.scope_epoch=scope.epoch AND generation.session_epoch=scope.session_epoch AND generation.session_epoch=principal.epoch
      AND generation.state='published' AND generation.validated AND generation.expires_at>clock_timestamp()
      AND canonical.expires_at>clock_timestamp() AND r.expires_at>clock_timestamp()
      AND source_scope.tenant_id=scope.tenant_id AND source_scope.principal_id=scope.principal_id AND source_scope.token_mode='delegated'
      AND source_generation.session_epoch=source_scope.session_epoch
      AND source_generation.state IN ('published','retired') AND source_generation.validated
      AND (NEW.source='graph_packages' AND r.domain='packages' AND r.native_id=NEW.native_id
        OR NEW.source='power_platform' AND r.domain='power_platform' AND r.resource_type='microsoft.copilotstudio/agents'
          AND coalesce(lower(r.environment_id),'')=lower(NEW.environment_id)
          AND CASE WHEN r.native_id ~* '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
            THEN lower(r.native_id)=lower(NEW.native_id) ELSE r.native_id=NEW.native_id END)
      AND NOT EXISTS(SELECT 1 FROM public.inventory_reconciliation work WHERE work.scope_id=scope.id
        AND (work.status<>'idle' OR work.pending_inputs IS NOT NULL))
      AND NOT EXISTS(SELECT 1 FROM jsonb_to_recordset(revision.inputs)
        input("scopeId" uuid,"baselineId" uuid,revision bigint,epoch bigint,"expiresAt" timestamptz)
        LEFT JOIN public.inventory_roots current ON current.scope_id=input."scopeId" AND current.current
        LEFT JOIN public.data_scope_epochs epoch ON epoch.id=input."scopeId"
        WHERE current.baseline_id IS DISTINCT FROM input."baselineId" OR current.revision IS DISTINCT FROM input.revision
          OR epoch.epoch IS DISTINCT FROM input.epoch OR input."expiresAt"<=clock_timestamp())
      AND NOT EXISTS(SELECT 1 FROM public.inventory_roots candidate JOIN public.data_scope_epochs cs ON cs.id=candidate.scope_id
        JOIN public.inventory_revisions cv ON cv.scope_id=candidate.scope_id AND cv.revision=candidate.revision
        JOIN public.data_generations cg ON cg.id=cv.generation_id
        WHERE candidate.current AND candidate.tenant_id=scope.tenant_id AND cs.principal_id=scope.principal_id
          AND cs.token_mode='delegated' AND candidate.domain IN ('packages','power_platform')
          AND cg.scope_epoch=cs.epoch AND cg.session_epoch=cs.session_epoch AND cg.expires_at>clock_timestamp()
          AND NOT EXISTS(SELECT 1 FROM jsonb_to_recordset(revision.inputs) input("scopeId" uuid) WHERE input."scopeId"=candidate.scope_id))
  ) THEN RAISE EXCEPTION 'usage association requires an authorized current native source'; END IF;
  RETURN NEW;
END$$;

CREATE FUNCTION advance_agent_usage_revision()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $$
BEGIN
  INSERT INTO public.agent_usage_state(tenant_id,revision)
    VALUES(CASE WHEN TG_OP='DELETE' THEN OLD.tenant_id ELSE NEW.tenant_id END,1)
    ON CONFLICT(tenant_id) DO UPDATE SET revision=public.agent_usage_state.revision+1;
  RETURN NULL;
END$$;

CREATE FUNCTION delete_agent_usage_report_associations()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $$
BEGIN
  DELETE FROM public.agent_usage_associations WHERE tenant_id=NEW.tenant_id AND report_set_id=NEW.id;
  RETURN NULL;
END$$;

CREATE FUNCTION clear_admitted_agent_people()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('data-sync:'||NEW.tenant_id||':'||NEW.principal_id,0));
  DELETE FROM public.agent_people_cache WHERE tenant_id=NEW.tenant_id AND principal_id=NEW.principal_id;
  RETURN NEW;
END$$;

CREATE FUNCTION clear_admitted_agent_identities()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('data-sync:'||NEW.tenant_id||':'||NEW.principal_id,0));
  DELETE FROM public.agent_identity_cache WHERE tenant_id=NEW.tenant_id AND principal_id=NEW.principal_id;
  RETURN NEW;
END$$;

CREATE FUNCTION data_protect_epoch()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.tenant_id,NEW.principal_id) IS DISTINCT FROM (OLD.tenant_id,OLD.principal_id) OR NEW.epoch<OLD.epoch
  THEN RAISE EXCEPTION 'data_epoch_immutable'; END IF;
  IF TG_TABLE_NAME='data_scope_epochs' THEN
    IF (NEW.id,NEW.scope_kind,NEW.token_mode,NEW.source,NEW.selector)
      IS DISTINCT FROM (OLD.id,OLD.scope_kind,OLD.token_mode,OLD.source,OLD.selector)
      OR NEW.session_epoch<OLD.session_epoch THEN RAISE EXCEPTION 'data_scope_immutable'; END IF;
  END IF;
  RETURN NEW;
END$$;

CREATE FUNCTION data_protect_generation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.id,NEW.scope_id,NEW.tenant_id,NEW.schema_version,NEW.scope_epoch,NEW.session_epoch,
      NEW.expected_revision,NEW.job_id,NEW.run_id,NEW.job_kind,NEW.owner,NEW.lease_version,
      NEW.deadline_at,NEW.created_at,NEW.observed_at,NEW.expires_at)
    IS DISTINCT FROM (OLD.id,OLD.scope_id,OLD.tenant_id,OLD.schema_version,OLD.scope_epoch,OLD.session_epoch,
      OLD.expected_revision,OLD.job_id,OLD.run_id,OLD.job_kind,OLD.owner,OLD.lease_version,
      OLD.deadline_at,OLD.created_at,OLD.observed_at,OLD.expires_at)
  THEN RAISE EXCEPTION 'data_generation_intent_immutable'; END IF;
  IF NEW.state<>OLD.state AND NOT (
    (OLD.state='staging' AND NEW.state IN ('validating','failed','cancelled')) OR
    (OLD.state='validating' AND NEW.state IN ('published','failed','cancelled')) OR
    (OLD.state='published' AND NEW.state='retired') OR
    (OLD.state IN ('retired','failed','cancelled') AND NEW.state='deleting'))
  THEN RAISE EXCEPTION 'data_generation_transition'; END IF;
  IF NEW.lease_until>OLD.lease_until AND (OLD.lease_until<=clock_timestamp()
    OR NEW.lease_until>LEAST(NEW.deadline_at,clock_timestamp()+interval '60 seconds')
    OR NEW.state NOT IN ('staging','validating') OR NEW.cancellation<>0
    OR NOT EXISTS(SELECT 1 FROM data_scope_epochs s WHERE s.id=NEW.scope_id AND s.epoch=NEW.scope_epoch AND s.session_epoch=NEW.session_epoch))
  THEN RAISE EXCEPTION 'data_renewal_fenced'; END IF;
  IF OLD.state IN ('published','retired','deleting') AND
    (NEW.byte_count,NEW.row_count,NEW.child_count,NEW.batch_count,NEW.page_count,NEW.wire_count,NEW.content_hash,NEW.validated,
      NEW.validation_phase,NEW.validation_cursor,NEW.validated_rows,NEW.validated_children)
    IS DISTINCT FROM
    (OLD.byte_count,OLD.row_count,OLD.child_count,OLD.batch_count,OLD.page_count,OLD.wire_count,OLD.content_hash,OLD.validated,
      OLD.validation_phase,OLD.validation_cursor,OLD.validated_rows,OLD.validated_children)
  THEN RAISE EXCEPTION 'data_generation_content_immutable'; END IF;
  IF OLD.collected_at IS NOT NULL AND NEW.collected_at IS DISTINCT FROM OLD.collected_at
  THEN RAISE EXCEPTION 'data_generation_collection_immutable'; END IF;
  IF NEW.collected_at IS NOT NULL AND OLD.collected_at IS NULL AND (
    EXISTS(SELECT 1 FROM directory_user_rows WHERE generation_id=NEW.id)
    OR EXISTS(SELECT 1 FROM directory_service_plan_rows WHERE generation_id=NEW.id)
    OR EXISTS(SELECT 1 FROM app_activity_rows WHERE generation_id=NEW.id)
    OR EXISTS(SELECT 1 FROM data_generation_batches WHERE generation_id=NEW.id)
    OR EXISTS(SELECT 1 FROM data_generation_pages WHERE generation_id=NEW.id)
    OR EXISTS(SELECT 1 FROM user_source_queries WHERE generation_id=NEW.id)
    OR EXISTS(SELECT 1 FROM user_source_query_members WHERE generation_id=NEW.id)
    OR EXISTS(SELECT 1 FROM user_source_skus WHERE generation_id=NEW.id)
    OR EXISTS(SELECT 1 FROM user_source_identity_inputs WHERE generation_id=NEW.id)
    OR EXISTS(SELECT 1 FROM data_generation_pins WHERE generation_id=NEW.id))
  THEN RAISE EXCEPTION 'data_generation_not_collected'; END IF;
  RETURN NEW;
END$$;

CREATE FUNCTION data_protect_head()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.scope_id,NEW.tenant_id) IS DISTINCT FROM (OLD.scope_id,OLD.tenant_id)
    OR NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION 'data_head_fenced'; END IF;
  IF NEW.generation_id IS NULL AND pg_trigger_depth()>1
    AND current_user=(SELECT proowner::regrole::text FROM pg_proc WHERE oid='clear_admitted_data_sync_snapshots'::regproc)
    AND EXISTS(SELECT 1 FROM data_generations g JOIN data_scope_epochs s ON s.id=g.scope_id
      WHERE g.id=OLD.generation_id AND g.scope_id=NEW.scope_id AND g.tenant_id=NEW.tenant_id
        AND g.state='retired' AND s.epoch>g.scope_epoch
        AND s.source IN ('inventory_packages','inventory_power_platform','inventory_canonical'))
    AND NOT EXISTS(SELECT 1 FROM inventory_roots WHERE scope_id=NEW.scope_id AND current)
  THEN RETURN NEW; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM data_generations g JOIN data_scope_epochs s ON s.id=g.scope_id
    WHERE g.id=NEW.generation_id AND g.scope_id=NEW.scope_id AND g.tenant_id=NEW.tenant_id
      AND g.expected_revision=OLD.revision AND g.state='validating' AND g.validated
      AND g.scope_epoch=s.epoch AND g.session_epoch=s.session_epoch AND g.cancellation=0
      AND g.lease_until>clock_timestamp() AND g.deadline_at>clock_timestamp() AND g.expires_at>clock_timestamp())
  THEN RAISE EXCEPTION 'data_head_fenced'; END IF;
  RETURN NEW;
END$$;

CREATE FUNCTION data_protect_record()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE g data_generations;
BEGIN
  IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'data_record_immutable'; END IF;
  SELECT * INTO g FROM data_generations WHERE id=CASE WHEN TG_OP='DELETE' THEN OLD.generation_id ELSE NEW.generation_id END FOR SHARE;
  IF TG_OP='DELETE' THEN
    IF g.state NOT IN ('failed','cancelled','deleting') THEN RAISE EXCEPTION 'data_record_immutable'; END IF;
    RETURN OLD;
  END IF;
  IF g.state<>'staging' OR g.lease_until<=clock_timestamp() OR g.deadline_at<=clock_timestamp() OR g.cancellation<>0
    OR NOT EXISTS(SELECT 1 FROM data_scope_epochs s WHERE s.id=g.scope_id AND s.epoch=g.scope_epoch AND s.session_epoch=g.session_epoch)
  THEN RAISE EXCEPTION 'data_writer_fenced'; END IF;
  IF TG_TABLE_NAME NOT IN ('data_generation_batches','data_generation_pages') THEN
    IF NEW.schema_version<>g.schema_version THEN RAISE EXCEPTION 'data_schema_version'; END IF;
  END IF;
  RETURN NEW;
END$$;

CREATE FUNCTION data_protect_selection()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.id,NEW.tenant_id,NEW.principal_id,NEW.authorization_hash,NEW.session_epoch,NEW.root_count,
      NEW.endpoint,NEW.query_hash,NEW.query_json,NEW.evaluated_at,NEW.revision)
    IS DISTINCT FROM (OLD.id,OLD.tenant_id,OLD.principal_id,OLD.authorization_hash,OLD.session_epoch,OLD.root_count,
      OLD.endpoint,OLD.query_hash,OLD.query_json,OLD.evaluated_at,OLD.revision)
    OR NEW.expires_at>OLD.expires_at OR (OLD.invalidated_at IS NOT NULL AND NEW.invalidated_at IS DISTINCT FROM OLD.invalidated_at)
  THEN RAISE EXCEPTION 'data_selection_immutable'; END IF;
  RETURN NEW;
END$$;

CREATE FUNCTION data_protect_export_intent()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.id,NEW.tenant_id,NEW.principal_id,NEW.selection_id,NEW.query_hash,NEW.kind,NEW.selection_mode,
      NEW.filename,NEW.created_at,NEW.deadline_at)
    IS DISTINCT FROM (OLD.id,OLD.tenant_id,OLD.principal_id,OLD.selection_id,OLD.query_hash,OLD.kind,OLD.selection_mode,
      OLD.filename,OLD.created_at,OLD.deadline_at) OR NEW.expires_at>OLD.expires_at
  THEN RAISE EXCEPTION 'data_export_intent_immutable'; END IF;
  RETURN NEW;
END$$;

CREATE FUNCTION data_protect_chunk()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'data_artifact_immutable'; END IF;
  IF TG_OP='DELETE' THEN
    IF EXISTS(SELECT 1 FROM data_exports WHERE id=OLD.export_id AND status NOT IN ('failed','cancelled','expired'))
    THEN RAISE EXCEPTION 'data_artifact_immutable'; END IF;
    RETURN OLD;
  END IF;
  IF TG_TABLE_NAME='data_export_items' THEN
    IF NOT EXISTS(SELECT 1 FROM data_exports WHERE id=NEW.export_id AND status='queued'
      AND deadline_at>clock_timestamp() AND expires_at>clock_timestamp()) THEN RAISE EXCEPTION 'data_export_fenced'; END IF;
  ELSE
    IF NOT EXISTS(SELECT 1 FROM data_exports WHERE id=NEW.export_id AND status='building'
      AND lease_until>clock_timestamp() AND deadline_at>clock_timestamp() AND expires_at>clock_timestamp())
    THEN RAISE EXCEPTION 'data_export_fenced'; END IF;
  END IF;
  RETURN NEW;
END$$;

CREATE FUNCTION user_source_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE g data_generations;
BEGIN
  SELECT * INTO g FROM data_generations WHERE id=CASE WHEN TG_OP='DELETE' THEN OLD.generation_id ELSE NEW.generation_id END FOR SHARE;
  IF TG_OP='DELETE' THEN
    IF g.state NOT IN ('failed','cancelled','deleting') THEN RAISE EXCEPTION 'user_source_immutable'; END IF;
    RETURN OLD;
  END IF;
  IF TG_OP='UPDATE' AND (NEW.generation_id IS DISTINCT FROM OLD.generation_id
      OR (TG_TABLE_NAME NOT IN ('user_source_attempts','user_source_queries','user_source_identity_inputs')))
    THEN RAISE EXCEPTION 'user_source_immutable'; END IF;
  IF TG_TABLE_NAME='user_source_attempts' AND TG_OP='UPDATE' THEN
    IF (NEW.scope_id,NEW.tenant_id,NEW.source) IS DISTINCT FROM (OLD.scope_id,OLD.tenant_id,OLD.source)
      OR OLD.status<>'running'
      OR (NEW.status='available' AND (g.state<>'published' OR NOT g.validated))
      OR (NEW.status NOT IN ('available','running') AND g.state NOT IN ('failed','cancelled'))
    THEN RAISE EXCEPTION 'user_source_attempt_fenced'; END IF;
    IF NEW.status='running' THEN
      IF (NEW.error_code,NEW.message,NEW.report_refresh_date) IS DISTINCT FROM (OLD.error_code,OLD.message,OLD.report_refresh_date)
        OR NEW.observed_count IS NULL OR NEW.observed_count<coalesce(OLD.observed_count,0)
        THEN RAISE EXCEPTION 'user_source_attempt_fenced'; END IF;
    ELSE RETURN NEW;
    END IF;
  END IF;
  IF g.state<>'staging' OR g.lease_until<=clock_timestamp() OR g.deadline_at<=clock_timestamp()
    OR g.cancellation<>0 OR NOT EXISTS(SELECT 1 FROM data_scope_epochs s
      WHERE s.id=g.scope_id AND s.epoch=g.scope_epoch AND s.session_epoch=g.session_epoch)
    THEN RAISE EXCEPTION 'data_writer_fenced'; END IF;
  IF TG_TABLE_NAME='user_source_queries' AND TG_OP='UPDATE' THEN
    IF ((NEW.scope_id,NEW.tenant_id,NEW.query_key,NEW.kind) IS DISTINCT FROM (OLD.scope_id,OLD.tenant_id,OLD.query_key,OLD.kind)
      OR OLD.complete OR NEW.wire_count<OLD.wire_count OR NEW.page_count<OLD.page_count
      OR OLD.expected_count IS NOT NULL AND NEW.expected_count IS DISTINCT FROM OLD.expected_count)
      THEN RAISE EXCEPTION 'user_source_query_fenced'; END IF;
  END IF;
  IF TG_TABLE_NAME='user_source_identity_inputs' AND TG_OP='UPDATE' THEN
    IF ((NEW.scope_id,NEW.tenant_id,NEW.identity) IS DISTINCT FROM (OLD.scope_id,OLD.tenant_id,OLD.identity) OR OLD.checked OR NOT NEW.checked)
      THEN RAISE EXCEPTION 'user_source_identity_fenced'; END IF;
  END IF;
  RETURN NEW;
END$$;

CREATE FUNCTION official_usage_history_state_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP='UPDATE' AND ((NEW.tenant_id,NEW.scope_id) IS DISTINCT FROM (OLD.tenant_id,OLD.scope_id)
    OR NEW.revision<>OLD.revision+1 OR NEW.invalidation_epoch NOT BETWEEN OLD.invalidation_epoch AND OLD.invalidation_epoch+1)
  THEN RAISE EXCEPTION 'official_history_state_immutable'; END IF;
  IF NOT EXISTS(SELECT 1 FROM data_scope_epochs s WHERE s.id=NEW.scope_id AND s.tenant_id=NEW.tenant_id
    AND s.scope_kind='tenant' AND s.principal_id IS NULL AND s.source='official_history')
  THEN RAISE EXCEPTION 'official_history_scope'; END IF;
  RETURN NEW;
END$$;

CREATE FUNCTION official_usage_history_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE head bigint;
BEGIN
  IF TG_OP='DELETE' THEN
    IF EXISTS(SELECT 1 FROM data_generation_pins p JOIN official_usage_history_state h ON h.scope_id=p.scope_id
      WHERE h.tenant_id=OLD.tenant_id AND p.root_kind='tenant_history' AND p.expires_at>clock_timestamp()
        AND p.revision::bigint>=OLD.valid_from_revision
        AND (OLD.valid_to_revision IS NULL OR p.revision::bigint<OLD.valid_to_revision))
    THEN RAISE EXCEPTION 'official_history_pinned'; END IF;
    IF OLD.valid_to_revision IS NULL THEN RAISE EXCEPTION 'official_history_open'; END IF;
    RETURN OLD;
  END IF;
  SELECT revision INTO head FROM official_usage_history_state WHERE tenant_id=NEW.tenant_id FOR UPDATE;
  IF TG_OP='UPDATE' THEN
    IF (NEW.tenant_id,NEW.set_id,NEW.valid_from_revision,NEW.visibility)
      IS DISTINCT FROM (OLD.tenant_id,OLD.set_id,OLD.valid_from_revision,OLD.visibility)
      OR OLD.valid_to_revision IS NOT NULL OR NEW.valid_to_revision IS NULL OR NEW.valid_to_revision<>head
    THEN RAISE EXCEPTION 'official_history_immutable'; END IF;
  ELSIF NEW.valid_from_revision<>head OR NEW.valid_to_revision IS NOT NULL OR NOT EXISTS(
    SELECT 1 FROM official_usage_sets s WHERE s.id=NEW.set_id AND s.tenant_id=NEW.tenant_id
      AND s.complete AND s.deleted_at IS NULL AND (s.expires_at IS NULL OR s.expires_at>clock_timestamp())
      AND (SELECT count(*) FROM official_usage_set_versions v WHERE v.set_id=s.id AND v.tenant_id=s.tenant_id)=3)
  THEN RAISE EXCEPTION 'official_history_incomplete'; END IF;
  RETURN NEW;
END$$;

CREATE FUNCTION official_usage_ingestion_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE parent official_usage_ingestions; who_epoch bigint;
BEGIN
  IF TG_TABLE_NAME='official_usage_ingestion_rows' THEN
    IF TG_OP='DELETE' THEN
      SELECT * INTO parent FROM official_usage_ingestions WHERE id=OLD.ingestion_id FOR UPDATE;
      IF parent.state NOT IN ('accepted','cancelled','failed') AND parent.expires_at>clock_timestamp()
      THEN RAISE EXCEPTION 'official_upload_rows_immutable'; END IF;
      RETURN OLD;
    END IF;
    SELECT * INTO parent FROM official_usage_ingestions WHERE id=NEW.ingestion_id FOR UPDATE;
    IF parent.state<>'streaming' OR parent.lease_until<=clock_timestamp() OR parent.deadline_at<=clock_timestamp()
      OR NOT EXISTS(SELECT 1 FROM data_principal_epochs p WHERE p.tenant_id=parent.tenant_id
        AND p.principal_id=parent.principal_id AND p.epoch=parent.session_epoch)
    THEN RAISE EXCEPTION 'official_upload_fenced'; END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id,NEW.tenant_id,NEW.principal_id,NEW.bundle_id,NEW.correction_of,NEW.owner,NEW.session_epoch,
      NEW.deadline_at,NEW.expires_at,NEW.reject_duplicate_kind) IS DISTINCT FROM
     (OLD.id,OLD.tenant_id,OLD.principal_id,OLD.bundle_id,OLD.correction_of,OLD.owner,OLD.session_epoch,
      OLD.deadline_at,OLD.expires_at,OLD.reject_duplicate_kind)
  THEN RAISE EXCEPTION 'official_upload_intent'; END IF;
  IF NEW.state<>OLD.state AND NOT (
    OLD.state='streaming' AND NEW.state IN ('validating','cancelled','failed')
    OR OLD.state='validating' AND NEW.state IN ('ready','cancelled','failed')
    OR OLD.state='ready' AND NEW.state IN ('accepting','cancelled','failed')
    OR OLD.state='accepting' AND NEW.state IN ('ready','accepted','cancelled','failed'))
  THEN RAISE EXCEPTION 'official_upload_state'; END IF;
  IF NEW.lease_until>OLD.lease_until AND ((OLD.lease_until<=clock_timestamp() AND NOT (OLD.state='ready' AND NEW.state='accepting'))
    OR NEW.lease_until>LEAST(NEW.deadline_at,clock_timestamp()+interval '60 seconds'))
  THEN RAISE EXCEPTION 'official_upload_fenced'; END IF;
  RETURN NEW;
END$$;

CREATE FUNCTION official_usage_acceptance_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.state='accepted' AND NEW.acceptance_revision IS DISTINCT FROM OLD.acceptance_revision
  THEN RAISE EXCEPTION 'official_acceptance_receipt_immutable'; END IF;
  IF NEW.state IN ('accepting','accepted') AND NEW.acceptance_revision IS NULL
  THEN RAISE EXCEPTION 'official_acceptance_receipt_incomplete'; END IF;
  RETURN NEW;
END$$;

CREATE FUNCTION invalidate_user_people_reads()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $$
DECLARE previous uuid; ids uuid[];
BEGIN
  LOOP
    SELECT array_agg(id ORDER BY id) INTO ids FROM (
      SELECT s.id FROM public.data_scope_epochs s WHERE s.source='user_sources' AND s.selector='complete'
        AND (previous IS NULL OR s.id>previous)
        AND EXISTS(SELECT 1 FROM changed c WHERE c.tenant_id=s.tenant_id AND c.principal_id=s.principal_id)
      ORDER BY s.id LIMIT 250 FOR UPDATE
    ) scopes;
    EXIT WHEN ids IS NULL;
    UPDATE public.data_scope_epochs SET epoch=epoch+1 WHERE id=ANY(ids);
    previous:=ids[array_length(ids,1)];
  END LOOP;
  RETURN NULL;
END$$;

CREATE FUNCTION preserve_user_people_identity()
RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $$
BEGIN
  IF (NEW.tenant_id,NEW.principal_id,NEW.object_id) IS DISTINCT FROM (OLD.tenant_id,OLD.principal_id,OLD.object_id)
  THEN RAISE EXCEPTION 'agent_people_identity_immutable'; END IF;
  RETURN NEW;
END$$;

CREATE FUNCTION data_export_actor_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.actor IS DISTINCT FROM OLD.actor THEN RAISE EXCEPTION 'data_export_actor_immutable'; END IF;
  RETURN NEW;
END$$;

CREATE FUNCTION inventory_exact_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF EXISTS(SELECT 1 FROM inventory_roots r WHERE r.scope_id=OLD.scope_id AND r.current
      AND r.observation_epoch=OLD.observation_epoch
      AND (r.catalog_observed_at IS NULL OR r.catalog_observed_at<OLD.read_started_at))
      THEN RAISE EXCEPTION 'inventory_exact_reachable'; END IF;
    RETURN OLD;
  END IF;
  IF TG_OP='UPDATE' AND ((NEW.scope_id,NEW.tenant_id,NEW.observation_epoch,NEW.identity)
      IS DISTINCT FROM (OLD.scope_id,OLD.tenant_id,OLD.observation_epoch,OLD.identity)
      OR NEW.read_started_at<OLD.read_started_at) THEN RAISE EXCEPTION 'inventory_exact_immutable'; END IF;
  IF NOT EXISTS(SELECT 1 FROM data_generation_heads h JOIN data_generations g ON g.id=h.generation_id
    JOIN inventory_attempts a ON a.generation_id=g.id JOIN inventory_roots r ON r.scope_id=h.scope_id AND r.current
    JOIN data_scope_epochs s ON s.id=g.scope_id
    WHERE h.scope_id=NEW.scope_id AND g.id=NEW.generation_id AND g.state='published' AND g.validated
      AND g.scope_epoch=s.epoch AND g.session_epoch=s.session_epoch AND g.cancellation=0
      AND g.lease_until>clock_timestamp() AND g.deadline_at>clock_timestamp()
      AND a.complete AND a.channel='exact' AND a.read_started_at=NEW.read_started_at
      AND r.observation_epoch=NEW.observation_epoch)
    THEN RAISE EXCEPTION 'inventory_exact_fenced'; END IF;
  RETURN NEW;
END$$;

CREATE FUNCTION inventory_association_revision(p_tenant text)
RETURNS bigint
LANGUAGE sql SECURITY DEFINER SET search_path TO 'pg_catalog', 'public'
AS $$
  SELECT revision FROM public.agent_usage_state WHERE tenant_id=p_tenant FOR SHARE
$$;

CREATE FUNCTION inventory_invalidate_audit_reads()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog', 'public'
AS $$
BEGIN
  UPDATE public.data_read_selections s SET invalidated_at=clock_timestamp()
    WHERE s.endpoint='inventory' AND s.invalidated_at IS NULL AND s.query_json ? 'operationIdPrefix'
      AND EXISTS(SELECT 1 FROM changed a WHERE a.tenant_id=s.tenant_id AND a.principal_id=s.principal_id
        AND a.scope='bulk' AND starts_with(lower(a.operation_id),lower(s.query_json->>'operationIdPrefix'))
        AND a.observed_at<=s.evaluated_at AND a.observed_at>s.evaluated_at-interval '90 days');
  RETURN NULL;
END$$;

CREATE FUNCTION inventory_fence_control_readback()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE source_scope uuid;
BEGIN
  IF NEW.observation_kind NOT IN ('block','access') OR NEW.token_mode<>'delegated' THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('data-sync:'||NEW.tenant_id||':'||NEW.principal_id,0));
  FOR source_scope IN SELECT id FROM public.data_scope_epochs WHERE tenant_id=NEW.tenant_id AND principal_id=NEW.principal_id
    AND token_mode='delegated' AND source='inventory_packages' ORDER BY id FOR UPDATE
  LOOP
    UPDATE public.data_scope_epochs SET epoch=epoch+1 WHERE id=source_scope;
    UPDATE public.data_generations SET state='cancelled',cancellation=cancellation+1,reserved_bytes=byte_count
      WHERE scope_id=source_scope AND state IN ('staging','validating');
  END LOOP;
  INSERT INTO public.inventory_control_pending(tenant_id,principal_id,target_id,observation_id)
    VALUES(NEW.tenant_id,NEW.principal_id,NEW.requested_ids->>0,NEW.id)
    ON CONFLICT(tenant_id,principal_id,target_id) DO UPDATE SET observation_id=EXCLUDED.observation_id,updated_at=clock_timestamp();
  RETURN NEW;
END$$;

CREATE FUNCTION inventory_interval_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NOT EXISTS(SELECT 1 FROM inventory_roots r JOIN data_generation_heads h ON h.scope_id=r.scope_id
      JOIN data_generations g ON g.id=h.generation_id WHERE r.baseline_id=NEW.baseline_id
      AND h.revision=NEW.valid_from_revision AND g.state='published' AND g.validated)
      THEN RAISE EXCEPTION 'inventory_interval_fenced'; END IF;
  ELSIF TG_OP='UPDATE' THEN
    IF OLD.valid_to_revision IS NOT NULL OR NEW.valid_to_revision IS NULL
      OR (to_jsonb(NEW)-'valid_to_revision') IS DISTINCT FROM (to_jsonb(OLD)-'valid_to_revision')
      OR NOT EXISTS(SELECT 1 FROM inventory_roots r JOIN data_generation_heads h ON h.scope_id=r.scope_id
        JOIN data_generations g ON g.id=h.generation_id WHERE r.baseline_id=NEW.baseline_id
        AND h.revision=NEW.valid_to_revision AND g.state='published' AND g.validated)
      THEN RAISE EXCEPTION 'inventory_interval_immutable'; END IF;
  ELSIF TG_OP='DELETE' THEN
    IF EXISTS(SELECT 1 FROM inventory_roots r WHERE r.baseline_id=OLD.baseline_id AND r.current
        AND OLD.valid_to_revision IS NULL)
      OR EXISTS(SELECT 1 FROM data_generation_pins p WHERE p.generation_id=OLD.baseline_id AND p.expires_at>clock_timestamp()
        AND p.revision>=OLD.valid_from_revision AND (OLD.valid_to_revision IS NULL OR p.revision<OLD.valid_to_revision))
      OR EXISTS(SELECT 1 FROM inventory_worker_pins p WHERE p.baseline_id=OLD.baseline_id AND p.expires_at>clock_timestamp()
        AND p.revision>=OLD.valid_from_revision AND (OLD.valid_to_revision IS NULL OR p.revision<OLD.valid_to_revision))
      OR EXISTS(SELECT 1 FROM inventory_revisions v JOIN inventory_roots canonical ON canonical.baseline_id=v.baseline_id
        CROSS JOIN LATERAL jsonb_to_recordset(v.inputs) input("baselineId" uuid,revision bigint,epoch bigint,"expiresAt" timestamptz)
        JOIN data_scope_epochs source ON source.id=OLD.scope_id
        WHERE v.inputs @> jsonb_build_array(jsonb_build_object('baselineId',OLD.baseline_id::text))
          AND input."baselineId"=OLD.baseline_id AND input.epoch=source.epoch AND input."expiresAt">clock_timestamp()
          AND input.revision>=OLD.valid_from_revision AND (OLD.valid_to_revision IS NULL OR input.revision<OLD.valid_to_revision)
          AND (canonical.current AND canonical.revision=v.revision OR EXISTS(SELECT 1 FROM data_generation_pins p
            WHERE p.generation_id=canonical.baseline_id AND p.revision=v.revision AND p.expires_at>clock_timestamp())))
      THEN RAISE EXCEPTION 'inventory_interval_pinned'; END IF;
    RETURN OLD;
  END IF;
  RETURN NEW;
END$$;

CREATE FUNCTION inventory_revision_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM inventory_roots r WHERE r.baseline_id=OLD.baseline_id AND r.current AND r.revision=OLD.revision)
    OR EXISTS(SELECT 1 FROM data_generation_pins p WHERE p.generation_id=OLD.baseline_id AND p.revision=OLD.revision AND p.expires_at>clock_timestamp())
    OR EXISTS(SELECT 1 FROM inventory_worker_pins p WHERE p.baseline_id=OLD.baseline_id AND p.revision=OLD.revision AND p.expires_at>clock_timestamp())
    OR EXISTS(SELECT 1 FROM inventory_revisions v JOIN inventory_roots canonical ON canonical.baseline_id=v.baseline_id
      CROSS JOIN LATERAL jsonb_to_recordset(v.inputs) input("baselineId" uuid,revision bigint,epoch bigint,"expiresAt" timestamptz)
      JOIN data_scope_epochs source ON source.id=OLD.scope_id
      WHERE v.inputs @> jsonb_build_array(jsonb_build_object('baselineId',OLD.baseline_id::text))
        AND input."baselineId"=OLD.baseline_id AND input.revision=OLD.revision AND input.epoch=source.epoch AND input."expiresAt">clock_timestamp()
        AND (canonical.current AND canonical.revision=v.revision OR EXISTS(SELECT 1 FROM data_generation_pins p
          WHERE p.generation_id=canonical.baseline_id AND p.revision=v.revision AND p.expires_at>clock_timestamp())))
    THEN RAISE EXCEPTION 'inventory_revision_pinned'; END IF;
  RETURN OLD;
END$$;

CREATE FUNCTION inventory_reachability_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.state='deleting' AND OLD.state<>'deleting' AND (
    EXISTS(SELECT 1 FROM inventory_memberships WHERE generation_id=NEW.id)
    OR EXISTS(SELECT 1 FROM inventory_roots WHERE baseline_id=NEW.id)
    OR EXISTS(SELECT 1 FROM unified_agent_memberships WHERE source_generation_id=NEW.id)
    OR EXISTS(SELECT 1 FROM inventory_exact_heads WHERE generation_id=NEW.id)
  ) THEN RAISE EXCEPTION 'inventory_generation_reachable'; END IF;
  RETURN NEW;
END$$;

CREATE FUNCTION inventory_content_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE g data_generations;
BEGIN
  IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'data_record_immutable'; END IF;
  SELECT * INTO g FROM data_generations WHERE id=CASE WHEN TG_OP='DELETE' THEN OLD.generation_id ELSE NEW.generation_id END FOR SHARE;
  IF TG_OP='DELETE' THEN
    IF g.state IN ('staging','validating') OR
      EXISTS(SELECT 1 FROM inventory_memberships m WHERE m.generation_id=OLD.generation_id AND m.identity=OLD.identity)
      OR EXISTS(SELECT 1 FROM unified_agent_memberships m WHERE m.source_generation_id=OLD.generation_id AND m.source_identity=OLD.identity)
      OR EXISTS(SELECT 1 FROM inventory_compaction_refs r WHERE r.source_generation_id=OLD.generation_id AND r.identity=OLD.identity)
      OR EXISTS(SELECT 1 FROM inventory_exact_heads h WHERE h.generation_id=OLD.generation_id AND h.identity=OLD.identity)
    THEN RAISE EXCEPTION 'inventory_content_pinned'; END IF;
    RETURN OLD;
  END IF;
  IF g.state<>'staging' OR g.lease_until<=clock_timestamp() OR g.deadline_at<=clock_timestamp() OR g.cancellation<>0
    OR NOT EXISTS(SELECT 1 FROM data_scope_epochs s WHERE s.id=g.scope_id AND s.epoch=g.scope_epoch AND s.session_epoch=g.session_epoch)
    OR EXISTS(SELECT 1 FROM inventory_worker_pins p JOIN data_scope_epochs s ON s.id=p.scope_id WHERE p.worker_id=g.job_id
      AND (p.epoch<>s.epoch OR p.expires_at<=clock_timestamp()))
    THEN RAISE EXCEPTION 'data_writer_fenced'; END IF;
  IF NEW.schema_version<>g.schema_version THEN RAISE EXCEPTION 'data_schema_version'; END IF;
  RETURN NEW;
END$$;

CREATE FUNCTION advance_job_result_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    UPDATE jobs SET result_revision=result_revision+1
      WHERE id IN (SELECT job_id FROM old_results);
  ELSE
    UPDATE jobs SET result_revision=result_revision+1
      WHERE id IN (SELECT job_id FROM new_results);
  END IF;
  RETURN NULL;
END$$;

CREATE FUNCTION fence_inventory_application_configuration()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $$
DECLARE tenant text; capability text; item record;
BEGIN
  tenant:=CASE WHEN TG_OP='DELETE' THEN OLD.tenant_id ELSE NEW.tenant_id END;
  capability:=CASE WHEN TG_OP='DELETE' THEN OLD.capability_id ELSE NEW.capability_id END;
  IF capability<>'graph.package.read.application' THEN RETURN NULL; END IF;
  IF TG_OP='UPDATE' AND (NEW.enabled,NEW.shared_data_scope) IS NOT DISTINCT FROM (OLD.enabled,OLD.shared_data_scope)
    THEN RETURN NULL; END IF;
  FOR item IN SELECT principal_id FROM public.data_scope_epochs WHERE tenant_id=tenant
    AND source='inventory_packages' AND token_mode='application' GROUP BY principal_id ORDER BY principal_id
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('data-sync:'||tenant||':'||item.principal_id,0));
  END LOOP;
  FOR item IN SELECT id FROM public.data_scope_epochs WHERE tenant_id=tenant
    AND source='inventory_packages' AND token_mode='application' ORDER BY id FOR UPDATE
  LOOP
    UPDATE public.data_scope_epochs SET epoch=epoch+1 WHERE id=item.id;
    UPDATE public.data_generations SET state='cancelled',cancellation=cancellation+1,reserved_bytes=byte_count
      WHERE scope_id=item.id AND state IN ('staging','validating');
  END LOOP;
  RETURN NULL;
END$$;

CREATE FUNCTION protect_inventory_identity_cache()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog', 'public', 'pg_temp' SET plan_cache_mode TO 'force_generic_plan'
AS $$
DECLARE resource_identity text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('data-sync:'||NEW.tenant_id||':'||NEW.principal_id,0));
  SELECT source.source_identity INTO resource_identity FROM public.inventory_live_sources source
    WHERE source.tenant_id=NEW.tenant_id AND source.principal_id=NEW.principal_id AND source.source='power_platform'
      AND source.source_generation_id=NEW.snapshot_id AND source.agent_id=substr(NEW.record_id,7)
      AND source.native_id=NEW.native_id AND source.environment_id=NEW.environment_id LIMIT 1;
  IF resource_identity IS NULL THEN RAISE EXCEPTION 'agent_identity_source_changed'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.power_platform_record_rows r
    WHERE r.generation_id=NEW.snapshot_id AND r.identity=resource_identity
      AND r.resource_type='microsoft.copilotstudio/agents' AND r.residual->>'agentKind'='copilot_studio_agent'
      AND r.residual->'provenance'->'entraAgentId'->>'sourceSystem'='power_platform'
      AND r.residual->'provenance'->'entraAgentId'->>'path'='properties.entraAgentId'
      AND EXISTS(SELECT 1 FROM public.inventory_facts f WHERE f.generation_id=r.generation_id AND f.identity=r.identity
        AND f.kind='identifier' AND f.payload->>'kind'='entra_agent_id' AND lower(f.value)=NEW.candidate_id::text)
      AND NOT EXISTS(SELECT 1 FROM public.inventory_facts f WHERE f.generation_id=r.generation_id AND f.identity=r.identity
        AND f.kind='identifier' AND f.payload->>'kind'='entra_agent_id' AND lower(f.value)<>NEW.candidate_id::text))
  THEN RAISE EXCEPTION 'agent_identity_source_changed'; END IF;
  IF EXISTS(WITH candidates AS MATERIALIZED (
    SELECT f.generation_id,f.identity FROM public.inventory_facts f
    JOIN public.data_scope_epochs scope ON scope.id=f.scope_id
    WHERE f.kind='identifier' AND f.payload->>'kind'='entra_agent_id'
      AND md5(lower(f.value))=md5(NEW.candidate_id::text) AND lower(f.value)=NEW.candidate_id::text
      AND scope.tenant_id=NEW.tenant_id AND scope.principal_id=NEW.principal_id
      AND scope.source='inventory_power_platform' AND scope.token_mode='delegated')
    SELECT 1 FROM candidates candidate JOIN public.inventory_live_sources other
      ON other.source_generation_id=candidate.generation_id AND other.source_identity=candidate.identity
    WHERE other.tenant_id=NEW.tenant_id AND other.principal_id=NEW.principal_id AND other.source='power_platform'
      AND other.agent_id<>substr(NEW.record_id,7))
  THEN RAISE EXCEPTION 'agent_identity_source_changed'; END IF;
  RETURN NEW;
END$$;

CREATE FUNCTION inventory_require_control_publication()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog', 'public'
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('data-sync:'||NEW.tenant_id||':'||NEW.reviewed_by,0));
  IF EXISTS(SELECT 1 FROM public.inventory_control_pending WHERE tenant_id=NEW.tenant_id AND principal_id=NEW.reviewed_by)
    THEN RAISE EXCEPTION 'inventory control publication pending'; END IF;
  RETURN NEW;
END$$;

CREATE FUNCTION protect_inventory_mutation_stage()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.confirmation_hash IS NOT NULL AND (to_jsonb(NEW)-'job_id') IS DISTINCT FROM (to_jsonb(OLD)-'job_id')
    THEN RAISE EXCEPTION 'mutation confirmation is immutable'; END IF;
  RETURN NEW;
END$$;

CREATE FUNCTION protect_inventory_mutation_target()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP='UPDATE' OR EXISTS(SELECT 1 FROM inventory_mutation_stages WHERE id=NEW.stage_id AND confirmation_hash IS NOT NULL)
    THEN RAISE EXCEPTION 'mutation target is immutable'; END IF;
  RETURN NEW;
END$$;

CREATE FUNCTION inventory_fence_native_readback()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE target record;
BEGIN
  IF NOT NEW.verified_readback THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('data-sync:'||NEW.tenant_id||':'||NEW.principal_id,0));
  FOR target IN
    SELECT scope.id,r.identity FROM public.data_scope_epochs scope
    JOIN public.inventory_roots root ON root.scope_id=scope.id AND root.current
    JOIN public.inventory_memberships member ON member.baseline_id=root.baseline_id
      AND member.valid_from_revision<=root.revision AND (member.valid_to_revision IS NULL OR member.valid_to_revision>root.revision)
    JOIN public.power_platform_record_rows r ON r.generation_id=member.generation_id AND r.identity=member.identity
    WHERE scope.tenant_id=NEW.tenant_id AND scope.principal_id=NEW.principal_id AND scope.token_mode='delegated'
      AND scope.source='inventory_power_platform' AND r.resource_type='microsoft.copilotstudio/agents'
      AND lower(r.environment_id)=lower(NEW.environment_id)
      AND CASE WHEN r.native_id ~* '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
        THEN lower(r.native_id)=lower(NEW.resource_native_id) ELSE r.native_id=NEW.resource_native_id END
      AND (r.residual->'details'->'isQuarantined' IS DISTINCT FROM to_jsonb(NEW.is_bot_quarantined)
        OR EXISTS(SELECT 1 FROM public.inventory_native_control_pending p WHERE p.scope_id=scope.id AND p.identity=r.identity))
    ORDER BY scope.id,r.identity
  LOOP
    PERFORM 1 FROM public.data_scope_epochs WHERE id=target.id FOR UPDATE;
    UPDATE public.data_scope_epochs SET epoch=epoch+1 WHERE id=target.id;
    UPDATE public.data_generations SET state='cancelled',cancellation=cancellation+1,reserved_bytes=byte_count
      WHERE scope_id=target.id AND state IN ('staging','validating');
    INSERT INTO public.inventory_native_control_pending(tenant_id,principal_id,scope_id,identity,observation_id)
      VALUES(NEW.tenant_id,NEW.principal_id,target.id,target.identity,NEW.id)
      ON CONFLICT(scope_id,identity) DO UPDATE SET observation_id=EXCLUDED.observation_id,updated_at=clock_timestamp();
  END LOOP;
  RETURN NEW;
END$$;

CREATE FUNCTION protect_inventory_selection_criteria()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.target_filter_hash IS DISTINCT FROM OLD.target_filter_hash THEN RAISE EXCEPTION 'mutation selection is immutable'; END IF;
  RETURN NEW;
END$$;

CREATE FUNCTION inventory_observe_people()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE after_tenant text:=''; after_principal text:=''; actor record; changed_count integer;
BEGIN
  LOOP
    changed_count:=0;
    FOR actor IN SELECT DISTINCT tenant_id COLLATE "C" AS tenant_id,principal_id COLLATE "C" AS principal_id FROM changed
      WHERE (tenant_id COLLATE "C",principal_id COLLATE "C")>(after_tenant COLLATE "C",after_principal COLLATE "C")
      ORDER BY 1,2 LIMIT 250
    LOOP
      INSERT INTO public.inventory_people_revisions(tenant_id,principal_id) VALUES(actor.tenant_id,actor.principal_id)
        ON CONFLICT(tenant_id,principal_id) DO UPDATE SET revision=inventory_people_revisions.revision+1;
      after_tenant:=actor.tenant_id; after_principal:=actor.principal_id; changed_count:=changed_count+1;
    END LOOP;
    EXIT WHEN changed_count=0;
  END LOOP;
  RETURN NULL;
END$$;

CREATE FUNCTION protect_inventory_query_context()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.query_values IS DISTINCT FROM OLD.query_values THEN RAISE EXCEPTION 'inventory_query_context_immutable'; END IF;
  RETURN NEW;
END$$;

CREATE FUNCTION protect_inventory_attempt()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.membership_prepared,NEW.prepared_changed_count) IS DISTINCT FROM (OLD.membership_prepared,OLD.prepared_changed_count) THEN
    IF OLD.membership_prepared OR NOT NEW.membership_prepared OR NOT OLD.complete
      OR NOT EXISTS(SELECT 1 FROM data_generations g JOIN data_scope_epochs scope ON scope.id=g.scope_id
        JOIN inventory_roots root ON root.baseline_id=g.id
        WHERE g.id=OLD.generation_id AND g.state='validating' AND g.validated
          AND g.scope_epoch=scope.epoch AND g.session_epoch=scope.session_epoch AND g.cancellation=0
          AND g.lease_until>clock_timestamp() AND g.deadline_at>clock_timestamp() AND NOT root.current
          AND NEW.prepared_changed_count<=root.row_count)
      OR (to_jsonb(NEW)-ARRAY['membership_prepared','prepared_changed_count'])
        IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['membership_prepared','prepared_changed_count'])
      THEN RAISE EXCEPTION 'inventory_preparation_fenced'; END IF;
    RETURN NEW;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM data_generations WHERE id=OLD.generation_id AND state='staging') THEN
    RAISE EXCEPTION 'inventory_attempt_immutable';
  END IF;
  IF (to_jsonb(NEW)-ARRAY['expected_count','complete','omitted_fields'])
    IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['expected_count','complete','omitted_fields']) THEN
    RAISE EXCEPTION 'inventory_intent_immutable';
  END IF;
  RETURN NEW;
END$$;

CREATE FUNCTION inventory_detail_target_revision_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM package_refresh_jobs WHERE id=NEW.job_id AND auto_details)
    AND NEW.catalog_revision_hash IS NULL THEN
    RAISE EXCEPTION 'inventory_detail_target_revision_required' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND NEW.catalog_revision_hash IS DISTINCT FROM OLD.catalog_revision_hash THEN
    RAISE EXCEPTION 'inventory_detail_target_revision_immutable';
  END IF;
  RETURN NEW;
END$$;

CREATE FUNCTION protect_job_inventory_authority()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.source_generation_id,NEW.source_identity,NEW.agent_id,NEW.authority_expires_at)
    IS DISTINCT FROM (OLD.source_generation_id,OLD.source_identity,OLD.agent_id,OLD.authority_expires_at) THEN
    RAISE EXCEPTION 'job inventory authority is immutable';
  END IF;
  RETURN NEW;
END$$;

CREATE FUNCTION protect_export_idempotency()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(NEW.idempotency_key,NEW.request_hash) IS DISTINCT FROM ROW(OLD.idempotency_key,OLD.request_hash) THEN
    RAISE EXCEPTION 'export_idempotency_immutable';
  END IF;
  RETURN NEW;
END$$;

CREATE FUNCTION inventory_interval_insert_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS(
    SELECT 1 FROM (
      SELECT baseline_id,valid_from_revision,bool_and(valid_to_revision IS NULL) AS open FROM inserted_inventory_memberships
      GROUP BY baseline_id,valid_from_revision
    ) inserted
    LEFT JOIN inventory_roots root ON root.baseline_id=inserted.baseline_id
    LEFT JOIN data_generation_heads head ON head.scope_id=root.scope_id
    LEFT JOIN data_generations published ON published.id=head.generation_id
    LEFT JOIN data_generations staged ON staged.id=root.baseline_id
    LEFT JOIN inventory_attempts attempt ON attempt.generation_id=staged.id
    LEFT JOIN data_scope_epochs scope ON scope.id=root.scope_id
    WHERE NOT coalesce(
      (root.current AND head.revision=inserted.valid_from_revision AND published.state='published' AND published.validated)
      OR (
        NOT root.current AND inserted.open AND staged.state='validating' AND staged.validated AND attempt.complete
        AND NOT attempt.membership_prepared AND staged.cancellation=0
        AND staged.lease_until>clock_timestamp() AND staged.deadline_at>clock_timestamp()
        AND staged.scope_epoch=scope.epoch AND staged.session_epoch=scope.session_epoch
        AND staged.expected_revision=head.revision AND inserted.valid_from_revision=head.revision+1
        AND root.first_revision=inserted.valid_from_revision AND root.revision=inserted.valid_from_revision
        AND (attempt.mode<>'delta' OR attempt.baseline_id IS NULL)
        AND NOT EXISTS(SELECT 1 FROM inventory_worker_pins pin JOIN data_scope_epochs source ON source.id=pin.scope_id
          WHERE pin.worker_id=staged.job_id AND (pin.epoch<>source.epoch OR pin.expires_at<=clock_timestamp()))
      ),false)
  ) THEN RAISE EXCEPTION 'inventory_interval_fenced'; END IF;
  RETURN NULL;
END$$;

CREATE FUNCTION inventory_prepared_member_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM data_generations WHERE id=OLD.baseline_id AND state IN ('staging','validating'))
    THEN RAISE EXCEPTION 'inventory_preparation_pinned'; END IF;
  RETURN OLD;
END$$;

CREATE FUNCTION data_update_generation_charge()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog', 'public' SET enable_seqscan TO 'off' SET jit TO 'off'
AS $$
DECLARE previous bigint:=0; following bigint:=0; selected_scope uuid; selected_tenant text;
BEGIN
  IF TG_OP<>'INSERT' THEN
    selected_scope:=OLD.scope_id; selected_tenant:=OLD.tenant_id;
    IF OLD.collected_at IS NULL THEN
      previous:=CASE WHEN OLD.state IN ('staging','validating') THEN OLD.reserved_bytes ELSE OLD.byte_count END;
    END IF;
  END IF;
  IF TG_OP<>'DELETE' THEN
    selected_scope:=NEW.scope_id; selected_tenant:=NEW.tenant_id;
    IF NEW.collected_at IS NULL THEN
      following:=CASE WHEN NEW.state IN ('staging','validating') THEN NEW.reserved_bytes ELSE NEW.byte_count END;
    END IF;
  END IF;
  IF following>previous THEN
    INSERT INTO public.data_generation_charges(scope_id,tenant_id,generation_bytes)
      VALUES(selected_scope,selected_tenant,following-previous)
      ON CONFLICT(scope_id) DO UPDATE
        SET generation_bytes=data_generation_charges.generation_bytes+following-previous
        WHERE data_generation_charges.tenant_id=selected_tenant;
    IF NOT FOUND THEN RAISE EXCEPTION 'data_generation_charge_scope'; END IF;
  ELSIF following<previous THEN
    UPDATE public.data_generation_charges SET generation_bytes=generation_bytes+following-previous
      WHERE scope_id=selected_scope AND tenant_id=selected_tenant;
    IF NOT FOUND THEN RAISE EXCEPTION 'data_generation_charge_scope'; END IF;
  END IF;
  RETURN NULL;
END$$;

CREATE FUNCTION ac_inventory_memberships_delete_rewind()
RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $$
DECLARE changed_rows bigint; changed_bytes bigint;
BEGIN
  WITH released AS MATERIALIZED (
    SELECT DISTINCT ON(g.scope_id) g.scope_id,prior_row.generation_id AS generation_id,prior_row.identity AS identity
    FROM old_rows prior_row CROSS JOIN LATERAL (
      SELECT scope_id FROM public.data_generations WHERE id=prior_row.generation_id OFFSET 0
    ) g

    ORDER BY g.scope_id,prior_row.generation_id,prior_row.identity COLLATE "C"
  ), locked AS MATERIALIZED (
    SELECT p.scope_id,r.generation_id,r.identity FROM released r JOIN public.inventory_collection_progress p ON p.scope_id=r.scope_id
    WHERE p.after_generation IS NOT NULL
      AND (r.generation_id,r.identity COLLATE "C")<=(p.after_generation,p.after_identity COLLATE "C")
      AND (NOT p.after_inclusive OR (r.generation_id,r.identity COLLATE "C")<(p.after_generation,p.after_identity COLLATE "C"))
    ORDER BY p.scope_id FOR UPDATE OF p
  ), changed AS (
    UPDATE public.inventory_collection_progress p SET after_generation=r.generation_id,after_identity=r.identity,after_inclusive=true
    FROM locked r WHERE p.scope_id=r.scope_id RETURNING octet_length(row_to_json(p)::text) AS bytes
  ) SELECT count(*),coalesce(sum(bytes),0) INTO changed_rows,changed_bytes FROM changed;
  PERFORM set_config('agent_control.inventory_gc_cursor_rows',
    (coalesce(nullif(current_setting('agent_control.inventory_gc_cursor_rows',true),''),'0')::bigint+changed_rows)::text,true);
  PERFORM set_config('agent_control.inventory_gc_cursor_bytes',
    (coalesce(nullif(current_setting('agent_control.inventory_gc_cursor_bytes',true),''),'0')::bigint+changed_bytes)::text,true);
  RETURN NULL;
END$$;

CREATE FUNCTION ac_inventory_memberships_update_rewind()
RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $$
DECLARE changed_rows bigint; changed_bytes bigint;
BEGIN
  WITH released AS MATERIALIZED (
    SELECT DISTINCT ON(g.scope_id) g.scope_id,prior_row.generation_id AS generation_id,prior_row.identity AS identity
    FROM old_rows prior_row CROSS JOIN LATERAL (
      SELECT scope_id FROM public.data_generations WHERE id=prior_row.generation_id OFFSET 0
    ) g
    WHERE NOT EXISTS(SELECT 1 FROM new_rows newer
      WHERE newer.generation_id=prior_row.generation_id AND newer.identity=prior_row.identity)
    ORDER BY g.scope_id,prior_row.generation_id,prior_row.identity COLLATE "C"
  ), locked AS MATERIALIZED (
    SELECT p.scope_id,r.generation_id,r.identity FROM released r JOIN public.inventory_collection_progress p ON p.scope_id=r.scope_id
    WHERE p.after_generation IS NOT NULL
      AND (r.generation_id,r.identity COLLATE "C")<=(p.after_generation,p.after_identity COLLATE "C")
      AND (NOT p.after_inclusive OR (r.generation_id,r.identity COLLATE "C")<(p.after_generation,p.after_identity COLLATE "C"))
    ORDER BY p.scope_id FOR UPDATE OF p
  ), changed AS (
    UPDATE public.inventory_collection_progress p SET after_generation=r.generation_id,after_identity=r.identity,after_inclusive=true
    FROM locked r WHERE p.scope_id=r.scope_id RETURNING octet_length(row_to_json(p)::text) AS bytes
  ) SELECT count(*),coalesce(sum(bytes),0) INTO changed_rows,changed_bytes FROM changed;
  PERFORM set_config('agent_control.inventory_gc_cursor_rows',
    (coalesce(nullif(current_setting('agent_control.inventory_gc_cursor_rows',true),''),'0')::bigint+changed_rows)::text,true);
  PERFORM set_config('agent_control.inventory_gc_cursor_bytes',
    (coalesce(nullif(current_setting('agent_control.inventory_gc_cursor_bytes',true),''),'0')::bigint+changed_bytes)::text,true);
  RETURN NULL;
END$$;

CREATE FUNCTION ac_unified_agent_memberships_delete_rewind()
RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $$
DECLARE changed_rows bigint; changed_bytes bigint;
BEGIN
  WITH released AS MATERIALIZED (
    SELECT DISTINCT ON(g.scope_id) g.scope_id,prior_row.source_generation_id AS generation_id,prior_row.source_identity AS identity
    FROM old_rows prior_row CROSS JOIN LATERAL (
      SELECT scope_id FROM public.data_generations WHERE id=prior_row.source_generation_id OFFSET 0
    ) g

    ORDER BY g.scope_id,prior_row.source_generation_id,prior_row.source_identity COLLATE "C"
  ), locked AS MATERIALIZED (
    SELECT p.scope_id,r.generation_id,r.identity FROM released r JOIN public.inventory_collection_progress p ON p.scope_id=r.scope_id
    WHERE p.after_generation IS NOT NULL
      AND (r.generation_id,r.identity COLLATE "C")<=(p.after_generation,p.after_identity COLLATE "C")
      AND (NOT p.after_inclusive OR (r.generation_id,r.identity COLLATE "C")<(p.after_generation,p.after_identity COLLATE "C"))
    ORDER BY p.scope_id FOR UPDATE OF p
  ), changed AS (
    UPDATE public.inventory_collection_progress p SET after_generation=r.generation_id,after_identity=r.identity,after_inclusive=true
    FROM locked r WHERE p.scope_id=r.scope_id RETURNING octet_length(row_to_json(p)::text) AS bytes
  ) SELECT count(*),coalesce(sum(bytes),0) INTO changed_rows,changed_bytes FROM changed;
  PERFORM set_config('agent_control.inventory_gc_cursor_rows',
    (coalesce(nullif(current_setting('agent_control.inventory_gc_cursor_rows',true),''),'0')::bigint+changed_rows)::text,true);
  PERFORM set_config('agent_control.inventory_gc_cursor_bytes',
    (coalesce(nullif(current_setting('agent_control.inventory_gc_cursor_bytes',true),''),'0')::bigint+changed_bytes)::text,true);
  RETURN NULL;
END$$;

CREATE FUNCTION ac_unified_agent_memberships_update_rewind()
RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $$
DECLARE changed_rows bigint; changed_bytes bigint;
BEGIN
  WITH released AS MATERIALIZED (
    SELECT DISTINCT ON(g.scope_id) g.scope_id,prior_row.source_generation_id AS generation_id,prior_row.source_identity AS identity
    FROM old_rows prior_row CROSS JOIN LATERAL (
      SELECT scope_id FROM public.data_generations WHERE id=prior_row.source_generation_id OFFSET 0
    ) g
    WHERE NOT EXISTS(SELECT 1 FROM new_rows newer
      WHERE newer.source_generation_id=prior_row.source_generation_id AND newer.source_identity=prior_row.source_identity)
    ORDER BY g.scope_id,prior_row.source_generation_id,prior_row.source_identity COLLATE "C"
  ), locked AS MATERIALIZED (
    SELECT p.scope_id,r.generation_id,r.identity FROM released r JOIN public.inventory_collection_progress p ON p.scope_id=r.scope_id
    WHERE p.after_generation IS NOT NULL
      AND (r.generation_id,r.identity COLLATE "C")<=(p.after_generation,p.after_identity COLLATE "C")
      AND (NOT p.after_inclusive OR (r.generation_id,r.identity COLLATE "C")<(p.after_generation,p.after_identity COLLATE "C"))
    ORDER BY p.scope_id FOR UPDATE OF p
  ), changed AS (
    UPDATE public.inventory_collection_progress p SET after_generation=r.generation_id,after_identity=r.identity,after_inclusive=true
    FROM locked r WHERE p.scope_id=r.scope_id RETURNING octet_length(row_to_json(p)::text) AS bytes
  ) SELECT count(*),coalesce(sum(bytes),0) INTO changed_rows,changed_bytes FROM changed;
  PERFORM set_config('agent_control.inventory_gc_cursor_rows',
    (coalesce(nullif(current_setting('agent_control.inventory_gc_cursor_rows',true),''),'0')::bigint+changed_rows)::text,true);
  PERFORM set_config('agent_control.inventory_gc_cursor_bytes',
    (coalesce(nullif(current_setting('agent_control.inventory_gc_cursor_bytes',true),''),'0')::bigint+changed_bytes)::text,true);
  RETURN NULL;
END$$;

CREATE FUNCTION ac_inventory_compaction_refs_delete_rewind()
RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $$
DECLARE changed_rows bigint; changed_bytes bigint;
BEGIN
  WITH released AS MATERIALIZED (
    SELECT DISTINCT ON(g.scope_id) g.scope_id,prior_row.source_generation_id AS generation_id,prior_row.identity AS identity
    FROM old_rows prior_row CROSS JOIN LATERAL (
      SELECT scope_id FROM public.data_generations WHERE id=prior_row.source_generation_id OFFSET 0
    ) g

    ORDER BY g.scope_id,prior_row.source_generation_id,prior_row.identity COLLATE "C"
  ), locked AS MATERIALIZED (
    SELECT p.scope_id,r.generation_id,r.identity FROM released r JOIN public.inventory_collection_progress p ON p.scope_id=r.scope_id
    WHERE p.after_generation IS NOT NULL
      AND (r.generation_id,r.identity COLLATE "C")<=(p.after_generation,p.after_identity COLLATE "C")
      AND (NOT p.after_inclusive OR (r.generation_id,r.identity COLLATE "C")<(p.after_generation,p.after_identity COLLATE "C"))
    ORDER BY p.scope_id FOR UPDATE OF p
  ), changed AS (
    UPDATE public.inventory_collection_progress p SET after_generation=r.generation_id,after_identity=r.identity,after_inclusive=true
    FROM locked r WHERE p.scope_id=r.scope_id RETURNING octet_length(row_to_json(p)::text) AS bytes
  ) SELECT count(*),coalesce(sum(bytes),0) INTO changed_rows,changed_bytes FROM changed;
  PERFORM set_config('agent_control.inventory_gc_cursor_rows',
    (coalesce(nullif(current_setting('agent_control.inventory_gc_cursor_rows',true),''),'0')::bigint+changed_rows)::text,true);
  PERFORM set_config('agent_control.inventory_gc_cursor_bytes',
    (coalesce(nullif(current_setting('agent_control.inventory_gc_cursor_bytes',true),''),'0')::bigint+changed_bytes)::text,true);
  RETURN NULL;
END$$;

CREATE FUNCTION ac_inventory_compaction_refs_update_rewind()
RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $$
DECLARE changed_rows bigint; changed_bytes bigint;
BEGIN
  WITH released AS MATERIALIZED (
    SELECT DISTINCT ON(g.scope_id) g.scope_id,prior_row.source_generation_id AS generation_id,prior_row.identity AS identity
    FROM old_rows prior_row CROSS JOIN LATERAL (
      SELECT scope_id FROM public.data_generations WHERE id=prior_row.source_generation_id OFFSET 0
    ) g
    WHERE NOT EXISTS(SELECT 1 FROM new_rows newer
      WHERE newer.source_generation_id=prior_row.source_generation_id AND newer.identity=prior_row.identity)
    ORDER BY g.scope_id,prior_row.source_generation_id,prior_row.identity COLLATE "C"
  ), locked AS MATERIALIZED (
    SELECT p.scope_id,r.generation_id,r.identity FROM released r JOIN public.inventory_collection_progress p ON p.scope_id=r.scope_id
    WHERE p.after_generation IS NOT NULL
      AND (r.generation_id,r.identity COLLATE "C")<=(p.after_generation,p.after_identity COLLATE "C")
      AND (NOT p.after_inclusive OR (r.generation_id,r.identity COLLATE "C")<(p.after_generation,p.after_identity COLLATE "C"))
    ORDER BY p.scope_id FOR UPDATE OF p
  ), changed AS (
    UPDATE public.inventory_collection_progress p SET after_generation=r.generation_id,after_identity=r.identity,after_inclusive=true
    FROM locked r WHERE p.scope_id=r.scope_id RETURNING octet_length(row_to_json(p)::text) AS bytes
  ) SELECT count(*),coalesce(sum(bytes),0) INTO changed_rows,changed_bytes FROM changed;
  PERFORM set_config('agent_control.inventory_gc_cursor_rows',
    (coalesce(nullif(current_setting('agent_control.inventory_gc_cursor_rows',true),''),'0')::bigint+changed_rows)::text,true);
  PERFORM set_config('agent_control.inventory_gc_cursor_bytes',
    (coalesce(nullif(current_setting('agent_control.inventory_gc_cursor_bytes',true),''),'0')::bigint+changed_bytes)::text,true);
  RETURN NULL;
END$$;

CREATE FUNCTION ac_inventory_exact_heads_delete_rewind()
RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $$
DECLARE changed_rows bigint; changed_bytes bigint;
BEGIN
  WITH released AS MATERIALIZED (
    SELECT DISTINCT ON(g.scope_id) g.scope_id,prior_row.generation_id AS generation_id,prior_row.identity AS identity
    FROM old_rows prior_row CROSS JOIN LATERAL (
      SELECT scope_id FROM public.data_generations WHERE id=prior_row.generation_id OFFSET 0
    ) g

    ORDER BY g.scope_id,prior_row.generation_id,prior_row.identity COLLATE "C"
  ), locked AS MATERIALIZED (
    SELECT p.scope_id,r.generation_id,r.identity FROM released r JOIN public.inventory_collection_progress p ON p.scope_id=r.scope_id
    WHERE p.after_generation IS NOT NULL
      AND (r.generation_id,r.identity COLLATE "C")<=(p.after_generation,p.after_identity COLLATE "C")
      AND (NOT p.after_inclusive OR (r.generation_id,r.identity COLLATE "C")<(p.after_generation,p.after_identity COLLATE "C"))
    ORDER BY p.scope_id FOR UPDATE OF p
  ), changed AS (
    UPDATE public.inventory_collection_progress p SET after_generation=r.generation_id,after_identity=r.identity,after_inclusive=true
    FROM locked r WHERE p.scope_id=r.scope_id RETURNING octet_length(row_to_json(p)::text) AS bytes
  ) SELECT count(*),coalesce(sum(bytes),0) INTO changed_rows,changed_bytes FROM changed;
  PERFORM set_config('agent_control.inventory_gc_cursor_rows',
    (coalesce(nullif(current_setting('agent_control.inventory_gc_cursor_rows',true),''),'0')::bigint+changed_rows)::text,true);
  PERFORM set_config('agent_control.inventory_gc_cursor_bytes',
    (coalesce(nullif(current_setting('agent_control.inventory_gc_cursor_bytes',true),''),'0')::bigint+changed_bytes)::text,true);
  RETURN NULL;
END$$;

CREATE FUNCTION ac_inventory_exact_heads_update_rewind()
RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $$
DECLARE changed_rows bigint; changed_bytes bigint;
BEGIN
  WITH released AS MATERIALIZED (
    SELECT DISTINCT ON(g.scope_id) g.scope_id,prior_row.generation_id AS generation_id,prior_row.identity AS identity
    FROM old_rows prior_row CROSS JOIN LATERAL (
      SELECT scope_id FROM public.data_generations WHERE id=prior_row.generation_id OFFSET 0
    ) g
    WHERE NOT EXISTS(SELECT 1 FROM new_rows newer
      WHERE newer.generation_id=prior_row.generation_id AND newer.identity=prior_row.identity)
    ORDER BY g.scope_id,prior_row.generation_id,prior_row.identity COLLATE "C"
  ), locked AS MATERIALIZED (
    SELECT p.scope_id,r.generation_id,r.identity FROM released r JOIN public.inventory_collection_progress p ON p.scope_id=r.scope_id
    WHERE p.after_generation IS NOT NULL
      AND (r.generation_id,r.identity COLLATE "C")<=(p.after_generation,p.after_identity COLLATE "C")
      AND (NOT p.after_inclusive OR (r.generation_id,r.identity COLLATE "C")<(p.after_generation,p.after_identity COLLATE "C"))
    ORDER BY p.scope_id FOR UPDATE OF p
  ), changed AS (
    UPDATE public.inventory_collection_progress p SET after_generation=r.generation_id,after_identity=r.identity,after_inclusive=true
    FROM locked r WHERE p.scope_id=r.scope_id RETURNING octet_length(row_to_json(p)::text) AS bytes
  ) SELECT count(*),coalesce(sum(bytes),0) INTO changed_rows,changed_bytes FROM changed;
  PERFORM set_config('agent_control.inventory_gc_cursor_rows',
    (coalesce(nullif(current_setting('agent_control.inventory_gc_cursor_rows',true),''),'0')::bigint+changed_rows)::text,true);
  PERFORM set_config('agent_control.inventory_gc_cursor_bytes',
    (coalesce(nullif(current_setting('agent_control.inventory_gc_cursor_bytes',true),''),'0')::bigint+changed_bytes)::text,true);
  RETURN NULL;
END$$;

CREATE FUNCTION ac_inventory_generation_collectable_rewind()
RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $$
DECLARE changed_rows bigint; changed_bytes bigint;
BEGIN
  WITH released AS MATERIALIZED (
    SELECT DISTINCT ON(current_row.scope_id) current_row.scope_id,current_row.id AS generation_id,k.identity
    FROM new_rows current_row JOIN old_rows prior_row ON prior_row.id=current_row.id
    CROSS JOIN LATERAL (SELECT identity FROM public.inventory_keys WHERE generation_id=current_row.id AND scope_id=current_row.scope_id
      ORDER BY identity COLLATE "C" LIMIT 1) k
    WHERE prior_row.state IS DISTINCT FROM current_row.state AND current_row.state IN ('published','retired','failed','cancelled')
    ORDER BY current_row.scope_id,current_row.id,k.identity COLLATE "C"
  ), locked AS MATERIALIZED (
    SELECT p.scope_id,r.generation_id,r.identity FROM released r JOIN public.inventory_collection_progress p ON p.scope_id=r.scope_id
    WHERE p.after_generation IS NOT NULL
      AND (r.generation_id,r.identity COLLATE "C")<=(p.after_generation,p.after_identity COLLATE "C")
      AND (NOT p.after_inclusive OR (r.generation_id,r.identity COLLATE "C")<(p.after_generation,p.after_identity COLLATE "C"))
    ORDER BY p.scope_id FOR UPDATE OF p
  ), changed AS (
    UPDATE public.inventory_collection_progress p SET after_generation=r.generation_id,after_identity=r.identity,after_inclusive=true
    FROM locked r WHERE p.scope_id=r.scope_id RETURNING octet_length(row_to_json(p)::text) AS bytes
  ) SELECT count(*),coalesce(sum(bytes),0) INTO changed_rows,changed_bytes FROM changed;
  PERFORM set_config('agent_control.inventory_gc_cursor_rows',
    (coalesce(nullif(current_setting('agent_control.inventory_gc_cursor_rows',true),''),'0')::bigint+changed_rows)::text,true);
  PERFORM set_config('agent_control.inventory_gc_cursor_bytes',
    (coalesce(nullif(current_setting('agent_control.inventory_gc_cursor_bytes',true),''),'0')::bigint+changed_bytes)::text,true);
  RETURN NULL;
END$$;

CREATE FUNCTION directory_service_plan_rows_insert_guard()
RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'pg_catalog', 'public' SET jit TO 'off'
AS $$
DECLARE batch record; parent public.data_generations;
BEGIN
  FOR batch IN
    SELECT generation_id,min(schema_version) AS first_schema,max(schema_version) AS last_schema
      FROM inserted_children GROUP BY generation_id ORDER BY generation_id
  LOOP
    SELECT * INTO STRICT parent FROM public.data_generations WHERE id=batch.generation_id FOR SHARE;
    IF parent.state<>'staging' OR parent.lease_until<=clock_timestamp()
      OR parent.deadline_at<=clock_timestamp() OR parent.cancellation<>0
      OR NOT EXISTS(SELECT 1 FROM public.data_scope_epochs s WHERE s.id=parent.scope_id
        AND s.epoch=parent.scope_epoch AND s.session_epoch=parent.session_epoch)

      THEN RAISE EXCEPTION 'data_writer_fenced'; END IF;
    IF batch.first_schema<>parent.schema_version OR batch.last_schema<>parent.schema_version
      THEN RAISE EXCEPTION 'data_schema_version'; END IF;
  END LOOP;
  RETURN NULL;
END$$;

CREATE FUNCTION inventory_facts_insert_guard()
RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'pg_catalog', 'public' SET jit TO 'off'
AS $$
DECLARE batch record; parent public.data_generations;
BEGIN
  FOR batch IN
    SELECT generation_id,min(schema_version) AS first_schema,max(schema_version) AS last_schema
      FROM inserted_children GROUP BY generation_id ORDER BY generation_id
  LOOP
    SELECT * INTO STRICT parent FROM public.data_generations WHERE id=batch.generation_id FOR SHARE;
    IF parent.state<>'staging' OR parent.lease_until<=clock_timestamp()
      OR parent.deadline_at<=clock_timestamp() OR parent.cancellation<>0
      OR NOT EXISTS(SELECT 1 FROM public.data_scope_epochs s WHERE s.id=parent.scope_id
        AND s.epoch=parent.scope_epoch AND s.session_epoch=parent.session_epoch)
      OR EXISTS(SELECT 1 FROM public.inventory_worker_pins p
        JOIN public.data_scope_epochs s ON s.id=p.scope_id WHERE p.worker_id=parent.job_id
          AND (p.epoch<>s.epoch OR p.expires_at<=clock_timestamp()))
      THEN RAISE EXCEPTION 'data_writer_fenced'; END IF;
    IF batch.first_schema<>parent.schema_version OR batch.last_schema<>parent.schema_version
      THEN RAISE EXCEPTION 'data_schema_version'; END IF;
  END LOOP;
  RETURN NULL;
END$$;

CREATE FUNCTION official_usage_membership_count()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog', 'public' SET enable_seqscan TO 'off' SET jit TO 'off'
AS $$
DECLARE changes text; item record;
BEGIN
  IF TG_OP='INSERT' THEN
    changes:='SELECT version_id,tenant_id,kind,count(*)::bigint AS delta FROM inserted_memberships
      GROUP BY version_id,tenant_id,kind ORDER BY version_id,tenant_id,kind';
  ELSIF TG_OP='DELETE' THEN
    changes:='SELECT version_id,tenant_id,kind,-count(*)::bigint AS delta FROM deleted_memberships
      GROUP BY version_id,tenant_id,kind ORDER BY version_id,tenant_id,kind';
  ELSIF TG_OP='UPDATE' THEN
    changes:='SELECT version_id,tenant_id,kind,sum(delta)::bigint AS delta FROM (
      SELECT version_id,tenant_id,kind,1::bigint AS delta FROM inserted_memberships
      UNION ALL SELECT version_id,tenant_id,kind,-1::bigint AS delta FROM deleted_memberships
    ) changed GROUP BY version_id,tenant_id,kind HAVING sum(delta)<>0 ORDER BY version_id,tenant_id,kind';
  ELSE RAISE EXCEPTION 'official_membership_count_operation';
  END IF;
  FOR item IN EXECUTE changes LOOP
    IF item.delta>0 THEN
      INSERT INTO public.official_usage_membership_counts(version_id,tenant_id,kind,row_count)
        VALUES(item.version_id,item.tenant_id,item.kind,item.delta)
        ON CONFLICT(version_id) DO UPDATE SET row_count=official_usage_membership_counts.row_count+item.delta
          WHERE official_usage_membership_counts.tenant_id=item.tenant_id AND official_usage_membership_counts.kind=item.kind;
      IF NOT FOUND THEN RAISE EXCEPTION 'official_membership_count_scope'; END IF;
    ELSE
      UPDATE public.official_usage_membership_counts SET row_count=row_count+item.delta
        WHERE version_id=item.version_id AND tenant_id=item.tenant_id AND kind=item.kind;
      IF NOT FOUND AND EXISTS(SELECT 1 FROM public.official_usage_versions WHERE id=item.version_id)
      THEN RAISE EXCEPTION 'official_membership_count_missing'; END IF;
    END IF;
  END LOOP;
  RETURN NULL;
END$$;

CREATE FUNCTION user_source_protect_report_period()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.report_period IS DISTINCT FROM OLD.report_period THEN RAISE EXCEPTION 'user_source_report_period_immutable'; END IF;
  RETURN NEW;
END$$;

CREATE FUNCTION inventory_classification_fact_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.kind IN ('presence','linkState','availability','management')
  THEN RAISE EXCEPTION 'inventory_scalar_fact_retired'; END IF;
  RETURN NEW;
END$$;

CREATE INDEX sessions_expire
  ON sessions (expire);

CREATE INDEX jobs_scope
  ON jobs (tenant_id, principal_id, created_at DESC);

CREATE INDEX jobs_expiry
  ON jobs (expires_at);

CREATE INDEX audit_events_scope
  ON audit_events (tenant_id, principal_id, started_at DESC);

CREATE INDEX audit_events_projection
  ON audit_events (event_id, observed_at DESC);

CREATE INDEX capability_evidence_expiry
  ON capability_evidence (expires_at);

CREATE INDEX power_platform_refresh_jobs_scope
  ON power_platform_refresh_jobs (tenant_id, principal_id, created_at DESC);

CREATE INDEX power_platform_refresh_jobs_expiry
  ON power_platform_refresh_jobs (expires_at);

CREATE INDEX power_platform_refresh_jobs_deadline
  ON power_platform_refresh_jobs (status, deadline_at);

CREATE INDEX package_refresh_jobs_scope
  ON package_refresh_jobs (tenant_id, principal_id, created_at DESC);

CREATE INDEX package_refresh_jobs_expiry
  ON package_refresh_jobs (expires_at);

CREATE INDEX package_refresh_jobs_recovery
  ON package_refresh_jobs (status, deadline_at);

CREATE UNIQUE INDEX package_inventory_current_scope
  ON package_inventory_snapshots (tenant_id, principal_id, token_mode, query_hash)
  WHERE is_current;

CREATE INDEX package_inventory_snapshots_scope
  ON package_inventory_snapshots (tenant_id, principal_id, is_current, observed_at DESC);

CREATE INDEX package_inventory_snapshots_expiry
  ON package_inventory_snapshots (expires_at);

CREATE INDEX package_inventory_resources_scope
  ON package_inventory_resources (tenant_id, principal_id, snapshot_id, native_id);

CREATE INDEX package_inventory_resources_display
  ON package_inventory_resources (tenant_id
                                , principal_id
                                , snapshot_id
                                , (lower(display_name))
                                , native_id);

CREATE INDEX package_mutation_qualifications_scope
  ON package_mutation_qualifications (tenant_id, action, status, expires_at DESC);

CREATE INDEX package_mutation_qualifications_job
  ON package_mutation_qualifications (job_id)
  WHERE job_id IS NOT NULL;

CREATE INDEX official_usage_staging_owner
  ON official_usage_staging (tenant_id, actor_principal_id, status, created_at DESC);

CREATE INDEX official_usage_staging_expiry
  ON official_usage_staging (status, expires_at);

CREATE INDEX official_usage_artifacts_expiry
  ON official_usage_artifacts (expires_at);

CREATE INDEX official_usage_sets_scope
  ON official_usage_sets (tenant_id, created_at DESC);

CREATE INDEX official_usage_sets_expiry
  ON official_usage_sets (expires_at, deleted_at);

CREATE INDEX official_usage_versions_scope
  ON official_usage_versions (tenant_id, kind, accepted_at DESC);

CREATE INDEX official_usage_versions_expiry
  ON official_usage_versions (expires_at, deleted_at);

CREATE INDEX official_usage_version_rows_scope
  ON official_usage_version_rows (tenant_id, kind, version_id, ordinal);

CREATE INDEX official_usage_set_versions_scope
  ON official_usage_set_versions (tenant_id, set_id, kind);

CREATE INDEX official_usage_confirmations_owner
  ON official_usage_confirmations (tenant_id, actor_principal_id, expires_at);

CREATE INDEX official_usage_audit_scope
  ON official_usage_audit (tenant_id, actor_principal_id, observed_at DESC);

CREATE INDEX official_usage_audit_expiry
  ON official_usage_audit (expires_at);

CREATE INDEX official_usage_bundle_receipts_expiry
  ON official_usage_bundle_receipts (expires_at);

CREATE INDEX purview_audit_qualifications_scope
  ON purview_audit_qualifications (tenant_id, result_scope_id, created_at DESC);

CREATE INDEX purview_audit_qualifications_expiry
  ON purview_audit_qualifications (expires_at);

CREATE INDEX purview_audit_jobs_scope
  ON purview_audit_jobs (tenant_id, result_scope_id, created_at DESC, id DESC);

CREATE INDEX purview_audit_jobs_recovery
  ON purview_audit_jobs (status, deadline_at);

CREATE INDEX purview_audit_jobs_expiry
  ON purview_audit_jobs (expires_at);

CREATE INDEX purview_audit_jobs_provider
  ON purview_audit_jobs (tenant_id, provider_query_id)
  WHERE provider_query_id IS NOT NULL;

CREATE UNIQUE INDEX purview_audit_records_native_identity
  ON purview_audit_records (job_id, native_event_id)
  WHERE native_event_id IS NOT NULL;

CREATE INDEX purview_audit_records_scope
  ON purview_audit_records (tenant_id, result_scope_id, job_id, event_time DESC, wrapper_id DESC);

CREATE INDEX purview_audit_jobs_result_scope_v17
  ON purview_audit_jobs (tenant_id
                       , result_scope_kind
                       , result_scope_id
                       , result_scope_configuration_revision
                       , created_at DESC
                       , id DESC);

CREATE INDEX purview_audit_records_result_scope_v17
  ON purview_audit_records (tenant_id
                          , result_scope_kind
                          , result_scope_id
                          , result_scope_configuration_revision
                          , job_id
                          , event_time DESC
                          , wrapper_id DESC);

CREATE INDEX defender_hunting_jobs_scope_v18
  ON defender_hunting_jobs (tenant_id
                          , result_scope_kind
                          , result_scope_id
                          , result_scope_configuration_revision
                          , created_at DESC
                          , id DESC);

CREATE INDEX defender_hunting_jobs_recovery_v18
  ON defender_hunting_jobs (status, deadline_at);

CREATE INDEX defender_hunting_jobs_expiry_v18
  ON defender_hunting_jobs (expires_at);

CREATE INDEX defender_hunting_snapshots_scope_v18
  ON defender_hunting_snapshots (tenant_id
                               , result_scope_kind
                               , result_scope_id
                               , result_scope_configuration_revision
                               , observation_time DESC
                               , id DESC);

CREATE INDEX defender_hunting_snapshots_expiry_v18
  ON defender_hunting_snapshots (expires_at);

CREATE INDEX defender_hunting_rows_scope_v18
  ON defender_hunting_rows (tenant_id
                          , result_scope_kind
                          , result_scope_id
                          , result_scope_configuration_revision
                          , snapshot_id
                          , row_ordinal);

CREATE INDEX defender_hunting_qualification_scope_v19
  ON defender_hunting_qualification_evidence (tenant_id
                                            , result_scope_kind
                                            , result_scope_id
                                            , result_scope_configuration_revision
                                            , template_id
                                            , target_scope_hash
                                            , expires_at);

CREATE UNIQUE INDEX defender_hunting_retained_scope_active_v21
  ON defender_hunting_retained_scopes (tenant_id
                                     , authorization_principal_id
                                     , result_scope_kind
                                     , result_scope_id
                                     , result_scope_configuration_key
                                     , token_mode
                                     , capability_id
                                     , template_id
                                     , target_scope_hash
                                     , query_version
                                     , contract_revision
                                     , permission_revision
                                     , configuration_revision)
  WHERE revoked_at IS NULL;

CREATE INDEX defender_hunting_retained_scope_visibility_v21
  ON defender_hunting_retained_scopes (tenant_id
                                     , result_scope_kind
                                     , result_scope_id
                                     , result_scope_configuration_revision
                                     , expires_at
                                     , id);

CREATE INDEX defender_hunting_jobs_retained_scope_v21
  ON defender_hunting_jobs (retained_scope_id)
  WHERE retained_scope_id IS NOT NULL;

CREATE INDEX copilot_quarantine_status_target_v22
  ON copilot_quarantine_status_observations (tenant_id
                                           , principal_id
                                           , environment_id
                                           , bot_id
                                           , observed_at DESC
                                           , id DESC);

CREATE INDEX copilot_quarantine_status_expiry_v22
  ON copilot_quarantine_status_observations (expires_at);

CREATE INDEX copilot_quarantine_jobs_scope_v22
  ON copilot_quarantine_jobs (tenant_id, principal_id, created_at DESC, id DESC);

CREATE INDEX copilot_quarantine_jobs_recovery_v22
  ON copilot_quarantine_jobs (status, deadline_at, lease_until);

CREATE INDEX copilot_quarantine_jobs_expiry_v22
  ON copilot_quarantine_jobs (expires_at);

CREATE INDEX copilot_quarantine_items_unresolved_v22
  ON copilot_quarantine_job_items (environment_id, bot_id, status, reconciliation_status);

CREATE INDEX copilot_quarantine_audit_scope_v22
  ON copilot_quarantine_audit (tenant_id, principal_id, observed_at DESC, id DESC);

CREATE INDEX copilot_quarantine_audit_expiry_v22
  ON copilot_quarantine_audit (expires_at);

CREATE INDEX copilot_quarantine_canary_scope_v22
  ON copilot_quarantine_canary_approvals (tenant_id, status, approval_expires_at, id);

CREATE INDEX copilot_quarantine_qualifications_expiry_v22
  ON copilot_quarantine_qualifications (expires_at);

CREATE INDEX official_usage_versions_content_hash
  ON official_usage_versions (tenant_id, kind, content_hash, accepted_at);

CREATE INDEX official_usage_sets_content_hash
  ON official_usage_sets (tenant_id, content_hash, accepted_at);

CREATE INDEX official_usage_version_rows_payload
  ON official_usage_version_rows (tenant_id, kind, payload_hash, version_id);

CREATE INDEX official_usage_set_versions_version
  ON official_usage_set_versions (tenant_id, version_id, set_id);

CREATE UNIQUE INDEX data_sync_one_active_run
  ON data_sync_runs (tenant_id, principal_id)
  WHERE status = ANY(ARRAY[CAST('running' AS text), CAST('waiting' AS text)]);

CREATE INDEX data_sync_runs_scope
  ON data_sync_runs (tenant_id, principal_id, started_at DESC, id DESC);

CREATE INDEX data_sync_runs_expiry
  ON data_sync_runs (expires_at);

CREATE INDEX data_sync_run_sources_scope
  ON data_sync_run_sources (tenant_id, principal_id, updated_at DESC);

CREATE INDEX agent_usage_associations_target
  ON agent_usage_associations (tenant_id
                             , report_set_id
                             , source
                             , normalized_environment_id
                             , normalized_native_id);

CREATE INDEX agent_people_cache_expiry
  ON agent_people_cache (expires_at);

CREATE UNIQUE INDEX package_mutation_qualification_current
  ON package_mutation_qualifications (tenant_id
                                    , action
                                    , contract_revision
                                    , configuration_revision
                                    , auth_mode
                                    , (CASE
                                         WHEN action = ANY(ARRAY[CAST('update-availability' AS text)
                                                               , CAST('update-installation' AS text)])
                                           THEN cycle_stage
                                         ELSE CAST('' AS text)
                                       END))
  WHERE status = CAST('qualified' AS text);

CREATE INDEX agent_identity_cache_expiry
  ON agent_identity_cache (expires_at);

CREATE INDEX package_control_observations
  ON package_inventory_snapshots (tenant_id, principal_id, observation_kind, observed_at DESC)
  WHERE is_current AND observation_kind <> CAST('inventory' AS text);

CREATE INDEX package_auto_detail_jobs
  ON package_refresh_jobs (tenant_id, principal_id, deadline_at)
  WHERE auto_details
    AND status = ANY(ARRAY[CAST('waiting_authorization' AS text), CAST('running' AS text)]);

CREATE INDEX data_sync_source_due
  ON data_sync_run_sources (tenant_id, principal_id, source_id, updated_at DESC);

CREATE UNIQUE INDEX data_one_writer
  ON data_generations (scope_id)
  WHERE state = ANY(ARRAY[CAST('staging' AS text), CAST('validating' AS text)]);

CREATE INDEX data_generation_admission
  ON data_generations (tenant_id, state, lease_until);

CREATE INDEX data_generation_expiry
  ON data_generations (expires_at, id);

CREATE INDEX directory_user_order
  ON directory_user_rows (generation_id
                        , (CAST(sort_key IS NULL AS integer))
                        , (COALESCE(sort_key, CAST('' AS text)))
                        , identity COLLATE "C") INCLUDE (upn, display_name, service_state);

CREATE INDEX directory_user_upn
  ON directory_user_rows (generation_id, upn_key, identity);

CREATE INDEX directory_user_company
  ON directory_user_rows (generation_id, company, identity);

CREATE INDEX directory_user_department
  ON directory_user_rows (generation_id, department, identity);

CREATE INDEX directory_plan_user
  ON directory_service_plan_rows (generation_id, user_id, plan_id) INCLUDE (state, service);

CREATE INDEX app_activity_identity
  ON app_activity_rows (generation_id, upn_key, identity) INCLUDE (report_refresh_date
                                                                 , last_activity_date);

CREATE INDEX data_selection_admission
  ON data_read_selections (tenant_id, principal_id, expires_at);

CREATE INDEX data_pin_reachability
  ON data_generation_pins (generation_id, expires_at);

CREATE INDEX data_export_admission
  ON data_exports (status, tenant_id, expires_at);

CREATE INDEX user_source_attempt_scope
  ON user_source_attempts (scope_id, generation_id);

CREATE INDEX user_source_identity_pending
  ON user_source_identity_inputs (generation_id, identity)
  WHERE NOT checked;

CREATE INDEX directory_user_entitlement
  ON directory_user_rows (generation_id, service_state, plan_count, identity);

CREATE INDEX directory_user_upn_order
  ON directory_user_rows (generation_id, upn_key COLLATE "C", identity COLLATE "C");

CREATE INDEX user_source_generation_attempt
  ON data_generations (scope_id, created_at DESC, id DESC);

CREATE INDEX official_usage_fact_identity
  ON official_usage_row_facts (tenant_id, kind, identity_key, payload_hash);

CREATE INDEX official_usage_fact_agent
  ON official_usage_row_facts (tenant_id, kind, agent_id, payload_hash);

CREATE INDEX official_usage_fact_responses
  ON official_usage_row_facts (tenant_id, kind, responses DESC, payload_hash);

CREATE UNIQUE INDEX official_usage_history_open
  ON official_usage_history_memberships (tenant_id, set_id)
  WHERE valid_to_revision IS NULL;

CREATE INDEX official_usage_history_read
  ON official_usage_history_memberships (tenant_id, valid_from_revision, set_id) INCLUDE (valid_to_revision
                                                                                        , visibility);

CREATE INDEX official_usage_ingestion_admission
  ON official_usage_ingestions (state, tenant_id, principal_id, lease_until);

CREATE INDEX official_usage_ingestion_bundle
  ON official_usage_ingestions (tenant_id, bundle_id, kind);

CREATE INDEX official_usage_ingestion_hash
  ON official_usage_ingestion_rows (ingestion_id, payload_hash, ordinal);

CREATE UNIQUE INDEX inventory_one_root
  ON inventory_roots (scope_id)
  WHERE current;

CREATE INDEX package_record_rows_display
  ON package_record_rows (scope_id, ("left"(sort_key, 64)) COLLATE "C", identity);

CREATE INDEX package_record_rows_native
  ON package_record_rows (scope_id
                        , native_id
                        , (md5(COALESCE(environment_id, CAST('' AS text))))
                        , generation_id);

CREATE INDEX package_record_rows_publisher
  ON package_record_rows (scope_id, ("left"(publisher, 64)) COLLATE "C", identity);

CREATE INDEX package_record_rows_modified
  ON package_record_rows (scope_id, modified_at, identity);

CREATE INDEX power_platform_record_rows_display
  ON power_platform_record_rows (scope_id, ("left"(sort_key, 64)) COLLATE "C", identity);

CREATE INDEX power_platform_record_rows_native
  ON power_platform_record_rows (scope_id
                               , native_id
                               , (md5(COALESCE(environment_id, CAST('' AS text))))
                               , generation_id);

CREATE INDEX power_platform_record_rows_publisher
  ON power_platform_record_rows (scope_id, ("left"(publisher, 64)) COLLATE "C", identity);

CREATE INDEX power_platform_record_rows_modified
  ON power_platform_record_rows (scope_id, modified_at, identity);

CREATE INDEX unified_agent_rows_display
  ON unified_agent_rows (scope_id, ("left"(sort_key, 64)) COLLATE "C", identity);

CREATE INDEX unified_agent_rows_native
  ON unified_agent_rows (scope_id
                       , native_id
                       , (md5(COALESCE(environment_id, CAST('' AS text))))
                       , generation_id);

CREATE INDEX unified_agent_rows_publisher
  ON unified_agent_rows (scope_id, ("left"(publisher, 64)) COLLATE "C", identity);

CREATE INDEX unified_agent_rows_modified
  ON unified_agent_rows (scope_id, modified_at, identity);

CREATE INDEX inventory_exact_newer
  ON inventory_exact_heads (scope_id, observation_epoch, read_started_at, identity);

CREATE INDEX inventory_exact_content
  ON inventory_exact_heads (generation_id, identity);

CREATE INDEX inventory_fact_match
  ON inventory_facts (scope_id, kind, value, identity, generation_id)
  WHERE kind ~~ CAST('match:%' AS text);

CREATE INDEX inventory_fact_children
  ON inventory_facts (generation_id, identity, kind, ordinal);

CREATE INDEX inventory_fact_sort_text
  ON inventory_facts (scope_id, kind, ("left"(text_value, 64)) COLLATE "C", identity, generation_id);

CREATE INDEX inventory_fact_sort_number
  ON inventory_facts (scope_id, kind, number_value, identity, generation_id);

CREATE UNIQUE INDEX inventory_member_open
  ON inventory_memberships (baseline_id, identity)
  WHERE valid_to_revision IS NULL;

CREATE INDEX inventory_member_asof
  ON inventory_memberships (baseline_id, identity, valid_from_revision DESC) INCLUDE (valid_to_revision
                                                                                    , generation_id);

CREATE INDEX inventory_member_reachability
  ON inventory_memberships (generation_id, identity);

CREATE INDEX inventory_member_gc
  ON inventory_memberships (baseline_id, valid_to_revision, identity)
  WHERE valid_to_revision IS NOT NULL;

CREATE INDEX inventory_revision_inputs
  ON inventory_revisions USING gin (inputs jsonb_path_ops);

CREATE INDEX inventory_worker_reachability
  ON inventory_worker_pins (baseline_id, expires_at, revision);

CREATE INDEX inventory_frontier_pending
  ON inventory_frontier (worker_id, expanded, source_scope_id, identity);

CREATE INDEX inventory_frontier_component
  ON inventory_frontier (worker_id, component, expanded, source_scope_id, identity);

CREATE INDEX unified_member_source
  ON unified_agent_memberships (source_scope_id, source_identity, generation_id, identity);

CREATE INDEX inventory_identifier_lookup
  ON inventory_facts ((md5(lower(value))), generation_id, identity)
  WHERE kind = CAST('identifier' AS text);

CREATE INDEX inventory_control_pending_order
  ON inventory_control_pending (updated_at, tenant_id, principal_id, target_id);

CREATE INDEX inventory_mutation_stage_actor
  ON inventory_mutation_stages (tenant_id, principal_id, confirmation_hash, expires_at);

CREATE INDEX inventory_native_control_pending_actor
  ON inventory_native_control_pending (tenant_id, principal_id, updated_at, scope_id, identity);

CREATE INDEX inventory_identity_expiry
  ON unified_agent_rows (scope_id, identity_expires_at, generation_id, identity)
  WHERE identity_expires_at IS NOT NULL;

CREATE INDEX inventory_fact_people
  ON inventory_facts (generation_id, identity, kind)
  WHERE kind = ANY(ARRAY[CAST('person:owner' AS text)
                       , CAST('person:createdBy' AS text)
                       , CAST('person:lastModifiedBy' AS text)]);

CREATE INDEX inventory_environment_lookup
  ON power_platform_record_rows ((lower(native_id)), generation_id, identity)
  WHERE resource_type = CAST('microsoft.powerplatform/environments' AS text);

CREATE UNIQUE INDEX data_export_idempotency
  ON data_exports (tenant_id, principal_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX inventory_keys_collection
  ON inventory_keys (scope_id, generation_id, identity);

CREATE INDEX unified_member_generation_source
  ON unified_agent_memberships (source_generation_id, source_identity);

CREATE INDEX inventory_compaction_source
  ON inventory_compaction_refs (source_generation_id, identity);

CREATE INDEX inventory_teams_sources
  ON inventory_facts (generation_id, identity)
  WHERE kind = CAST('host' AS text) AND lower(btrim(value)) = CAST('teams' AS text);

CREATE INDEX package_record_rows_short_display
  ON package_record_rows (scope_id, ("left"(sort_key, 64)) COLLATE "C", identity COLLATE "C")
  WHERE length(sort_key) <= 64;

CREATE INDEX package_record_rows_long_display
  ON package_record_rows (scope_id, generation_id, identity)
  WHERE length(sort_key) > 64;

CREATE INDEX power_platform_record_rows_short_display
  ON power_platform_record_rows (scope_id, ("left"(sort_key, 64)) COLLATE "C", identity COLLATE "C")
  WHERE length(sort_key) <= 64;

CREATE INDEX power_platform_record_rows_long_display
  ON power_platform_record_rows (scope_id, generation_id, identity)
  WHERE length(sort_key) > 64;

CREATE INDEX unified_agent_rows_short_display
  ON unified_agent_rows (scope_id
                       , ("left"(sort_key, 64)) COLLATE inventory_text_order
                       , identity COLLATE "C")
  WHERE length(sort_key) <= 64;

CREATE INDEX unified_agent_rows_long_display
  ON unified_agent_rows (scope_id, generation_id, identity)
  WHERE length(sort_key) > 64;

CREATE INDEX data_generation_active_admission
  ON data_generations (lease_until, tenant_id, scope_id)
  WHERE state = ANY(ARRAY[CAST('staging' AS text), CAST('validating' AS text)]);

CREATE INDEX directory_report_name_order
  ON directory_user_rows (generation_id
                        , (lower(pg_catalog.normalize(COALESCE(NULLIF(display_name
                                                                    , CAST('' AS text))
                                                             , upn)
                                                    , 'NFKC') COLLATE "default")) COLLATE "C"
                        , identity COLLATE "C");

CREATE INDEX inventory_reconciliation_tenant_admission
  ON inventory_reconciliation (tenant_id)
  WHERE active_id IS NOT NULL OR pending_inputs IS NOT NULL;

CREATE INDEX official_usage_users_name_page
  ON official_usage_row_facts (tenant_id
                             , ("left"(lower(pg_catalog.normalize(COALESCE(NULLIF(display_name, '')
                                                                         , username)
                                                                , 'NFKC') COLLATE "default")
                                     , 128) COLLATE "C")
                             , payload_hash)
  WHERE kind = 'users';

CREATE INDEX official_usage_agents_name_page
  ON official_usage_row_facts (tenant_id
                             , ("left"(lower(pg_catalog.normalize(agent_name, 'NFKC') COLLATE "default")
                                     , 128) COLLATE "C")
                             , payload_hash)
  WHERE kind = 'agents';

CREATE INDEX official_usage_useragents_name_page
  ON official_usage_row_facts (tenant_id
                             , ("left"(lower(pg_catalog.normalize(agent_name, 'NFKC') COLLATE "default")
                                     , 128) COLLATE "C")
                             , payload_hash)
  WHERE kind = 'userAgents';

CREATE INDEX data_generation_tenant_charges
  ON data_generation_charges (tenant_id) INCLUDE (generation_bytes)
  WHERE generation_bytes > 0;

CREATE INDEX inventory_available_sources
  ON package_record_rows (generation_id, identity)
  WHERE availability = CAST('available' AS text);

CREATE INDEX inventory_summary_kinds
  ON inventory_facts (scope_id, generation_id, identity, kind)
  WHERE kind = ANY(ARRAY[CAST('relevance' AS text), CAST('blocked' AS text)]);

ALTER TABLE job_items ADD CONSTRAINT job_items_job_id_fkey FOREIGN KEY (job_id) REFERENCES jobs (id) ON DELETE CASCADE;

ALTER TABLE job_attempts ADD CONSTRAINT job_attempts_job_id_fkey FOREIGN KEY (job_id) REFERENCES jobs (id) ON DELETE CASCADE;

ALTER TABLE job_attempts ADD CONSTRAINT job_attempts_item_id_fkey FOREIGN KEY (item_id) REFERENCES job_items (id) ON DELETE CASCADE;

ALTER TABLE package_inventory_snapshots ADD CONSTRAINT package_inventory_snapshots_job_id_fkey FOREIGN KEY (job_id) REFERENCES package_refresh_jobs (id) ON DELETE SET NULL;

ALTER TABLE package_inventory_resources ADD CONSTRAINT package_inventory_resources_snapshot_id_tenant_id_principa_fkey FOREIGN KEY (snapshot_id, tenant_id, principal_id) REFERENCES package_inventory_snapshots (id, tenant_id, principal_id) ON DELETE CASCADE;

ALTER TABLE package_mutation_qualifications ADD CONSTRAINT package_mutation_qualifications_paired_qualification_id_fkey FOREIGN KEY (paired_qualification_id) REFERENCES package_mutation_qualifications (id) ON DELETE CASCADE;

ALTER TABLE official_usage_staged_rows ADD CONSTRAINT official_usage_staged_rows_staging_id_fkey FOREIGN KEY (staging_id) REFERENCES official_usage_staging (id) ON DELETE CASCADE;

ALTER TABLE official_usage_staged_rows ADD CONSTRAINT official_usage_staged_rows_staging_id_tenant_id_actor_prin_fkey FOREIGN KEY (staging_id, tenant_id, actor_principal_id) REFERENCES official_usage_staging (id, tenant_id, actor_principal_id) ON DELETE CASCADE;

ALTER TABLE official_usage_versions ADD CONSTRAINT official_usage_versions_artifact_id_tenant_id_kind_fkey FOREIGN KEY (artifact_id, tenant_id, kind) REFERENCES official_usage_artifacts (id, tenant_id, kind) ON DELETE RESTRICT;

ALTER TABLE official_usage_version_rows ADD CONSTRAINT official_usage_version_rows_version_id_tenant_id_kind_fkey FOREIGN KEY (version_id, tenant_id, kind) REFERENCES official_usage_versions (id, tenant_id, kind) ON DELETE CASCADE;

ALTER TABLE official_usage_version_rows ADD CONSTRAINT official_usage_version_rows_fact_fkey FOREIGN KEY (tenant_id, kind, payload_hash) REFERENCES official_usage_row_facts (tenant_id, kind, payload_hash) ON DELETE RESTRICT;

ALTER TABLE official_usage_set_versions ADD CONSTRAINT official_usage_set_versions_set_id_tenant_id_fkey FOREIGN KEY (set_id, tenant_id) REFERENCES official_usage_sets (id, tenant_id) ON DELETE CASCADE;

ALTER TABLE official_usage_set_versions ADD CONSTRAINT official_usage_set_versions_version_id_tenant_id_kind_fkey FOREIGN KEY (version_id, tenant_id, kind) REFERENCES official_usage_versions (id, tenant_id, kind) ON DELETE RESTRICT;

ALTER TABLE official_usage_state ADD CONSTRAINT official_usage_state_active_set_id_tenant_id_fkey FOREIGN KEY (active_set_id, tenant_id) REFERENCES official_usage_sets (id, tenant_id) ON DELETE RESTRICT;

ALTER TABLE official_usage_confirmations ADD CONSTRAINT official_usage_confirmations_target_set_id_tenant_id_fkey FOREIGN KEY (target_set_id, tenant_id) REFERENCES official_usage_sets (id, tenant_id) ON DELETE CASCADE;

ALTER TABLE purview_audit_qualifications ADD CONSTRAINT purview_audit_qualification_job_v17 FOREIGN KEY (job_id) REFERENCES purview_audit_jobs (id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE purview_audit_jobs ADD CONSTRAINT purview_audit_job_qualification_v17 FOREIGN KEY (qualification_id, tenant_id, result_scope_kind, result_scope_id, result_scope_configuration_key) REFERENCES purview_audit_qualifications (id, tenant_id, result_scope_kind, result_scope_id, result_scope_configuration_key);

ALTER TABLE purview_audit_records ADD CONSTRAINT purview_audit_records_job_id_tenant_id_result_principal_id_fkey FOREIGN KEY (job_id, tenant_id, result_scope_id) REFERENCES purview_audit_jobs (id, tenant_id, result_scope_id) ON DELETE CASCADE;

ALTER TABLE purview_audit_records ADD CONSTRAINT purview_audit_record_job_v17 FOREIGN KEY (job_id, tenant_id, result_scope_kind, result_scope_id, result_scope_configuration_key) REFERENCES purview_audit_jobs (id, tenant_id, result_scope_kind, result_scope_id, result_scope_configuration_key);

ALTER TABLE defender_hunting_jobs ADD CONSTRAINT defender_hunting_jobs_retained_scope_id_fkey FOREIGN KEY (retained_scope_id) REFERENCES defender_hunting_retained_scopes (id) ON DELETE RESTRICT;

ALTER TABLE defender_hunting_snapshots ADD CONSTRAINT defender_hunting_snapshots_job_id_tenant_id_result_scope_k_fkey FOREIGN KEY (job_id, tenant_id, result_scope_kind, result_scope_id, result_scope_configuration_key) REFERENCES defender_hunting_jobs (id, tenant_id, result_scope_kind, result_scope_id, result_scope_configuration_key) ON DELETE CASCADE;

ALTER TABLE defender_hunting_rows ADD CONSTRAINT defender_hunting_rows_snapshot_id_tenant_id_result_scope_k_fkey FOREIGN KEY (snapshot_id, tenant_id, result_scope_kind, result_scope_id, result_scope_configuration_key) REFERENCES defender_hunting_snapshots (id, tenant_id, result_scope_kind, result_scope_id, result_scope_configuration_key) ON DELETE CASCADE;

ALTER TABLE defender_hunting_qualification_evidence ADD CONSTRAINT defender_hunting_qualification_evidence_qualified_job_id_fkey FOREIGN KEY (qualified_job_id) REFERENCES defender_hunting_jobs (id) ON DELETE CASCADE;

ALTER TABLE copilot_quarantine_job_items ADD CONSTRAINT copilot_quarantine_job_items_job_id_fkey FOREIGN KEY (job_id) REFERENCES copilot_quarantine_jobs (id) ON DELETE CASCADE;

ALTER TABLE copilot_quarantine_attempts ADD CONSTRAINT copilot_quarantine_attempts_job_id_fkey FOREIGN KEY (job_id) REFERENCES copilot_quarantine_jobs (id) ON DELETE CASCADE;

ALTER TABLE copilot_quarantine_attempts ADD CONSTRAINT copilot_quarantine_attempts_item_id_fkey FOREIGN KEY (item_id) REFERENCES copilot_quarantine_job_items (id) ON DELETE CASCADE;

ALTER TABLE data_sync_run_sources ADD CONSTRAINT data_sync_run_sources_run_id_tenant_id_principal_id_fkey FOREIGN KEY (run_id, tenant_id, principal_id) REFERENCES data_sync_runs (id, tenant_id, principal_id) ON DELETE CASCADE;

ALTER TABLE data_sync_source_jobs ADD CONSTRAINT data_sync_source_jobs_run_id_tenant_id_principal_id_fkey FOREIGN KEY (run_id, tenant_id, principal_id) REFERENCES data_sync_runs (id, tenant_id, principal_id) ON DELETE CASCADE;

ALTER TABLE agent_usage_associations ADD CONSTRAINT agent_usage_associations_report_set_id_tenant_id_fkey FOREIGN KEY (report_set_id, tenant_id) REFERENCES official_usage_sets (id, tenant_id) ON DELETE CASCADE;

ALTER TABLE agent_identity_cache ADD CONSTRAINT agent_identity_cache_generation FOREIGN KEY (snapshot_id) REFERENCES data_generations (id) ON DELETE CASCADE;

ALTER TABLE data_generations ADD CONSTRAINT data_generations_scope_id_tenant_id_fkey FOREIGN KEY (scope_id, tenant_id) REFERENCES data_scope_epochs (id, tenant_id);

ALTER TABLE data_generation_heads ADD CONSTRAINT data_generation_heads_scope_id_tenant_id_fkey FOREIGN KEY (scope_id, tenant_id) REFERENCES data_scope_epochs (id, tenant_id);

ALTER TABLE data_generation_heads ADD CONSTRAINT data_generation_heads_generation_id_scope_id_tenant_id_fkey FOREIGN KEY (generation_id, scope_id, tenant_id) REFERENCES data_generations (id, scope_id, tenant_id);

ALTER TABLE data_generation_batches ADD CONSTRAINT data_generation_batches_generation_id_scope_id_tenant_id_fkey FOREIGN KEY (generation_id, scope_id, tenant_id) REFERENCES data_generations (id, scope_id, tenant_id);

ALTER TABLE data_generation_pages ADD CONSTRAINT data_generation_pages_generation_id_scope_id_tenant_id_fkey FOREIGN KEY (generation_id, scope_id, tenant_id) REFERENCES data_generations (id, scope_id, tenant_id);

ALTER TABLE directory_user_rows ADD CONSTRAINT directory_user_rows_generation_id_scope_id_tenant_id_fkey FOREIGN KEY (generation_id, scope_id, tenant_id) REFERENCES data_generations (id, scope_id, tenant_id);

ALTER TABLE directory_service_plan_rows ADD CONSTRAINT directory_service_plan_rows_generation_id_scope_id_tenant__fkey FOREIGN KEY (generation_id, scope_id, tenant_id, user_id) REFERENCES directory_user_rows (generation_id, scope_id, tenant_id, identity);

ALTER TABLE app_activity_rows ADD CONSTRAINT app_activity_rows_generation_id_scope_id_tenant_id_fkey FOREIGN KEY (generation_id, scope_id, tenant_id) REFERENCES data_generations (id, scope_id, tenant_id);

ALTER TABLE data_generation_pins ADD CONSTRAINT data_generation_pins_selection_id_tenant_id_fkey FOREIGN KEY (selection_id, tenant_id) REFERENCES data_read_selections (id, tenant_id);

ALTER TABLE data_generation_pins ADD CONSTRAINT data_generation_pins_scope_id_tenant_id_fkey FOREIGN KEY (scope_id, tenant_id) REFERENCES data_scope_epochs (id, tenant_id);

ALTER TABLE data_generation_pins ADD CONSTRAINT data_generation_pins_generation_id_scope_id_tenant_id_fkey FOREIGN KEY (generation_id, scope_id, tenant_id) REFERENCES data_generations (id, scope_id, tenant_id);

ALTER TABLE data_exports ADD CONSTRAINT data_exports_selection_id_tenant_id_fkey FOREIGN KEY (selection_id, tenant_id) REFERENCES data_read_selections (id, tenant_id);

ALTER TABLE data_export_items ADD CONSTRAINT data_export_items_export_id_tenant_id_fkey FOREIGN KEY (export_id, tenant_id) REFERENCES data_exports (id, tenant_id);

ALTER TABLE data_export_chunks ADD CONSTRAINT data_export_chunks_export_id_tenant_id_fkey FOREIGN KEY (export_id, tenant_id) REFERENCES data_exports (id, tenant_id);

ALTER TABLE user_source_attempts ADD CONSTRAINT user_source_attempts_generation_id_scope_id_tenant_id_fkey FOREIGN KEY (generation_id, scope_id, tenant_id) REFERENCES data_generations (id, scope_id, tenant_id);

ALTER TABLE user_source_queries ADD CONSTRAINT user_source_queries_generation_id_scope_id_tenant_id_fkey FOREIGN KEY (generation_id, scope_id, tenant_id) REFERENCES data_generations (id, scope_id, tenant_id);

ALTER TABLE user_source_query_members ADD CONSTRAINT user_source_query_members_generation_id_query_key_fkey FOREIGN KEY (generation_id, query_key) REFERENCES user_source_queries (generation_id, query_key);

ALTER TABLE user_source_skus ADD CONSTRAINT user_source_skus_generation_id_scope_id_tenant_id_fkey FOREIGN KEY (generation_id, scope_id, tenant_id) REFERENCES data_generations (id, scope_id, tenant_id);

ALTER TABLE user_source_identity_inputs ADD CONSTRAINT user_source_identity_inputs_generation_id_scope_id_tenant__fkey FOREIGN KEY (generation_id, scope_id, tenant_id) REFERENCES data_generations (id, scope_id, tenant_id);

ALTER TABLE user_source_read_contexts ADD CONSTRAINT user_source_read_contexts_selection_id_tenant_id_fkey FOREIGN KEY (selection_id, tenant_id) REFERENCES data_read_selections (id, tenant_id);

ALTER TABLE official_usage_history_state ADD CONSTRAINT official_usage_history_state_scope_id_tenant_id_fkey FOREIGN KEY (scope_id, tenant_id) REFERENCES data_scope_epochs (id, tenant_id);

ALTER TABLE official_usage_history_memberships ADD CONSTRAINT official_usage_history_memberships_set_id_tenant_id_fkey FOREIGN KEY (set_id, tenant_id) REFERENCES official_usage_sets (id, tenant_id);

ALTER TABLE official_usage_history_memberships ADD CONSTRAINT official_usage_history_memberships_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES official_usage_history_state (tenant_id);

ALTER TABLE official_usage_ingestions ADD CONSTRAINT official_usage_ingestions_staging_id_fkey FOREIGN KEY (staging_id) REFERENCES official_usage_staging (id);

ALTER TABLE official_usage_ingestions ADD CONSTRAINT official_usage_ingestions_version_id_fkey FOREIGN KEY (version_id) REFERENCES official_usage_versions (id);

ALTER TABLE official_usage_ingestions ADD CONSTRAINT official_usage_ingestions_correction_of_tenant_id_fkey FOREIGN KEY (correction_of, tenant_id) REFERENCES official_usage_sets (id, tenant_id);

ALTER TABLE official_usage_ingestions ADD CONSTRAINT official_usage_ingestions_tenant_id_principal_id_fkey FOREIGN KEY (tenant_id, principal_id) REFERENCES data_principal_epochs (tenant_id, principal_id);

ALTER TABLE official_usage_ingestion_rows ADD CONSTRAINT official_usage_ingestion_rows_ingestion_id_tenant_id_princ_fkey FOREIGN KEY (ingestion_id, tenant_id, principal_id) REFERENCES official_usage_ingestions (id, tenant_id, principal_id);

ALTER TABLE official_usage_read_contexts ADD CONSTRAINT official_usage_read_contexts_selection_id_tenant_id_fkey FOREIGN KEY (selection_id, tenant_id) REFERENCES data_read_selections (id, tenant_id);

ALTER TABLE official_usage_read_contexts ADD CONSTRAINT official_usage_read_contexts_set_id_tenant_id_fkey FOREIGN KEY (set_id, tenant_id) REFERENCES official_usage_sets (id, tenant_id);

ALTER TABLE inventory_attempts ADD CONSTRAINT inventory_attempts_generation_id_scope_id_tenant_id_fkey FOREIGN KEY (generation_id, scope_id, tenant_id) REFERENCES data_generations (id, scope_id, tenant_id);

ALTER TABLE inventory_roots ADD CONSTRAINT inventory_roots_baseline_id_scope_id_tenant_id_fkey FOREIGN KEY (baseline_id, scope_id, tenant_id) REFERENCES data_generations (id, scope_id, tenant_id);

ALTER TABLE inventory_keys ADD CONSTRAINT inventory_keys_generation_id_scope_id_tenant_id_fkey FOREIGN KEY (generation_id, scope_id, tenant_id) REFERENCES data_generations (id, scope_id, tenant_id);

ALTER TABLE package_record_rows ADD CONSTRAINT package_record_rows_generation_id_scope_id_tenant_id_ident_fkey FOREIGN KEY (generation_id, scope_id, tenant_id, identity) REFERENCES inventory_keys (generation_id, scope_id, tenant_id, identity);

ALTER TABLE power_platform_record_rows ADD CONSTRAINT power_platform_record_rows_generation_id_scope_id_tenant_i_fkey FOREIGN KEY (generation_id, scope_id, tenant_id, identity) REFERENCES inventory_keys (generation_id, scope_id, tenant_id, identity);

ALTER TABLE unified_agent_rows ADD CONSTRAINT unified_agent_rows_generation_id_scope_id_tenant_id_identi_fkey FOREIGN KEY (generation_id, scope_id, tenant_id, identity) REFERENCES inventory_keys (generation_id, scope_id, tenant_id, identity);

ALTER TABLE inventory_exact_heads ADD CONSTRAINT inventory_exact_heads_generation_id_scope_id_tenant_id_ide_fkey FOREIGN KEY (generation_id, scope_id, tenant_id, identity) REFERENCES inventory_keys (generation_id, scope_id, tenant_id, identity);

ALTER TABLE inventory_facts ADD CONSTRAINT inventory_facts_generation_id_scope_id_tenant_id_identity_fkey FOREIGN KEY (generation_id, scope_id, tenant_id, identity) REFERENCES inventory_keys (generation_id, scope_id, tenant_id, identity);

ALTER TABLE inventory_memberships ADD CONSTRAINT inventory_memberships_baseline_id_scope_id_tenant_id_fkey FOREIGN KEY (baseline_id, scope_id, tenant_id) REFERENCES inventory_roots (baseline_id, scope_id, tenant_id);

ALTER TABLE inventory_memberships ADD CONSTRAINT inventory_memberships_generation_id_scope_id_tenant_id_ide_fkey FOREIGN KEY (generation_id, scope_id, tenant_id, identity) REFERENCES inventory_keys (generation_id, scope_id, tenant_id, identity);

ALTER TABLE inventory_revisions ADD CONSTRAINT inventory_revisions_baseline_id_scope_id_tenant_id_fkey FOREIGN KEY (baseline_id, scope_id, tenant_id) REFERENCES inventory_roots (baseline_id, scope_id, tenant_id);

ALTER TABLE inventory_revisions ADD CONSTRAINT inventory_revisions_generation_id_scope_id_tenant_id_fkey FOREIGN KEY (generation_id, scope_id, tenant_id) REFERENCES data_generations (id, scope_id, tenant_id);

ALTER TABLE inventory_compaction_refs ADD CONSTRAINT inventory_compaction_refs_generation_id_scope_id_tenant_id_fkey FOREIGN KEY (generation_id, scope_id, tenant_id) REFERENCES data_generations (id, scope_id, tenant_id);

ALTER TABLE inventory_compaction_refs ADD CONSTRAINT inventory_compaction_refs_source_generation_id_scope_id_te_fkey FOREIGN KEY (source_generation_id, scope_id, tenant_id, identity) REFERENCES inventory_keys (generation_id, scope_id, tenant_id, identity);

ALTER TABLE inventory_canonical_ids ADD CONSTRAINT inventory_canonical_ids_scope_id_tenant_id_fkey FOREIGN KEY (scope_id, tenant_id) REFERENCES data_scope_epochs (id, tenant_id);

ALTER TABLE inventory_changes ADD CONSTRAINT inventory_changes_scope_id_tenant_id_fkey FOREIGN KEY (scope_id, tenant_id) REFERENCES data_scope_epochs (id, tenant_id);

ALTER TABLE inventory_pages ADD CONSTRAINT inventory_pages_generation_id_scope_id_tenant_id_fkey FOREIGN KEY (generation_id, scope_id, tenant_id) REFERENCES data_generations (id, scope_id, tenant_id);

ALTER TABLE inventory_worker_pins ADD CONSTRAINT inventory_worker_pins_baseline_id_scope_id_tenant_id_fkey FOREIGN KEY (baseline_id, scope_id, tenant_id) REFERENCES data_generations (id, scope_id, tenant_id);

ALTER TABLE inventory_reconciliation ADD CONSTRAINT inventory_reconciliation_scope_id_tenant_id_fkey FOREIGN KEY (scope_id, tenant_id) REFERENCES data_scope_epochs (id, tenant_id);

ALTER TABLE inventory_reconciliation_keys ADD CONSTRAINT inventory_reconciliation_keys_scope_id_fkey FOREIGN KEY (scope_id) REFERENCES inventory_reconciliation (scope_id);

ALTER TABLE unified_agent_memberships ADD CONSTRAINT unified_agent_memberships_generation_id_scope_id_tenant_id_fkey FOREIGN KEY (generation_id, scope_id, tenant_id, identity) REFERENCES inventory_keys (generation_id, scope_id, tenant_id, identity);

ALTER TABLE unified_agent_memberships ADD CONSTRAINT unified_agent_memberships_source_generation_id_source_scop_fkey FOREIGN KEY (source_generation_id, source_scope_id, tenant_id, source_identity) REFERENCES inventory_keys (generation_id, scope_id, tenant_id, identity);

ALTER TABLE inventory_read_contexts ADD CONSTRAINT inventory_read_contexts_selection_id_tenant_id_fkey FOREIGN KEY (selection_id, tenant_id) REFERENCES data_read_selections (id, tenant_id);

ALTER TABLE inventory_refresh_targets ADD CONSTRAINT inventory_refresh_targets_job_id_fkey FOREIGN KEY (job_id) REFERENCES package_refresh_jobs (id) ON DELETE CASCADE;

ALTER TABLE inventory_control_pending ADD CONSTRAINT inventory_control_pending_observation_id_fkey FOREIGN KEY (observation_id) REFERENCES package_inventory_snapshots (id) ON DELETE CASCADE;

ALTER TABLE inventory_mutation_stages ADD CONSTRAINT inventory_mutation_stages_selection_id_fkey FOREIGN KEY (selection_id) REFERENCES data_read_selections (id) ON DELETE CASCADE;

ALTER TABLE inventory_mutation_stages ADD CONSTRAINT inventory_mutation_stages_job_id_fkey FOREIGN KEY (job_id) REFERENCES jobs (id) ON DELETE SET NULL;

ALTER TABLE inventory_mutation_targets ADD CONSTRAINT inventory_mutation_targets_stage_id_fkey FOREIGN KEY (stage_id) REFERENCES inventory_mutation_stages (id) ON DELETE CASCADE;

ALTER TABLE inventory_mutation_targets ADD CONSTRAINT inventory_mutation_targets_source_generation_id_fkey FOREIGN KEY (source_generation_id) REFERENCES data_generations (id);

ALTER TABLE inventory_native_control_pending ADD CONSTRAINT inventory_native_control_pending_scope_id_fkey FOREIGN KEY (scope_id) REFERENCES data_scope_epochs (id) ON DELETE CASCADE;

ALTER TABLE inventory_native_control_pending ADD CONSTRAINT inventory_native_control_pending_observation_id_fkey FOREIGN KEY (observation_id) REFERENCES copilot_quarantine_status_observations (id) ON DELETE CASCADE;

ALTER TABLE inventory_collection_progress ADD CONSTRAINT inventory_collection_progress_scope_id_tenant_id_fkey FOREIGN KEY (scope_id, tenant_id) REFERENCES data_scope_epochs (id, tenant_id) ON DELETE CASCADE;

ALTER TABLE data_generation_charges ADD CONSTRAINT data_generation_charges_scope_id_tenant_id_fkey FOREIGN KEY (scope_id, tenant_id) REFERENCES data_scope_epochs (id, tenant_id);

ALTER TABLE official_usage_membership_counts ADD CONSTRAINT official_usage_membership_counts_version_id_tenant_id_kind_fkey FOREIGN KEY (version_id, tenant_id, kind) REFERENCES official_usage_versions (id, tenant_id, kind) ON DELETE CASCADE;

CREATE TRIGGER immutable_job_intent
  BEFORE UPDATE
  ON jobs
  FOR EACH ROW
    EXECUTE PROCEDURE public.protect_job_intent();

CREATE TRIGGER immutable_item_target
  BEFORE UPDATE
  ON job_items
  FOR EACH ROW
    EXECUTE PROCEDURE public.protect_item_target();

CREATE TRIGGER immutable_official_usage_version
  BEFORE UPDATE
  ON official_usage_versions
  FOR EACH ROW
    EXECUTE PROCEDURE public.protect_official_usage_version();

CREATE TRIGGER immutable_official_usage_staging
  BEFORE UPDATE
  ON official_usage_staging
  FOR EACH ROW
    EXECUTE PROCEDURE public.protect_official_usage_staging();

CREATE TRIGGER immutable_official_usage_artifact
  BEFORE UPDATE
  ON official_usage_artifacts
  FOR EACH ROW
    EXECUTE PROCEDURE public.protect_official_usage_artifact();

CREATE TRIGGER immutable_official_usage_set
  BEFORE UPDATE
  ON official_usage_sets
  FOR EACH ROW
    EXECUTE PROCEDURE public.protect_official_usage_set();

CREATE TRIGGER immutable_official_usage_membership
  BEFORE INSERT OR DELETE OR UPDATE
  ON official_usage_set_versions
  FOR EACH ROW
    EXECUTE PROCEDURE public.protect_official_usage_membership();

CREATE TRIGGER immutable_official_usage_version_row
  BEFORE INSERT OR DELETE OR UPDATE
  ON official_usage_version_rows
  FOR EACH ROW
    EXECUTE PROCEDURE public.protect_official_usage_version_row();

CREATE TRIGGER valid_official_usage_state
  BEFORE UPDATE
  ON official_usage_state
  FOR EACH ROW
    EXECUTE PROCEDURE public.protect_official_usage_state();

CREATE TRIGGER immutable_copilot_quarantine_job
  BEFORE UPDATE
  ON copilot_quarantine_jobs
  FOR EACH ROW
    EXECUTE PROCEDURE public.protect_copilot_quarantine_job_intent();

CREATE TRIGGER immutable_copilot_quarantine_item
  BEFORE UPDATE
  ON copilot_quarantine_job_items
  FOR EACH ROW
    EXECUTE PROCEDURE public.protect_copilot_quarantine_item_target();

CREATE TRIGGER immutable_official_usage_row_fact
  BEFORE DELETE OR UPDATE
  ON official_usage_row_facts
  FOR EACH ROW
    EXECUTE PROCEDURE public.protect_official_usage_row_fact();

CREATE TRIGGER immutable_data_sync_run_intent
  BEFORE UPDATE
  ON data_sync_runs
  FOR EACH ROW
    EXECUTE PROCEDURE public.protect_data_sync_run_intent();

CREATE TRIGGER immutable_data_sync_source_identity
  BEFORE UPDATE
  ON data_sync_run_sources
  FOR EACH ROW
    EXECUTE PROCEDURE public.protect_data_sync_source_identity();

CREATE TRIGGER clear_admitted_data_sync_snapshots
  AFTER INSERT
  ON data_sync_runs
  FOR EACH ROW
    WHEN (new.clear_saved_data)
    EXECUTE PROCEDURE public.clear_admitted_data_sync_snapshots();

CREATE TRIGGER protect_agent_usage_association
  BEFORE INSERT OR UPDATE
  ON agent_usage_associations
  FOR EACH ROW
    EXECUTE PROCEDURE public.protect_agent_usage_association();

CREATE TRIGGER advance_agent_usage_revision
  AFTER INSERT OR DELETE
  ON agent_usage_associations
  FOR EACH ROW
    EXECUTE PROCEDURE public.advance_agent_usage_revision();

CREATE TRIGGER delete_agent_usage_report_associations
  AFTER UPDATE OF deleted_at
  ON official_usage_sets
  FOR EACH ROW
    WHEN (old.deleted_at IS NULL AND new.deleted_at IS NOT NULL)
    EXECUTE PROCEDURE public.delete_agent_usage_report_associations();

CREATE TRIGGER clear_admitted_agent_people
  AFTER INSERT
  ON data_sync_runs
  FOR EACH ROW
    WHEN (new.clear_saved_data)
    EXECUTE PROCEDURE public.clear_admitted_agent_people();

CREATE TRIGGER clear_admitted_agent_identities
  AFTER INSERT
  ON data_sync_runs
  FOR EACH ROW
    WHEN (new.clear_saved_data)
    EXECUTE PROCEDURE public.clear_admitted_agent_identities();

CREATE TRIGGER data_epoch_guard
  BEFORE UPDATE
  ON data_principal_epochs
  FOR EACH ROW
    EXECUTE PROCEDURE public.data_protect_epoch();

CREATE TRIGGER data_epoch_guard
  BEFORE UPDATE
  ON data_scope_epochs
  FOR EACH ROW
    EXECUTE PROCEDURE public.data_protect_epoch();

CREATE TRIGGER data_generation_intent
  BEFORE UPDATE
  ON data_generations
  FOR EACH ROW
    EXECUTE PROCEDURE public.data_protect_generation();

CREATE TRIGGER data_head_fence
  BEFORE UPDATE
  ON data_generation_heads
  FOR EACH ROW
    EXECUTE PROCEDURE public.data_protect_head();

CREATE TRIGGER data_immutable
  BEFORE INSERT OR DELETE OR UPDATE
  ON directory_user_rows
  FOR EACH ROW
    EXECUTE PROCEDURE public.data_protect_record();

CREATE TRIGGER data_immutable
  BEFORE INSERT OR DELETE OR UPDATE
  ON app_activity_rows
  FOR EACH ROW
    EXECUTE PROCEDURE public.data_protect_record();

CREATE TRIGGER data_immutable
  BEFORE INSERT OR DELETE OR UPDATE
  ON data_generation_batches
  FOR EACH ROW
    EXECUTE PROCEDURE public.data_protect_record();

CREATE TRIGGER data_immutable
  BEFORE INSERT OR DELETE OR UPDATE
  ON data_generation_pages
  FOR EACH ROW
    EXECUTE PROCEDURE public.data_protect_record();

CREATE TRIGGER data_selection_intent
  BEFORE UPDATE
  ON data_read_selections
  FOR EACH ROW
    EXECUTE PROCEDURE public.data_protect_selection();

CREATE TRIGGER data_export_intent
  BEFORE UPDATE
  ON data_exports
  FOR EACH ROW
    EXECUTE PROCEDURE public.data_protect_export_intent();

CREATE TRIGGER data_immutable
  BEFORE INSERT OR DELETE OR UPDATE
  ON data_export_chunks
  FOR EACH ROW
    EXECUTE PROCEDURE public.data_protect_chunk();

CREATE TRIGGER data_immutable
  BEFORE INSERT OR DELETE OR UPDATE
  ON data_export_items
  FOR EACH ROW
    EXECUTE PROCEDURE public.data_protect_chunk();

CREATE TRIGGER user_source_fence
  BEFORE INSERT OR DELETE OR UPDATE
  ON user_source_attempts
  FOR EACH ROW
    EXECUTE PROCEDURE public.user_source_guard();

CREATE TRIGGER user_source_fence
  BEFORE INSERT OR DELETE OR UPDATE
  ON user_source_queries
  FOR EACH ROW
    EXECUTE PROCEDURE public.user_source_guard();

CREATE TRIGGER user_source_fence
  BEFORE INSERT OR DELETE OR UPDATE
  ON user_source_query_members
  FOR EACH ROW
    EXECUTE PROCEDURE public.user_source_guard();

CREATE TRIGGER user_source_fence
  BEFORE INSERT OR DELETE OR UPDATE
  ON user_source_skus
  FOR EACH ROW
    EXECUTE PROCEDURE public.user_source_guard();

CREATE TRIGGER user_source_fence
  BEFORE INSERT OR DELETE OR UPDATE
  ON user_source_identity_inputs
  FOR EACH ROW
    EXECUTE PROCEDURE public.user_source_guard();

CREATE TRIGGER official_history_state_guard
  BEFORE INSERT OR UPDATE
  ON official_usage_history_state
  FOR EACH ROW
    EXECUTE PROCEDURE public.official_usage_history_state_guard();

CREATE TRIGGER official_history_membership_guard
  BEFORE INSERT OR DELETE OR UPDATE
  ON official_usage_history_memberships
  FOR EACH ROW
    EXECUTE PROCEDURE public.official_usage_history_guard();

CREATE TRIGGER official_upload_row_guard
  BEFORE INSERT OR DELETE
  ON official_usage_ingestion_rows
  FOR EACH ROW
    EXECUTE PROCEDURE public.official_usage_ingestion_guard();

CREATE TRIGGER official_upload_intent_guard
  BEFORE UPDATE
  ON official_usage_ingestions
  FOR EACH ROW
    EXECUTE PROCEDURE public.official_usage_ingestion_guard();

CREATE TRIGGER official_acceptance_receipt_guard
  BEFORE UPDATE
  ON official_usage_ingestions
  FOR EACH ROW
    EXECUTE PROCEDURE public.official_usage_acceptance_guard();

CREATE TRIGGER preserve_user_people_identity
  BEFORE UPDATE
  ON agent_people_cache
  FOR EACH ROW
    EXECUTE PROCEDURE public.preserve_user_people_identity();

CREATE TRIGGER invalidate_user_people_insert
  AFTER INSERT
  ON agent_people_cache REFERENCING NEW TABLE AS changed
  FOR EACH STATEMENT
    EXECUTE PROCEDURE public.invalidate_user_people_reads();

CREATE TRIGGER invalidate_user_people_update
  AFTER UPDATE
  ON agent_people_cache REFERENCING NEW TABLE AS changed
  FOR EACH STATEMENT
    EXECUTE PROCEDURE public.invalidate_user_people_reads();

CREATE TRIGGER invalidate_user_people_delete
  AFTER DELETE
  ON agent_people_cache REFERENCING OLD TABLE AS changed
  FOR EACH STATEMENT
    EXECUTE PROCEDURE public.invalidate_user_people_reads();

CREATE TRIGGER data_export_actor_guard
  BEFORE UPDATE
  ON data_exports
  FOR EACH ROW
    EXECUTE PROCEDURE public.data_export_actor_immutable();

CREATE TRIGGER inventory_exact_fence
  BEFORE INSERT OR DELETE OR UPDATE
  ON inventory_exact_heads
  FOR EACH ROW
    EXECUTE PROCEDURE public.inventory_exact_guard();

CREATE TRIGGER inventory_audit_insert
  AFTER INSERT
  ON audit_events REFERENCING NEW TABLE AS changed
  FOR EACH STATEMENT
    EXECUTE PROCEDURE public.inventory_invalidate_audit_reads();

CREATE TRIGGER inventory_audit_delete
  AFTER DELETE
  ON audit_events REFERENCING OLD TABLE AS changed
  FOR EACH STATEMENT
    EXECUTE PROCEDURE public.inventory_invalidate_audit_reads();

CREATE TRIGGER inventory_control_fence
  AFTER INSERT
  ON package_inventory_snapshots
  FOR EACH ROW
    EXECUTE PROCEDURE public.inventory_fence_control_readback();

CREATE TRIGGER inventory_revision_fence
  BEFORE DELETE
  ON inventory_revisions
  FOR EACH ROW
    EXECUTE PROCEDURE public.inventory_revision_guard();

CREATE TRIGGER inventory_reachability
  BEFORE UPDATE
  ON data_generations
  FOR EACH ROW
    EXECUTE PROCEDURE public.inventory_reachability_guard();

CREATE TRIGGER inventory_immutable
  BEFORE INSERT OR DELETE OR UPDATE
  ON package_record_rows
  FOR EACH ROW
    EXECUTE PROCEDURE public.inventory_content_guard();

CREATE TRIGGER inventory_immutable
  BEFORE INSERT OR DELETE OR UPDATE
  ON power_platform_record_rows
  FOR EACH ROW
    EXECUTE PROCEDURE public.inventory_content_guard();

CREATE TRIGGER inventory_immutable
  BEFORE INSERT OR DELETE OR UPDATE
  ON unified_agent_rows
  FOR EACH ROW
    EXECUTE PROCEDURE public.inventory_content_guard();

CREATE TRIGGER inventory_immutable
  BEFORE INSERT OR DELETE OR UPDATE
  ON inventory_keys
  FOR EACH ROW
    EXECUTE PROCEDURE public.inventory_content_guard();

CREATE TRIGGER inventory_immutable
  BEFORE INSERT OR DELETE OR UPDATE
  ON unified_agent_memberships
  FOR EACH ROW
    EXECUTE PROCEDURE public.inventory_content_guard();

CREATE TRIGGER inventory_immutable
  BEFORE INSERT OR DELETE OR UPDATE
  ON inventory_compaction_refs
  FOR EACH ROW
    EXECUTE PROCEDURE public.inventory_content_guard();

CREATE TRIGGER job_results_insert
  AFTER INSERT
  ON job_items REFERENCING NEW TABLE AS new_results
  FOR EACH STATEMENT
    EXECUTE PROCEDURE public.advance_job_result_revision();

CREATE TRIGGER job_results_update
  AFTER UPDATE
  ON job_items REFERENCING OLD TABLE AS old_results  NEW TABLE AS new_results
  FOR EACH STATEMENT
    EXECUTE PROCEDURE public.advance_job_result_revision();

CREATE TRIGGER job_results_delete
  AFTER DELETE
  ON job_items REFERENCING OLD TABLE AS old_results
  FOR EACH STATEMENT
    EXECUTE PROCEDURE public.advance_job_result_revision();

CREATE TRIGGER fence_inventory_application_configuration
  AFTER INSERT OR DELETE OR UPDATE
  ON capability_configuration
  FOR EACH ROW
    EXECUTE PROCEDURE public.fence_inventory_application_configuration();

CREATE TRIGGER protect_inventory_identity_cache
  BEFORE INSERT OR UPDATE
  ON agent_identity_cache
  FOR EACH ROW
    EXECUTE PROCEDURE public.protect_inventory_identity_cache();

CREATE TRIGGER inventory_usage_control_fence
  BEFORE INSERT OR UPDATE
  ON agent_usage_associations
  FOR EACH ROW
    EXECUTE PROCEDURE public.inventory_require_control_publication();

CREATE TRIGGER inventory_mutation_stage_immutable
  BEFORE UPDATE
  ON inventory_mutation_stages
  FOR EACH ROW
    EXECUTE PROCEDURE public.protect_inventory_mutation_stage();

CREATE TRIGGER inventory_mutation_target_immutable
  BEFORE INSERT OR UPDATE
  ON inventory_mutation_targets
  FOR EACH ROW
    EXECUTE PROCEDURE public.protect_inventory_mutation_target();

CREATE TRIGGER inventory_native_control_fence
  AFTER INSERT
  ON copilot_quarantine_status_observations
  FOR EACH ROW
    EXECUTE PROCEDURE public.inventory_fence_native_readback();

CREATE TRIGGER inventory_selection_criteria_guard
  BEFORE UPDATE
  ON inventory_mutation_stages
  FOR EACH ROW
    EXECUTE PROCEDURE public.protect_inventory_selection_criteria();

CREATE TRIGGER inventory_observe_people_insert
  AFTER INSERT
  ON agent_people_cache REFERENCING NEW TABLE AS changed
  FOR EACH STATEMENT
    EXECUTE PROCEDURE public.inventory_observe_people();

CREATE TRIGGER inventory_observe_people_update
  AFTER UPDATE
  ON agent_people_cache REFERENCING NEW TABLE AS changed
  FOR EACH STATEMENT
    EXECUTE PROCEDURE public.inventory_observe_people();

CREATE TRIGGER inventory_observe_people_delete
  AFTER DELETE
  ON agent_people_cache REFERENCING OLD TABLE AS changed
  FOR EACH STATEMENT
    EXECUTE PROCEDURE public.inventory_observe_people();

CREATE TRIGGER inventory_query_context_guard
  BEFORE UPDATE
  ON inventory_read_contexts
  FOR EACH ROW
    EXECUTE PROCEDURE public.protect_inventory_query_context();

CREATE TRIGGER inventory_attempt_guard
  BEFORE UPDATE
  ON inventory_attempts
  FOR EACH ROW
    EXECUTE PROCEDURE public.protect_inventory_attempt();

CREATE TRIGGER inventory_detail_target_revision
  BEFORE INSERT OR UPDATE
  ON inventory_refresh_targets
  FOR EACH ROW
    EXECUTE PROCEDURE public.inventory_detail_target_revision_guard();

CREATE TRIGGER job_inventory_authority_immutable
  BEFORE UPDATE
  ON job_items
  FOR EACH ROW
    EXECUTE PROCEDURE public.protect_job_inventory_authority();

CREATE TRIGGER export_idempotency_guard
  BEFORE UPDATE
  ON data_exports
  FOR EACH ROW
    EXECUTE PROCEDURE public.protect_export_idempotency();

CREATE TRIGGER inventory_interval_fence
  BEFORE DELETE OR UPDATE
  ON inventory_memberships
  FOR EACH ROW
    EXECUTE PROCEDURE public.inventory_interval_guard();

CREATE TRIGGER inventory_interval_insert_fence
  AFTER INSERT
  ON inventory_memberships REFERENCING NEW TABLE AS inserted_inventory_memberships
  FOR EACH STATEMENT
    EXECUTE PROCEDURE public.inventory_interval_insert_guard();

CREATE TRIGGER inventory_prepared_member_fence
  BEFORE DELETE
  ON inventory_memberships
  FOR EACH ROW
    EXECUTE PROCEDURE public.inventory_prepared_member_guard();

CREATE TRIGGER data_generation_charge
  AFTER INSERT OR DELETE OR UPDATE
  ON data_generations
  FOR EACH ROW
    EXECUTE PROCEDURE public.data_update_generation_charge();

CREATE TRIGGER ac_inventory_memberships_delete_rewind
  AFTER DELETE
  ON inventory_memberships REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT
    EXECUTE PROCEDURE public.ac_inventory_memberships_delete_rewind();

CREATE TRIGGER ac_inventory_memberships_update_rewind
  AFTER UPDATE
  ON inventory_memberships REFERENCING OLD TABLE AS old_rows  NEW TABLE AS new_rows
  FOR EACH STATEMENT
    EXECUTE PROCEDURE public.ac_inventory_memberships_update_rewind();

CREATE TRIGGER ac_unified_agent_memberships_delete_rewind
  AFTER DELETE
  ON unified_agent_memberships REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT
    EXECUTE PROCEDURE public.ac_unified_agent_memberships_delete_rewind();

CREATE TRIGGER ac_unified_agent_memberships_update_rewind
  AFTER UPDATE
  ON unified_agent_memberships REFERENCING OLD TABLE AS old_rows  NEW TABLE AS new_rows
  FOR EACH STATEMENT
    EXECUTE PROCEDURE public.ac_unified_agent_memberships_update_rewind();

CREATE TRIGGER ac_inventory_compaction_refs_delete_rewind
  AFTER DELETE
  ON inventory_compaction_refs REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT
    EXECUTE PROCEDURE public.ac_inventory_compaction_refs_delete_rewind();

CREATE TRIGGER ac_inventory_compaction_refs_update_rewind
  AFTER UPDATE
  ON inventory_compaction_refs REFERENCING OLD TABLE AS old_rows  NEW TABLE AS new_rows
  FOR EACH STATEMENT
    EXECUTE PROCEDURE public.ac_inventory_compaction_refs_update_rewind();

CREATE TRIGGER ac_inventory_exact_heads_delete_rewind
  AFTER DELETE
  ON inventory_exact_heads REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT
    EXECUTE PROCEDURE public.ac_inventory_exact_heads_delete_rewind();

CREATE TRIGGER ac_inventory_exact_heads_update_rewind
  AFTER UPDATE
  ON inventory_exact_heads REFERENCING OLD TABLE AS old_rows  NEW TABLE AS new_rows
  FOR EACH STATEMENT
    EXECUTE PROCEDURE public.ac_inventory_exact_heads_update_rewind();

CREATE TRIGGER ac_inventory_generation_collectable_rewind
  AFTER UPDATE
  ON data_generations REFERENCING OLD TABLE AS old_rows  NEW TABLE AS new_rows
  FOR EACH STATEMENT
    EXECUTE PROCEDURE public.ac_inventory_generation_collectable_rewind();

CREATE TRIGGER data_immutable
  BEFORE DELETE OR UPDATE
  ON directory_service_plan_rows
  FOR EACH ROW
    EXECUTE PROCEDURE public.data_protect_record();

CREATE TRIGGER child_insert_fence
  AFTER INSERT
  ON directory_service_plan_rows REFERENCING NEW TABLE AS inserted_children
  FOR EACH STATEMENT
    EXECUTE PROCEDURE public.directory_service_plan_rows_insert_guard();

CREATE TRIGGER inventory_immutable
  BEFORE DELETE OR UPDATE
  ON inventory_facts
  FOR EACH ROW
    EXECUTE PROCEDURE public.inventory_content_guard();

CREATE TRIGGER child_insert_fence
  AFTER INSERT
  ON inventory_facts REFERENCING NEW TABLE AS inserted_children
  FOR EACH STATEMENT
    EXECUTE PROCEDURE public.inventory_facts_insert_guard();

CREATE TRIGGER official_membership_count_insert
  AFTER INSERT
  ON official_usage_version_rows REFERENCING NEW TABLE AS inserted_memberships
  FOR EACH STATEMENT
    EXECUTE PROCEDURE public.official_usage_membership_count();

CREATE TRIGGER official_membership_count_delete
  AFTER DELETE
  ON official_usage_version_rows REFERENCING OLD TABLE AS deleted_memberships
  FOR EACH STATEMENT
    EXECUTE PROCEDURE public.official_usage_membership_count();

CREATE TRIGGER official_membership_count_update
  AFTER UPDATE
  ON official_usage_version_rows REFERENCING OLD TABLE AS deleted_memberships
                                             NEW TABLE AS inserted_memberships
  FOR EACH STATEMENT
    EXECUTE PROCEDURE public.official_usage_membership_count();

CREATE TRIGGER user_source_report_period_fence
  BEFORE UPDATE OF report_period
  ON user_source_attempts
  FOR EACH ROW
    EXECUTE PROCEDURE public.user_source_protect_report_period();

CREATE TRIGGER inventory_classification_write
  BEFORE INSERT
  ON inventory_facts
  FOR EACH ROW
    EXECUTE PROCEDURE public.inventory_classification_fact_guard();

REVOKE ALL PRIVILEGES
  ON FUNCTION official_usage_payload_hash (jsonb)
  FROM PUBLIC;

REVOKE ALL PRIVILEGES
  ON FUNCTION protect_official_usage_row_fact ()
  FROM PUBLIC;

GRANT EXECUTE
  ON FUNCTION official_usage_payload_hash (jsonb)
  TO agentcontrol_app;

GRANT SELECT, INSERT
  ON TABLE official_usage_row_facts
  TO agentcontrol_app;

REVOKE ALL PRIVILEGES
  ON FUNCTION clear_admitted_data_sync_snapshots ()
  FROM PUBLIC;

REVOKE ALL PRIVILEGES
  ON FUNCTION protect_agent_usage_association ()
  FROM PUBLIC;

REVOKE ALL PRIVILEGES
  ON FUNCTION advance_agent_usage_revision ()
  FROM PUBLIC;

REVOKE ALL PRIVILEGES
  ON FUNCTION delete_agent_usage_report_associations ()
  FROM PUBLIC;

REVOKE ALL PRIVILEGES
  ON FUNCTION clear_admitted_agent_people ()
  FROM PUBLIC;

REVOKE ALL PRIVILEGES
  ON FUNCTION clear_admitted_agent_identities ()
  FROM PUBLIC;

REVOKE ALL PRIVILEGES
  ON FUNCTION preserve_user_people_identity ()
  FROM PUBLIC;

REVOKE ALL PRIVILEGES
  ON FUNCTION invalidate_user_people_reads ()
  FROM PUBLIC;

REVOKE ALL PRIVILEGES
  ON FUNCTION inventory_association_revision (text)
  FROM PUBLIC;

REVOKE ALL PRIVILEGES
  ON FUNCTION inventory_invalidate_audit_reads ()
  FROM PUBLIC;

REVOKE ALL PRIVILEGES
  ON FUNCTION inventory_fence_control_readback ()
  FROM PUBLIC;

REVOKE ALL PRIVILEGES
  ON FUNCTION fence_inventory_application_configuration ()
  FROM PUBLIC;

REVOKE ALL PRIVILEGES
  ON FUNCTION protect_inventory_identity_cache ()
  FROM PUBLIC;

REVOKE ALL PRIVILEGES
  ON FUNCTION inventory_require_control_publication ()
  FROM PUBLIC;

REVOKE ALL PRIVILEGES
  ON FUNCTION inventory_fence_native_readback ()
  FROM PUBLIC;

REVOKE ALL PRIVILEGES
  ON FUNCTION protect_inventory_selection_criteria ()
  FROM PUBLIC;

REVOKE ALL PRIVILEGES
  ON FUNCTION inventory_observe_people ()
  FROM PUBLIC;

REVOKE ALL PRIVILEGES
  ON FUNCTION protect_inventory_query_context ()
  FROM PUBLIC;

REVOKE ALL PRIVILEGES
  ON FUNCTION protect_inventory_attempt ()
  FROM PUBLIC;

REVOKE ALL PRIVILEGES
  ON FUNCTION inventory_interval_insert_guard ()
  FROM PUBLIC;

REVOKE ALL PRIVILEGES
  ON FUNCTION inventory_prepared_member_guard ()
  FROM PUBLIC;

REVOKE ALL PRIVILEGES
  ON FUNCTION data_update_generation_charge ()
  FROM PUBLIC;

REVOKE ALL PRIVILEGES
  ON TABLE data_generation_charges
  FROM PUBLIC, agentcontrol_app;

GRANT SELECT
  ON TABLE data_generation_charges
  TO agentcontrol_app;

REVOKE ALL PRIVILEGES
  ON FUNCTION directory_service_plan_rows_insert_guard ()
  FROM PUBLIC, agentcontrol_app;

REVOKE ALL PRIVILEGES
  ON FUNCTION inventory_facts_insert_guard ()
  FROM PUBLIC, agentcontrol_app;

REVOKE ALL PRIVILEGES
  ON FUNCTION official_usage_membership_count ()
  FROM PUBLIC, agentcontrol_app;

REVOKE ALL PRIVILEGES
  ON TABLE official_usage_membership_counts
  FROM PUBLIC, agentcontrol_app;

GRANT SELECT
  ON TABLE official_usage_membership_counts
  TO agentcontrol_app;

REVOKE ALL PRIVILEGES
  ON FUNCTION inventory_classification_fact_guard ()
  FROM PUBLIC;

INSERT INTO operational_state (singleton, mode, provider_work_enabled)
VALUES (TRUE, 'normal', TRUE);

INSERT INTO data_lifecycle_progress (worker)
VALUES ('records')
     , ('inventory')
     , ('inventory_metadata')
     , ('operator')
     , ('report_payloads')
     , ('report_staging');
`;
