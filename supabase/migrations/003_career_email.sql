begin;
alter table public.ns_profiles add column if not exists linkedin text not null default '';
alter table public.ns_profiles add column if not exists github text not null default '';
alter table public.ns_profiles add column if not exists gitlab text not null default '';
alter table public.ns_profiles add column if not exists cv_text text not null default '' check(length(cv_text)<=60000);
grant update(linkedin,github,gitlab) on public.ns_profiles to authenticated;
alter table public.ns_job_events drop constraint if exists ns_job_events_kind_check;
alter table public.ns_job_events add constraint ns_job_events_kind_check check(kind in ('new','updated','closed'));
create table if not exists public.ns_email_preferences(
  user_id uuid primary key references auth.users(id) on delete cascade,enabled boolean not null default false,
  min_score integer not null default 60 check(min_score between 40 and 100),cursor bigint not null,last_digest timestamptz not null
);
create table if not exists public.ns_email_queue(
  id bigint generated always as identity primary key,user_id uuid not null references auth.users(id) on delete cascade,
  event_key text not null,text text not null,status text not null default 'pending' check(status in ('pending','sending','sent','failed','cancelled')),
  attempts integer not null default 0,next_attempt timestamptz not null default now(),lease_id uuid,lease_expires timestamptz,
  error text,created_at timestamptz not null default now(),unique(user_id,event_key)
);
alter table public.ns_email_preferences enable row level security;
alter table public.ns_email_queue enable row level security;
revoke all on public.ns_email_preferences,public.ns_email_queue from anon,authenticated;
grant all on public.ns_email_preferences,public.ns_email_queue to service_role;
grant usage,select on sequence public.ns_email_queue_id_seq to service_role;
create index if not exists ns_email_due on public.ns_email_queue(status,next_attempt);
create or replace function public.ns_owns_job(p_job text) returns boolean
language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.ns_saved where user_id=auth.uid() and job_id=p_job)
    or exists(select 1 from public.ns_applications where user_id=auth.uid() and job_id=p_job)
$$;
revoke all on function public.ns_owns_job(text) from public;
grant execute on function public.ns_owns_job(text) to anon,authenticated;
drop policy if exists ns_jobs_public on public.ns_jobs;
create policy ns_jobs_public on public.ns_jobs for select to anon,authenticated using (
  (not coalesce((data->>'closed')::boolean,false) and (data->>'expiresAt' is null or (data->>'expiresAt')::timestamptz>now()))
  or public.ns_owns_job(id)
);

create or replace function public.ns_new_user() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  insert into public.ns_profiles(id,name,role,country,skills,work_mode,agent_enabled,linkedin,github,gitlab)
    values(new.id,coalesce(new.raw_user_meta_data->>'name','New user'),coalesce(new.raw_user_meta_data->>'role','Job seeker'),
      coalesce(new.raw_user_meta_data->>'country','Tunisia'),coalesce(new.raw_user_meta_data->>'skills',''),
      coalesce(new.raw_user_meta_data->>'workMode','Any'),coalesce((new.raw_user_meta_data->>'agentEnabled')::boolean,true),
      left(coalesce(new.raw_user_meta_data->>'linkedin',''),300),left(coalesce(new.raw_user_meta_data->>'github',''),300),left(coalesce(new.raw_user_meta_data->>'gitlab',''),300));
  insert into public.ns_activities(user_id,message) values(new.id,'Your search profile is ready. Confirm your email to get started.');
  return new;
end $$;
create or replace function public.ns_profile_json(p public.ns_profiles) returns jsonb
language sql stable set search_path='' as $$
  select case when p.id is null then null else jsonb_build_object('id',p.id,'name',p.name,'role',p.role,'country',p.country,
    'skills',p.skills,'workMode',p.work_mode,'agentEnabled',p.agent_enabled,'cvName',p.cv_name,
    'linkedin',p.linkedin,'github',p.github,'gitlab',p.gitlab,'hasCvText',length(btrim(p.cv_text))>0) end
$$;
drop function if exists public.ns_set_evidence(text);
create or replace function public.ns_set_evidence(p_text text,p_expected text default null,p_check_path boolean default false) returns void
language plpgsql security definer set search_path='' as $$
begin
  if auth.uid() is null then raise insufficient_privilege; end if;
  if p_text is null or length(p_text)>60000 then raise sqlstate 'PT400' using message='CV text must be at most 60,000 characters.'; end if;
  if p_check_path and p_expected is distinct from (select cv_path from public.ns_profiles where id=auth.uid()) then
    raise sqlstate 'PT409' using message='Your CV changed during extraction. Review the current CV text.';
  end if;
  update public.ns_profiles set cv_text=p_text where id=auth.uid();
