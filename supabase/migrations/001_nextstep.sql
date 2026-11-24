begin;

create table if not exists public.ns_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null check (length(name) between 2 and 80),
  role text not null check (length(role) between 1 and 120),
  country text not null check (length(country) between 2 and 100),
  skills text not null default '' check (length(skills) <= 500),
  work_mode text not null default 'Any' check (work_mode in ('Any','Remote','On-site')),
  agent_enabled boolean not null default true,
  cv_path text, cv_name text, cv_type text,
  updated_at timestamptz not null default now()
);
create table if not exists public.ns_jobs (
  id text primary key, data jsonb not null, fingerprint text not null,
  eligible_countries text[] not null default '{}',
  published_at timestamptz not null, first_seen timestamptz not null default now()
);
create index if not exists ns_jobs_published on public.ns_jobs(published_at desc);
create index if not exists ns_jobs_countries on public.ns_jobs using gin(eligible_countries);
create table if not exists public.ns_applications (
  user_id uuid references auth.users(id) on delete cascade, job_id text references public.ns_jobs(id),
  status text not null check (status in ('Applied','Interview','Offer','Rejected','Withdrawn')),
  notes text not null default '' check (length(notes) <= 5000), follow_up date,
  updated_at timestamptz not null default now(), primary key(user_id,job_id)
);
create table if not exists public.ns_saved (
  user_id uuid references auth.users(id) on delete cascade, job_id text references public.ns_jobs(id),
  primary key(user_id,job_id)
);
create table if not exists public.ns_activities (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  message text not null, created_at timestamptz not null default now()
);
create index if not exists ns_activities_user on public.ns_activities(user_id,id desc);
create table if not exists public.ns_sessions (
  token_hash text primary key, user_id uuid not null references auth.users(id) on delete cascade,
  payload text not null, expires_at timestamptz not null,
  recovery boolean not null default false, recovery_expires timestamptz,
  refresh_lock_until timestamptz not null default '-infinity'
);
create index if not exists ns_sessions_user on public.ns_sessions(user_id);
create table if not exists public.ns_meta (
  key text primary key, value jsonb not null
);
create table if not exists public.ns_rate_limits (
  key text primary key, count integer not null, until_at timestamptz not null
);
create table if not exists public.ns_job_events (
  id bigint generated always as identity primary key, job_id text not null references public.ns_jobs(id),
  kind text not null check (kind in ('new','updated')), created_at timestamptz not null default now()
);
create table if not exists public.ns_telegram_links (
  user_id uuid primary key references auth.users(id) on delete cascade,
  chat_id text unique not null, enabled boolean not null default true,
  min_score integer not null default 60 check (min_score between 40 and 100),
  cursor bigint not null, last_digest timestamptz not null
);
create table if not exists public.ns_telegram_pending (
  user_id uuid primary key references auth.users(id) on delete cascade,
  token_hash text unique not null, expires_at timestamptz not null,
  chat_id text, code_hash text, attempts integer not null default 0
);
create table if not exists public.ns_telegram_queue (
  id bigint generated always as identity primary key,
  user_id uuid references auth.users(id) on delete cascade, event_key text not null,
  text text not null, status text not null default 'pending' check (status in ('pending','sending','sent','failed')),
  attempts integer not null default 0, next_attempt timestamptz not null default now(),
  lease_id uuid, lease_expires timestamptz, error text, created_at timestamptz not null default now(),
  unique(user_id,event_key)
);
create index if not exists ns_telegram_due on public.ns_telegram_queue(status,next_attempt);

alter table public.ns_profiles enable row level security;
alter table public.ns_jobs enable row level security;
alter table public.ns_applications enable row level security;
alter table public.ns_saved enable row level security;
alter table public.ns_activities enable row level security;
alter table public.ns_sessions enable row level security;
alter table public.ns_meta enable row level security;
alter table public.ns_rate_limits enable row level security;
alter table public.ns_job_events enable row level security;
alter table public.ns_telegram_links enable row level security;
alter table public.ns_telegram_pending enable row level security;
alter table public.ns_telegram_queue enable row level security;

drop policy if exists ns_profile_own on public.ns_profiles;
create policy ns_profile_own on public.ns_profiles for all to authenticated
  using (id=(select auth.uid())) with check (id=(select auth.uid()));
