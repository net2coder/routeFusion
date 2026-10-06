create extension if not exists pgcrypto;

create table if not exists public.rf_providers (
  id text not null,
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  base_url text not null,
  api_key_env text,
  api_key_ciphertext text,
  key_hint text,
  priority integer not null default 100,
  timeout_ms integer not null default 30000,
  enabled boolean not null default true,
  status text not null default 'unknown',
  latency integer,
  cooldown_until bigint not null default 0,
  failures integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (owner_id,id)
);

create table if not exists public.rf_models (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  logical_model_id text not null,
  provider_id text not null,
  provider_model_id text not null,
  display_name text not null,
  capabilities jsonb not null default '{"chat":true,"streaming":true,"tools":false,"vision":false,"reasoning":false}'::jsonb,
  context_window integer,
  enabled boolean not null default true,
  priority integer not null default 100,
  created_at timestamptz not null default now(),
  constraint rf_models_provider_fk foreign key (owner_id,provider_id) references public.rf_providers(owner_id,id) on delete cascade,
  unique (owner_id,logical_model_id,provider_id,provider_model_id)
);

create table if not exists public.rf_client_keys (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  prefix text not null,
  key_hash text not null unique,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

create table if not exists public.rf_request_logs (
  id text primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  api_key_id uuid references public.rf_client_keys(id) on delete set null,
  api_key_name text not null,
  time timestamptz not null default now(),
  virtual_model text not null,
  provider text not null,
  actual_model text not null,
  latency integer not null default 0,
  tokens integer,
  status integer not null,
  attempts jsonb not null default '[]'::jsonb
);
create index if not exists rf_request_logs_owner_time_idx on public.rf_request_logs(owner_id,time desc);
create index if not exists rf_request_logs_owner_key_idx on public.rf_request_logs(owner_id,api_key_id,time desc);

create table if not exists public.rf_rate_limits (
  subject_hash text not null,
  window_start timestamptz not null,
  request_count integer not null default 0,
  primary key (subject_hash,window_start)
);

alter table public.rf_providers enable row level security;
alter table public.rf_models enable row level security;
alter table public.rf_client_keys enable row level security;
alter table public.rf_request_logs enable row level security;
alter table public.rf_rate_limits enable row level security;
revoke all on public.rf_providers,public.rf_models,public.rf_client_keys,public.rf_request_logs,public.rf_rate_limits from anon,authenticated;
grant all on public.rf_providers,public.rf_models,public.rf_client_keys,public.rf_request_logs,public.rf_rate_limits to service_role;

create or replace function public.rf_consume_rate_limit(p_subject_hash text,p_limit integer default 120)
returns boolean language plpgsql security definer set search_path=public as $$
declare current_window timestamptz := date_trunc('minute',now()); current_count integer;
begin
  insert into public.rf_rate_limits(subject_hash,window_start,request_count) values(p_subject_hash,current_window,1)
  on conflict(subject_hash,window_start) do update set request_count=rf_rate_limits.request_count+1
  returning request_count into current_count;
  if random()<0.01 then delete from public.rf_rate_limits where window_start<current_window-interval '1 day'; end if;
  return current_count<=p_limit;
end;
$$;
revoke all on function public.rf_consume_rate_limit(text,integer) from public,anon,authenticated;
grant execute on function public.rf_consume_rate_limit(text,integer) to service_role;

create or replace function public.rf_replace_config(p_owner_id uuid,p_providers jsonb,p_models jsonb)
returns void language plpgsql security definer set search_path=public as $$
begin
  delete from public.rf_models where owner_id=p_owner_id;
  delete from public.rf_providers where owner_id=p_owner_id;
  insert into public.rf_providers(id,owner_id,name,base_url,api_key_env,api_key_ciphertext,key_hint,priority,timeout_ms,enabled,status,latency,cooldown_until,failures)
  select x.id,p_owner_id,x.name,x.base_url,x.api_key_env,x.api_key_ciphertext,x.key_hint,x.priority,x.timeout_ms,x.enabled,coalesce(x.status,'unknown'),x.latency,coalesce(x.cooldown_until,0),coalesce(x.failures,0)
  from jsonb_to_recordset(coalesce(p_providers,'[]'::jsonb)) as x(id text,name text,base_url text,api_key_env text,api_key_ciphertext text,key_hint text,priority integer,timeout_ms integer,enabled boolean,status text,latency integer,cooldown_until bigint,failures integer);
  insert into public.rf_models(id,owner_id,logical_model_id,provider_id,provider_model_id,display_name,capabilities,context_window,enabled,priority)
  select case when x.id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then x.id::uuid else gen_random_uuid() end,p_owner_id,x.logical_model_id,x.provider_id,x.provider_model_id,x.display_name,x.capabilities,x.context_window,x.enabled,x.priority
  from jsonb_to_recordset(coalesce(p_models,'[]'::jsonb)) as x(id text,logical_model_id text,provider_id text,provider_model_id text,display_name text,capabilities jsonb,context_window integer,enabled boolean,priority integer);
end;
$$;
revoke all on function public.rf_replace_config(uuid,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.rf_replace_config(uuid,jsonb,jsonb) to service_role;

create or replace function public.rf_record_request(p_owner_id uuid,p_row jsonb)
returns void language plpgsql security definer set search_path=public as $$
begin
  insert into public.rf_request_logs(id,owner_id,api_key_id,api_key_name,time,virtual_model,provider,actual_model,latency,tokens,status,attempts)
  values(p_row->>'id',p_owner_id,nullif(p_row->>'api_key_id','')::uuid,coalesce(p_row->>'api_key_name','Unknown'),coalesce((p_row->>'time')::timestamptz,now()),coalesce(p_row->>'virtual_model',''),coalesce(p_row->>'provider',''),coalesce(p_row->>'actual_model',''),coalesce((p_row->>'latency')::integer,0),nullif(p_row->>'tokens','')::integer,(p_row->>'status')::integer,coalesce(p_row->'attempts','[]'::jsonb));
  delete from public.rf_request_logs where owner_id=p_owner_id and id in (
    select id from public.rf_request_logs where owner_id=p_owner_id order by time desc offset 10000
  );
end;
$$;
revoke all on function public.rf_record_request(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.rf_record_request(uuid,jsonb) to service_role;

create or replace function public.rf_key_request_counts(p_owner_id uuid)
returns table(api_key_id uuid,request_count bigint) language sql stable security definer set search_path=public as $$
  select l.api_key_id,count(*) from public.rf_request_logs l where l.owner_id=p_owner_id and l.api_key_id is not null group by l.api_key_id;
$$;
revoke all on function public.rf_key_request_counts(uuid) from public,anon,authenticated;
grant execute on function public.rf_key_request_counts(uuid) to service_role;

create or replace function public.rf_overview_summary(p_owner_id uuid)
returns jsonb language sql stable security definer set search_path=public as $$
  select jsonb_build_object(
    'totalRequests',count(*),
    'success',case when count(*)=0 then null else round(100.0*count(*) filter(where status=200)/count(*),1) end,
    'failed',count(*) filter(where status<>200),
    'avgLatency',round(avg(latency)),
    'failovers',count(*) filter(where jsonb_array_length(attempts)>1),
    'logs',coalesce((select jsonb_agg(jsonb_build_object('id',x.id,'time',x.time,'virtualModel',x.virtual_model,'provider',x.provider,'actualModel',x.actual_model,'latency',x.latency,'tokens',x.tokens,'status',x.status,'attempts',x.attempts,'apiKeyId',x.api_key_id,'apiKeyName',x.api_key_name) order by x.time desc) from (select * from public.rf_request_logs where owner_id=p_owner_id order by time desc limit 50) x),'[]'::jsonb)
  ) from public.rf_request_logs where owner_id=p_owner_id;
$$;
revoke all on function public.rf_overview_summary(uuid) from public,anon,authenticated;
grant execute on function public.rf_overview_summary(uuid) to service_role;

create or replace function public.rf_usage_summary(p_owner_id uuid)
returns jsonb language sql stable security definer set search_path=public as $$
  with recent as (select * from public.rf_request_logs where owner_id=p_owner_id and time>=now()-interval '24 hours'),
  models as (select virtual_model,count(*) requests,coalesce(sum(tokens),0) tokens from recent group by virtual_model),
  providers as (select provider,count(*) requests from recent group by provider),
  hourly_buckets as (
    select series.bucket_hour as bucket_hour, count(log.id) as request_count
    from generate_series(
      date_trunc('hour',now())-interval '23 hours',
      date_trunc('hour',now()),
      interval '1 hour'
    ) as series(bucket_hour)
    left join recent as log
      on log.time>=series.bucket_hour
      and log.time<series.bucket_hour+interval '1 hour'
    group by series.bucket_hour
  )
  select jsonb_build_object(
    'retention','Up to 10,000 requests','total',(select count(*) from public.rf_request_logs where owner_id=p_owner_id),'last24Hours',(select count(*) from recent),'requests',(select count(*) from recent),'failed',(select count(*) from recent where status<200 or status>=400),'tokens',(select coalesce(sum(tokens),0) from recent),
    'byModel',coalesce((select jsonb_agg(jsonb_build_object('model',virtual_model,'requests',requests,'tokens',tokens) order by requests desc) from models),'[]'::jsonb),
    'byProvider',coalesce((select jsonb_agg(jsonb_build_object('provider',provider,'requests',requests) order by requests desc) from providers),'[]'::jsonb),
    'hourly',coalesce((select jsonb_agg(jsonb_build_object('hour',bucket_hour,'requests',request_count) order by bucket_hour) from hourly_buckets),'[]'::jsonb),
    'logs',coalesce((select jsonb_agg(jsonb_build_object('id',x.id,'time',x.time,'virtualModel',x.virtual_model,'provider',x.provider,'actualModel',x.actual_model,'latency',x.latency,'tokens',x.tokens,'status',x.status,'attempts',x.attempts,'apiKeyId',x.api_key_id,'apiKeyName',x.api_key_name) order by x.time desc) from (select * from public.rf_request_logs where owner_id=p_owner_id order by time desc limit 500) x),'[]'::jsonb)
  );
$$;
revoke all on function public.rf_usage_summary(uuid) from public,anon,authenticated;
grant execute on function public.rf_usage_summary(uuid) to service_role;

comment on table public.rf_request_logs is 'Gateway request metadata only. Prompts and completion content must never be stored here.';