end $$;
revoke all on function public.ns_set_evidence(text,text,boolean) from public,anon;
grant execute on function public.ns_set_evidence(text,text,boolean) to authenticated,service_role;

create or replace function public.ns_clear_old_evidence() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if new.cv_path is distinct from old.cv_path then new.cv_text:=''; end if;
  return new;
end $$;
drop trigger if exists nextstep_clear_old_evidence on public.ns_profiles;
create trigger nextstep_clear_old_evidence before update on public.ns_profiles for each row execute function public.ns_clear_old_evidence();
revoke all on function public.ns_clear_old_evidence() from public,anon,authenticated;

create or replace function public.ns_job_page(
  p_country text default 'Tunisia',p_query text default '',p_tab text default 'all',
  p_sort text default 'match',p_source text default 'all',p_offset integer default 0,p_limit integer default 60
) returns jsonb language sql stable security definer set search_path='' as $$
  with profile as (select public.ns_profile_json(p) value from public.ns_profiles p where id=auth.uid()),
  scored as (
    select j.*,public.ns_match(data,eligible_countries,(select value from profile)) m from public.ns_jobs j
    where published_at>now()-interval '45 days' and not coalesce((data->>'closed')::boolean,false)
      and (data->>'expiresAt' is null or (data->>'expiresAt')::timestamptz>now())
  ), filtered as (
    select * from scored where (p_country='All countries' or p_country=any(eligible_countries))
      and strpos(lower(concat(data->>'title',' ',data->>'company',' ',data->'tags',' ',data->>'description')),lower(left(p_query,200)))>0
      and (p_source='all' or data->>'source'=p_source)
      and (p_tab<>'remote' or (data->>'remote')::boolean)
      and (p_tab<>'best' or coalesce((m->>'score')::integer,0)>=60)
      and (p_tab<>'new' or published_at>now()-interval '3 days')
  ), page as (
    select (data-'description')||m item from filtered order by
      case when p_sort='company' then data->>'company' end,
      case when p_sort='match' then coalesce((m->>'score')::integer,0) end desc,published_at desc,id
    offset least(10000,greatest(0,p_offset)) limit least(60,greatest(1,p_limit))
  )
  select jsonb_build_object('jobs',coalesce((select jsonb_agg(item) from page),'[]'::jsonb),
    'total',(select count(*) from filtered),'offset',greatest(0,p_offset),
    'nextOffset',case when (select count(*) from filtered)>greatest(0,p_offset)+least(60,greatest(1,p_limit))
      then greatest(0,p_offset)+least(60,greatest(1,p_limit)) else null end)
$$;

create or replace function public.ns_state() returns jsonb
language sql stable security definer set search_path='' as $$
  with me as (select * from public.ns_profiles where id=auth.uid()),
  owned as (select job_id from public.ns_saved where user_id=auth.uid() union select job_id from public.ns_applications where user_id=auth.uid())
  select jsonb_build_object('user',(select public.ns_profile_json(me) from me),
    'applications',coalesce((select jsonb_agg(jsonb_build_object('jobId',job_id,'status',status,'notes',notes,
      'followUp',coalesce(follow_up::text,''),'updatedAt',updated_at)) from public.ns_applications where user_id=auth.uid()),'[]'::jsonb),
    'saved',coalesce((select jsonb_agg(job_id) from public.ns_saved where user_id=auth.uid()),'[]'::jsonb),
    'activities',coalesce((select jsonb_agg(a order by id desc) from
      (select id,message,created_at from public.ns_activities where user_id=auth.uid() order by id desc limit 20) a),'[]'::jsonb),
    'ownedJobs',coalesce((select jsonb_agg((j.data-'description')||public.ns_match(j.data,j.eligible_countries,
      (select public.ns_profile_json(me) from me))) from public.ns_jobs j join owned o on o.job_id=j.id),'[]'::jsonb),
    'matchedCount',(select count(*) from public.ns_jobs j cross join me where j.published_at>now()-interval '45 days'
      and not coalesce((j.data->>'closed')::boolean,false) and (j.data->>'expiresAt' is null or (j.data->>'expiresAt')::timestamptz>now())
      and (public.ns_match(j.data,j.eligible_countries,public.ns_profile_json(me))->>'score')::integer>=40
      and me.country=any(j.eligible_countries) and (me.work_mode='Any' or ((me.work_mode='Remote')=(j.data->>'remote')::boolean))),
    'sync',coalesce((select value from public.ns_meta where key='syncResult'),'{"sources":[]}'::jsonb),
    'lastSync',(select value #>> '{}' from public.ns_meta where key='lastSuccess'),
    'email',jsonb_build_object('verified',auth.uid() is not null,
      'enabled',coalesce((select enabled from public.ns_email_preferences where user_id=auth.uid()),false),
      'minScore',coalesce((select min_score from public.ns_email_preferences where user_id=auth.uid()),60),
      'delivery',(select jsonb_build_object('status',status,'error',error) from public.ns_email_queue where user_id=auth.uid() order by id desc limit 1))
  )
$$;

create or replace function public.ns_mark_closed(p_ids text[]) returns integer
language plpgsql security definer set search_path='' as $$
declare n integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('nextstep-import',0));
  with changed as (
    update public.ns_jobs set data=(data-'description')||jsonb_build_object('closed',true,'closedAt',now())
      where id=any(p_ids) and data->>'source'='Himalayas' and not coalesce((data->>'closed')::boolean,false) returning id
  ) insert into public.ns_job_events(job_id,kind) select id,'closed' from changed;
  get diagnostics n=row_count;
  return n;