drop policy if exists ns_jobs_public on public.ns_jobs;
create policy ns_jobs_public on public.ns_jobs for select to anon,authenticated using (true);
drop policy if exists ns_applications_own on public.ns_applications;
create policy ns_applications_own on public.ns_applications for select to authenticated using (user_id=(select auth.uid()));
drop policy if exists ns_saved_own on public.ns_saved;
create policy ns_saved_own on public.ns_saved for select to authenticated using (user_id=(select auth.uid()));
drop policy if exists ns_activity_own on public.ns_activities;
create policy ns_activity_own on public.ns_activities for select to authenticated using (user_id=(select auth.uid()));

revoke all on public.ns_profiles,public.ns_jobs,public.ns_applications,public.ns_saved,
  public.ns_activities,public.ns_sessions,public.ns_meta,public.ns_rate_limits,
  public.ns_job_events,public.ns_telegram_links,public.ns_telegram_pending,public.ns_telegram_queue from anon,authenticated;
grant select on public.ns_jobs to anon,authenticated;
grant select on public.ns_profiles,public.ns_applications,public.ns_saved,public.ns_activities to authenticated;
grant update(name,role,country,skills,work_mode,agent_enabled) on public.ns_profiles to authenticated;
grant all on public.ns_profiles,public.ns_jobs,public.ns_applications,public.ns_saved,
  public.ns_activities,public.ns_sessions,public.ns_meta,public.ns_rate_limits,
  public.ns_job_events,public.ns_telegram_links,public.ns_telegram_pending,public.ns_telegram_queue to service_role;
grant usage,select on sequence public.ns_activities_id_seq,public.ns_job_events_id_seq,public.ns_telegram_queue_id_seq to service_role;

create or replace function public.ns_new_user() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  insert into public.ns_profiles(id,name,role,country,skills,work_mode,agent_enabled)
    values(new.id,coalesce(new.raw_user_meta_data->>'name','New user'),
      coalesce(new.raw_user_meta_data->>'role','Job seeker'),
      coalesce(new.raw_user_meta_data->>'country','Netherlands'),
      coalesce(new.raw_user_meta_data->>'skills',''),
      coalesce(new.raw_user_meta_data->>'workMode','Any'),
      coalesce((new.raw_user_meta_data->>'agentEnabled')::boolean,true));
  insert into public.ns_activities(user_id,message) values(new.id,'Your search profile is ready. Confirm your email to get started.');
  return new;
end $$;
drop trigger if exists nextstep_on_auth_user_created on auth.users;
create trigger nextstep_on_auth_user_created after insert on auth.users for each row execute function public.ns_new_user();

create or replace function public.ns_profile_changed() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  new.updated_at:=now();
  if row(new.name,new.role,new.country,new.skills,new.work_mode,new.agent_enabled)
    is distinct from row(old.name,old.role,old.country,old.skills,old.work_mode,old.agent_enabled) then
    insert into public.ns_activities(user_id,message) values(new.id,'Search preferences updated. Your matches have been recalculated.');
    update public.ns_telegram_links set cursor=coalesce((select max(id) from public.ns_job_events),0),last_digest=now() where user_id=new.id;
    delete from public.ns_telegram_queue where user_id=new.id and status in ('pending','sending');
  end if;
  return new;
end $$;
drop trigger if exists nextstep_profile_changed on public.ns_profiles;
create trigger nextstep_profile_changed before update on public.ns_profiles for each row execute function public.ns_profile_changed();

create or replace function public.ns_profile_json(p public.ns_profiles) returns jsonb
language sql stable set search_path='' as $$
  select case when p.id is null then null else jsonb_build_object(
    'id',p.id,'name',p.name,'role',p.role,'country',p.country,'skills',p.skills,
    'workMode',p.work_mode,'agentEnabled',p.agent_enabled,'cvName',p.cv_name) end
$$;

create or replace function public.ns_match(j jsonb, eligible text[], p jsonb) returns jsonb
language sql immutable set search_path='' as $$
  with skills as (
    select btrim(s) skill from regexp_split_to_table(coalesce(p->>'skills',''),',') s where btrim(s)<>''
  ), matched as (
    select skill,strpos(lower(concat(j->>'title',' ',
      (select string_agg(t,' ') from jsonb_array_elements_text(j->'tags') t),' ',j->>'description')),lower(skill))>0 ok from skills
  ), words as (
    select w from regexp_split_to_table(lower(coalesce(p->>'role','')),'\s+') w where length(w)>2
  ), flags as (
    select coalesce((p->>'country')=any(eligible),false) country_ok,
      (coalesce(p->>'workMode','Any')='Any' or
        ((p->>'workMode'='Remote')=coalesce((j->>'remote')::boolean,false))) work_ok
  )
  select case when p is null then '{}'::jsonb else jsonb_build_object(
    'score',round(
      coalesce((select count(*) filter(where ok)::numeric/nullif(count(*),0)*40 from matched),0)+
      coalesce((select count(*) filter(where strpos(lower(j->>'title'),w)>0)::numeric/nullif(count(*),0)*35 from words),0)+
      case when country_ok then 15 else 0 end+case when work_ok then 10 else 0 end),
    'matchedSkills',coalesce((select jsonb_agg(skill) from matched where ok),'[]'::jsonb),
    'countryMatch',country_ok,'workMatch',work_ok) end from flags
$$;

create or replace function public.ns_job_page(
  p_country text default 'All countries',p_query text default '',p_tab text default 'all',
  p_sort text default 'match',p_source text default 'all',p_offset integer default 0,p_limit integer default 60
) returns jsonb language sql stable security definer set search_path='' as $$
  with profile as (select public.ns_profile_json(p) value from public.ns_profiles p where id=auth.uid()),
  scored as (
    select j.*,public.ns_match(data,eligible_countries,(select value from profile)) m from public.ns_jobs j
    where published_at>now()-interval '45 days'
  ), filtered as (
    select * from scored where
      (p_country='All countries' or p_country=any(eligible_countries))
      and strpos(lower(concat(data->>'title',' ',data->>'company',' ',data->'tags',' ',data->>'description')),lower(left(p_query,200)))>0
      and (p_source='all' or data->>'source'=p_source)
      and (p_tab<>'remote' or (data->>'remote')::boolean)
      and (p_tab<>'best' or coalesce((m->>'score')::integer,0)>=60)
      and (p_tab<>'new' or published_at>now()-interval '3 days')
  ), page as (
    select (data-'description')||m item
    from filtered order by
      case when p_sort='company' then data->>'company' end asc,
      case when p_sort='match' then coalesce((m->>'score')::integer,0) end desc,
      published_at desc,id
    offset greatest(0,p_offset) limit least(60,greatest(1,p_limit))
  )
  select jsonb_build_object('jobs',coalesce((select jsonb_agg(item) from page),'[]'::jsonb),
    'total',(select count(*) from filtered),'offset',greatest(0,p_offset),
    'nextOffset',case when (select count(*) from filtered)>greatest(0,p_offset)+least(60,greatest(1,p_limit))
      then greatest(0,p_offset)+least(60,greatest(1,p_limit)) else null end)
$$;