end $$;
revoke all on function public.ns_mark_closed(text[]) from public,anon,authenticated;
grant execute on function public.ns_mark_closed(text[]) to service_role;

create or replace function public.ns_expire_jobs() returns integer
language sql security definer set search_path='' as $$
  select public.ns_mark_closed(coalesce(array_agg(id),'{}'::text[])) from public.ns_jobs
    where data->>'source'='Himalayas' and not coalesce((data->>'closed')::boolean,false)
      and (data->>'expiresAt')::timestamptz<=now()
$$;
revoke all on function public.ns_expire_jobs() from public,anon,authenticated;
grant execute on function public.ns_expire_jobs() to service_role;

create or replace function public.ns_record_availability(p_id text,p_unknown boolean) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
  update public.ns_jobs set data=data||jsonb_build_object('availabilityCheckedAt',now(),'availabilityUnknown',p_unknown)
    where id=p_id and data->>'source'='Himalayas' and not coalesce((data->>'closed')::boolean,false);
  return (select data from public.ns_jobs where id=p_id);
end $$;
revoke all on function public.ns_record_availability(text,boolean) from public,anon,authenticated;
grant execute on function public.ns_record_availability(text,boolean) to service_role;

create or replace function public.ns_import_jobs(p_jobs jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r jsonb; old_hash text; old_closed boolean; added integer:=0; updated integer:=0; j jsonb;
begin
  if jsonb_array_length(p_jobs)>100 then raise sqlstate 'PT400' using message='Import batch too large.'; end if;
  perform pg_advisory_xact_lock(hashtextextended('nextstep-import',0));
  for r in select * from jsonb_array_elements(p_jobs) loop
    j:=r->'data';
    select fingerprint,coalesce((data->>'closed')::boolean,false) into old_hash,old_closed from public.ns_jobs where id=j->>'id';
    if old_closed or old_hash is not distinct from r->>'fingerprint' then continue; end if;
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

create or replace function public.ns_email_settings(p_enabled boolean,p_min_score integer) returns void
language plpgsql security definer set search_path='' as $$
begin
  if auth.uid() is null then raise insufficient_privilege; end if;
  insert into public.ns_email_preferences values(auth.uid(),p_enabled,p_min_score,coalesce((select max(id) from public.ns_job_events),0),now())
    on conflict(user_id) do update set enabled=excluded.enabled,min_score=excluded.min_score,cursor=excluded.cursor,last_digest=now();
  delete from public.ns_email_queue where user_id=auth.uid() and status in ('pending','sending');
end $$;
revoke all on function public.ns_email_settings(boolean,integer) from public,anon;
grant execute on function public.ns_email_settings(boolean,integer) to authenticated,service_role;

create or replace function public.ns_email_reset() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if row(new.role,new.skills,new.country,new.work_mode,new.agent_enabled) is distinct from row(old.role,old.skills,old.country,old.work_mode,old.agent_enabled) then
    update public.ns_email_preferences set cursor=coalesce((select max(id) from public.ns_job_events),0),last_digest=now() where user_id=new.id;
    delete from public.ns_email_queue where user_id=new.id and status in ('pending','sending');
  end if;
  return new;
end $$;
drop trigger if exists nextstep_email_reset on public.ns_profiles;
create trigger nextstep_email_reset after update on public.ns_profiles for each row execute function public.ns_email_reset();
revoke all on function public.ns_email_reset() from public,anon,authenticated;

create or replace function public.ns_prepare_email(p_origin text) returns void
language plpgsql security definer set search_path='' as $$
declare p record; top_id bigint; fresh boolean; closed boolean;
begin
  if exists(select 1 from public.ns_meta where key='lastAttempt'
    and (value #>> '{}')::timestamptz>now()-interval '2 minutes'
    and (value #>> '{}')::timestamptz>coalesce((select (value #>> '{}')::timestamptz from public.ns_meta where key='lastSuccess'),'-infinity'::timestamptz)) then return; end if;
  select coalesce(max(id),0) into top_id from public.ns_job_events;
  for p in select e.*,public.ns_profile_json(pr) profile from public.ns_email_preferences e join public.ns_profiles pr on pr.id=e.user_id
    join auth.users u on u.id=e.user_id where e.enabled and u.email_confirmed_at is not null and e.last_digest<=now()-interval '24 hours'
    order by e.last_digest limit 100 for update of e skip locked loop
    select exists(select 1 from public.ns_job_events ev join public.ns_jobs j on j.id=ev.job_id
      where ev.id>p.cursor and ev.id<=top_id and ev.kind='new' and (p.profile->>'agentEnabled')::boolean
      and not coalesce((j.data->>'closed')::boolean,false) and (j.data->>'expiresAt' is null or (j.data->>'expiresAt')::timestamptz>now())
      and p.profile->>'country'=any(j.eligible_countries)
      and (public.ns_match(j.data,j.eligible_countries,p.profile)->>'workMatch')::boolean
      and (public.ns_match(j.data,j.eligible_countries,p.profile)->>'score')::integer>=p.min_score) into fresh;
    select exists(select 1 from public.ns_job_events ev where ev.id>p.cursor and ev.id<=top_id and ev.kind='closed'
      and (exists(select 1 from public.ns_saved where user_id=p.user_id and job_id=ev.job_id)
        or exists(select 1 from public.ns_applications where user_id=p.user_id and job_id=ev.job_id))) into closed;
    if fresh or closed then
      insert into public.ns_email_queue(user_id,event_key,text) values(p.user_id,'digest:'||to_char(now() at time zone 'UTC','YYYY-MM-DD'),
        'Nextstep daily update'||chr(10)||concat_ws(chr(10),case when fresh then 'New matching jobs are available.' end,
          case when closed then 'A saved or tracked job has been confirmed closed.' end)||chr(10)||'Review privately: '||p_origin||chr(10)||'Manage or disable emails in Profile & preferences.')
        on conflict(user_id,event_key) do nothing;
    end if;
    update public.ns_email_preferences set cursor=top_id,last_digest=now() where user_id=p.user_id;
  end loop;
  delete from public.ns_email_queue where status in ('sent','failed','cancelled') and created_at<now()-interval '30 days';
end $$;
create or replace function public.ns_claim_email(p_lease uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
  update public.ns_email_queue set status='failed',error='Delivery stopped after five attempts.'
    where attempts>=5 and (status='pending' or (status='sending' and lease_expires<=now()));
  with candidate as (
    select q.id from public.ns_email_queue q join public.ns_email_preferences p using(user_id) join auth.users u on u.id=q.user_id
      where p.enabled and u.email_confirmed_at is not null and q.attempts<5 and
        ((q.status='pending' and q.next_attempt<=now()) or (q.status='sending' and q.lease_expires<=now()))
      order by q.id limit 1 for update of q skip locked
  ), claimed as (
    update public.ns_email_queue q set status='sending',lease_id=p_lease,lease_expires=now()+interval '2 minutes',attempts=attempts+1
      from candidate c where c.id=q.id returning q.*
  ) select to_jsonb(c)||jsonb_build_object('email',u.email) into result from claimed c join auth.users u on u.id=c.user_id;
  return result;
end $$;
create or replace function public.ns_email_allowed(p_id bigint,p_email text) returns boolean
language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.ns_email_queue q join public.ns_email_preferences p using(user_id) join auth.users u on u.id=q.user_id
    where q.id=p_id and q.status='sending' and p.enabled and u.email=p_email and u.email_confirmed_at is not null)
$$;
create or replace function public.ns_finish_email(p_id bigint,p_lease uuid,p_result text,p_error text default null) returns void
language plpgsql security definer set search_path='' as $$
begin
  if p_result not in ('retry','sent','cancelled') then raise sqlstate 'PT400' using message='Invalid delivery result.'; end if;
  update public.ns_email_queue set status=case when p_result='retry' then 'pending' else p_result end,
    error=p_error,next_attempt=now()+interval '1 hour',lease_id=null where id=p_id and lease_id=p_lease;
end $$;
revoke all on function public.ns_prepare_email(text),public.ns_claim_email(uuid),public.ns_email_allowed(bigint,text),public.ns_finish_email(bigint,uuid,text,text) from public,anon,authenticated;
grant execute on function public.ns_prepare_email(text),public.ns_claim_email(uuid),public.ns_email_allowed(bigint,text),public.ns_finish_email(bigint,uuid,text,text) to service_role;
commit;