create or replace function public.ns_state() returns jsonb
language sql stable security definer set search_path='' as $$
  with me as (select * from public.ns_profiles where id=auth.uid()),
  owned as (
    select job_id from public.ns_saved where user_id=auth.uid()
    union select job_id from public.ns_applications where user_id=auth.uid()
  )
  select jsonb_build_object(
    'user',(select public.ns_profile_json(me) from me),
    'applications',coalesce((select jsonb_agg(jsonb_build_object('jobId',job_id,'status',status,'notes',notes,
      'followUp',coalesce(follow_up::text,''),'updatedAt',updated_at)) from public.ns_applications where user_id=auth.uid()),'[]'::jsonb),
    'saved',coalesce((select jsonb_agg(job_id) from public.ns_saved where user_id=auth.uid()),'[]'::jsonb),
    'activities',coalesce((select jsonb_agg(a order by id desc) from
      (select id,message,created_at from public.ns_activities where user_id=auth.uid() order by id desc limit 20) a),'[]'::jsonb),
    'ownedJobs',coalesce((select jsonb_agg((j.data-'description')||public.ns_match(j.data,j.eligible_countries,
      (select public.ns_profile_json(me) from me))) from public.ns_jobs j join owned o on o.job_id=j.id),'[]'::jsonb),
    'matchedCount',(select count(*) from public.ns_jobs j cross join me where j.published_at>now()-interval '45 days'
      and (public.ns_match(j.data,j.eligible_countries,public.ns_profile_json(me))->>'score')::integer>=40
      and me.country=any(j.eligible_countries) and (me.work_mode='Any' or ((me.work_mode='Remote')=(j.data->>'remote')::boolean))),
    'sync',coalesce((select value from public.ns_meta where key='syncResult'),'{"sources":[]}'::jsonb),
    'lastSync',(select value #>> '{}' from public.ns_meta where key='lastSuccess'),
    'telegram',jsonb_build_object(
      'linked',exists(select 1 from public.ns_telegram_links where user_id=auth.uid()),
      'enabled',coalesce((select enabled from public.ns_telegram_links where user_id=auth.uid()),false),
      'minScore',coalesce((select min_score from public.ns_telegram_links where user_id=auth.uid()),60),
      'pending',exists(select 1 from public.ns_telegram_pending where user_id=auth.uid() and expires_at>now()),
      'delivery',(select jsonb_build_object('status',status,'error',error,'createdAt',created_at)
        from public.ns_telegram_queue where user_id=auth.uid() order by id desc limit 1)
    )
  )
$$;

create or replace function public.ns_toggle_saved(p_job text) returns boolean
language plpgsql security definer set search_path='' as $$
declare u uuid:=auth.uid();
begin
  if u is null then raise insufficient_privilege; end if;
  if not exists(select 1 from public.ns_jobs where id=p_job) then raise sqlstate 'PT404' using message='Job not found.'; end if;
  perform pg_advisory_xact_lock(hashtextextended('saved:'||u::text,0));
  if exists(select 1 from public.ns_saved where user_id=u and job_id=p_job) then
    delete from public.ns_saved where user_id=u and job_id=p_job; return false;
  end if;
  if (select count(*) from public.ns_saved where user_id=u)>=500 then raise sqlstate 'PT400' using message='Maximum 500 saved jobs reached.'; end if;
  insert into public.ns_saved values(u,p_job); return true;
end $$;

create or replace function public.ns_save_application(p_job text,p_status text,p_notes text,p_follow_up date) returns void
language plpgsql security definer set search_path='' as $$
declare u uuid:=auth.uid(); j jsonb;
begin
  if u is null then raise insufficient_privilege; end if;
  perform pg_advisory_xact_lock(hashtextextended('applications:'||u::text,0));
  select data into j from public.ns_jobs where id=p_job;
  if j is null then raise sqlstate 'PT404' using message='Job not found.'; end if;
  if not exists(select 1 from public.ns_applications where user_id=u and job_id=p_job)
    and (select count(*) from public.ns_applications where user_id=u)>=500 then
      raise sqlstate 'PT400' using message='Maximum 500 tracked applications reached.';
  end if;
  insert into public.ns_applications(user_id,job_id,status,notes,follow_up)
    values(u,p_job,p_status,p_notes,p_follow_up)
    on conflict(user_id,job_id) do update set status=excluded.status,notes=excluded.notes,
      follow_up=excluded.follow_up,updated_at=now();
  insert into public.ns_activities(user_id,message) values(u,p_status||': '||(j->>'title')||' at '||(j->>'company'));
end $$;

create or replace function public.ns_rate_limit(p_key text,p_max integer,p_seconds integer default 900) returns boolean
language plpgsql security definer set search_path='' as $$
declare n integer;
begin
  insert into public.ns_rate_limits values(p_key,1,now()+make_interval(secs=>p_seconds))
    on conflict(key) do update set
      count=case when ns_rate_limits.until_at<=now() then 1 else ns_rate_limits.count+1 end,
      until_at=case when ns_rate_limits.until_at<=now() then now()+make_interval(secs=>p_seconds) else ns_rate_limits.until_at end
    returning count into n;
  return n<=p_max;
end $$;

create or replace function public.ns_claim_feed_refresh() returns boolean
language plpgsql security definer set search_path='' as $$
declare previous timestamptz;
begin
  perform pg_advisory_xact_lock(hashtextextended('nextstep-feed',0));
  select (value #>> '{}')::timestamptz into previous from public.ns_meta where key='lastAttempt';
  if previous>now()-interval '15 minutes' then return false; end if;
  insert into public.ns_meta values('lastAttempt',to_jsonb(now())) on conflict(key) do update set value=excluded.value;
  return true;
end $$;

create or replace function public.ns_import_jobs(p_jobs jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r jsonb; old_hash text; added integer:=0; updated integer:=0; j jsonb;
begin
  if jsonb_array_length(p_jobs)>100 then raise sqlstate 'PT400' using message='Import batch too large.'; end if;
  perform pg_advisory_xact_lock(hashtextextended('nextstep-import',0));
  for r in select * from jsonb_array_elements(p_jobs) loop
    j:=r->'data';
    select fingerprint into old_hash from public.ns_jobs where id=j->>'id';
    if old_hash is not distinct from r->>'fingerprint' then continue; end if;
    insert into public.ns_jobs(id,data,fingerprint,eligible_countries,published_at)
      values(j->>'id',j,r->>'fingerprint',array(select jsonb_array_elements_text(r->'eligibleCountries')),(j->>'publishedAt')::timestamptz)
      on conflict(id) do update set data=excluded.data,fingerprint=excluded.fingerprint,
        eligible_countries=excluded.eligible_countries,published_at=excluded.published_at;
    insert into public.ns_job_events(job_id,kind) values(j->>'id',case when old_hash is null then 'new' else 'updated' end);
    if old_hash is null then added:=added+1;
    else
      updated:=updated+1;
      insert into public.ns_activities(user_id,message)
        select user_id,'Listing updated: '||(j->>'title')||' at '||(j->>'company')||'. Review the source.'
        from public.ns_applications where job_id=j->>'id';
    end if;
  end loop;
  return jsonb_build_object('added',added,'updated',updated);
end $$;

create or replace function public.ns_claim_session_refresh(p_hash text) returns boolean
language plpgsql security definer set search_path='' as $$
begin
  update public.ns_sessions set refresh_lock_until=now()+interval '30 seconds'
    where token_hash=p_hash and expires_at>now() and refresh_lock_until<=now();
  return found;
end $$;

create or replace function public.ns_replace_cv(p_user uuid,p_path text,p_name text,p_type text,p_expected text) returns text
language plpgsql security definer set search_path='' as $$
declare previous text;
begin
  select cv_path into previous from public.ns_profiles where id=p_user for update;
  if not found then raise sqlstate 'PT404' using message='Account not found.'; end if;
  if previous is distinct from p_expected then raise sqlstate 'PT409' using message='Your CV changed in another request. Refresh your profile.'; end if;
  if p_path is not null and (left(p_path,length(p_user::text)+1)<>p_user::text||'/' or p_path like '%..%') then
    raise sqlstate 'PT400' using message='Invalid private CV path.';
  end if;
  update public.ns_profiles set cv_path=p_path,cv_name=p_name,cv_type=p_type,updated_at=now() where id=p_user;
  return previous;
end $$;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
  values('nextstep-cvs','nextstep-cvs',false,4194304,array['application/pdf','text/plain'])
  on conflict(id) do update set public=false,file_size_limit=4194304,allowed_mime_types=excluded.allowed_mime_types;
drop policy if exists nextstep_cv_read_own on storage.objects;
create policy nextstep_cv_read_own on storage.objects for select to authenticated
  using(bucket_id='nextstep-cvs' and (storage.foldername(name))[1]=(select auth.uid())::text);

do $$
declare f record;
begin
  for f in select unnest(array[
    'public.ns_new_user()','public.ns_profile_changed()','public.ns_profile_json(public.ns_profiles)',
    'public.ns_match(jsonb,text[],jsonb)','public.ns_job_page(text,text,text,text,text,integer,integer)',
    'public.ns_state()','public.ns_toggle_saved(text)','public.ns_save_application(text,text,text,date)',
    'public.ns_rate_limit(text,integer,integer)','public.ns_claim_feed_refresh()','public.ns_import_jobs(jsonb)',
    'public.ns_claim_session_refresh(text)','public.ns_replace_cv(uuid,text,text,text,text)'
  ])::regprocedure signature loop
    execute format('revoke all on function %s from public,anon,authenticated',f.signature);
    execute format('grant execute on function %s to service_role',f.signature);
  end loop;
end $$;
grant execute on function public.ns_state(),public.ns_job_page(text,text,text,text,text,integer,integer) to anon,authenticated;
grant execute on function public.ns_toggle_saved(text),public.ns_save_application(text,text,text,date) to authenticated;

commit;
