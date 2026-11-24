begin;
alter table public.ns_profiles add column if not exists account_type text not null default 'jobseeker' check(account_type in ('jobseeker','recruiter'));
create or replace function public.ns_account_type() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  new.account_type:=coalesce((select raw_user_meta_data->>'accountType' from auth.users where id=new.id),'jobseeker');
  if new.account_type not in ('jobseeker','recruiter') then raise sqlstate 'PT400' using message='Invalid account type.'; end if;
  return new;
end $$;
drop trigger if exists nextstep_account_type on public.ns_profiles;
create trigger nextstep_account_type before insert on public.ns_profiles for each row execute function public.ns_account_type();
revoke all on function public.ns_account_type() from public,anon,authenticated;
create or replace function public.ns_profile_json(p public.ns_profiles) returns jsonb
language sql stable set search_path='' as $$
  select case when p.id is null then null else jsonb_build_object('id',p.id,'name',p.name,'role',p.role,'country',p.country,
    'skills',p.skills,'workMode',p.work_mode,'agentEnabled',p.agent_enabled,'cvName',p.cv_name,
    'linkedin',p.linkedin,'github',p.github,'gitlab',p.gitlab,'hasCvText',length(btrim(p.cv_text))>0,'accountType',p.account_type) end
$$;
create table if not exists public.ns_companies(
  user_id uuid primary key references auth.users(id) on delete cascade,data jsonb not null
);
create table if not exists public.ns_postings(
  job_id text primary key references public.ns_jobs(id),user_id uuid not null references auth.users(id) on delete cascade,
  status text not null check(status in ('draft','open','closed')),content jsonb not null
);
create table if not exists public.ns_submissions(
  id uuid primary key default gen_random_uuid(),job_id text not null references public.ns_postings(job_id) on delete cascade,
  candidate_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'Applied' check(status in ('Applied','Shortlisted','Interview','Offer','Rejected','Withdrawn')),
  message text not null check(length(message)<=2000),cv_path text,notes text not null default '' check(length(notes)<=5000),
  interview_at timestamptz,created_at timestamptz not null default now(),unique(job_id,candidate_id)
);
create index if not exists ns_postings_owner on public.ns_postings(user_id);
create index if not exists ns_submissions_candidate on public.ns_submissions(candidate_id);
alter table public.ns_companies enable row level security;
alter table public.ns_postings enable row level security;
alter table public.ns_submissions enable row level security;
revoke all on public.ns_companies,public.ns_postings,public.ns_submissions from anon,authenticated;
grant all on public.ns_companies,public.ns_postings,public.ns_submissions to service_role;

create or replace function public.ns_remove_employer() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  update public.ns_jobs set data=(data-'description')||jsonb_build_object('closed',true,'company','Deleted employer') where id=old.job_id;
  if old.status='open' then insert into public.ns_job_events(job_id,kind) values(old.job_id,'closed'); end if;
  return old;
end $$;
drop trigger if exists nextstep_remove_employer on public.ns_postings;
create trigger nextstep_remove_employer before delete on public.ns_postings for each row execute function public.ns_remove_employer();
revoke all on function public.ns_remove_employer() from public,anon,authenticated;

create or replace function public.ns_recruitment(p_action text,p_data jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare me public.ns_profiles; post public.ns_postings; app public.ns_submissions; co jsonb; j jsonb; k text; mode text; cv text;
begin
  if auth.uid() is null then raise insufficient_privilege; end if;
  select * into strict me from public.ns_profiles where id=auth.uid();
  if p_action='state' then
    if me.account_type='recruiter' then
      return jsonb_build_object('company',(select data from public.ns_companies where user_id=me.id),
        'postings',coalesce((select jsonb_agg(content||jsonb_build_object('id',job_id,'status',status) order by job_id) from public.ns_postings where user_id=me.id),'[]'::jsonb),
        'applicants',coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'jobId',s.job_id,'name',pr.name,'email',u.email,
          'status',s.status,'message',s.message,'notes',s.notes,'interviewAt',s.interview_at,'createdAt',s.created_at,
          'cvAvailable',s.cv_path is not null and s.cv_path=pr.cv_path and s.status<>'Withdrawn') order by s.created_at desc)
          from public.ns_submissions s join public.ns_postings po on po.job_id=s.job_id join public.ns_profiles pr on pr.id=s.candidate_id
          join auth.users u on u.id=s.candidate_id where po.user_id=me.id),'[]'::jsonb));
    end if;
    return jsonb_build_object('applications',coalesce((select jsonb_agg(jsonb_build_object('id',id,'jobId',job_id,'status',status,'interviewAt',interview_at,
      'cvShared',cv_path is not null and cv_path=me.cv_path and status<>'Withdrawn','createdAt',created_at) order by created_at desc)
      from public.ns_submissions where candidate_id=me.id),'[]'::jsonb));
  end if;
  if p_action in ('company','posting','review','cv') and me.account_type<>'recruiter' then raise sqlstate 'PT403' using message='A recruiter account is required.'; end if;
  if p_action in ('apply','consent') and me.account_type<>'jobseeker' then raise sqlstate 'PT403' using message='A job-seeker account is required.'; end if;
  if p_action='company' then
    if length(coalesce(p_data->>'name','')) not between 2 and 120 or length(coalesce(p_data->>'description',''))>3000
      or length(coalesce(p_data->>'website',''))>300 or (coalesce(p_data->>'website','')<>'' and p_data->>'website' !~ '^https://[^[:space:]]+$')
      then raise sqlstate 'PT400' using message='Invalid company profile.'; end if;
    insert into public.ns_companies values(me.id,jsonb_build_object('name',p_data->>'name','description',p_data->>'description','website',p_data->>'website'))
      on conflict(user_id) do update set data=excluded.data;
  elsif p_action='posting' then
    select data into co from public.ns_companies where user_id=me.id;
    if co is null then raise sqlstate 'PT400' using message='Save your company profile first.'; end if;
    mode:=p_data->>'status';
    if mode is null or mode not in ('draft','open','closed') or length(coalesce(p_data->>'title','')) not between 2 and 120
      or length(coalesce(p_data->>'description','')) not between 80 and 18000 or length(coalesce(p_data->>'country','')) not between 2 and 100
      or length(coalesce(p_data->>'location',''))>150 or length(coalesce(p_data->>'salary',''))>150 or length(coalesce(p_data->>'type',''))>60
      or length(coalesce(p_data->>'skills',''))>500 or jsonb_typeof(p_data->'remote') is distinct from 'boolean'
      then raise sqlstate 'PT400' using message='Invalid job posting.'; end if;
    k:=nullif(p_data->>'id','');
    if k is not null then
      select * into post from public.ns_postings where job_id=k and user_id=me.id for update;
      if not found then raise sqlstate 'PT404' using message='Your posting was not found.'; end if;
    else k:='nextstep-'||gen_random_uuid()::text; end if;
    j:=jsonb_build_object('id',k,'source','Nextstep','title',p_data->>'title','company',co->>'name','country',p_data->>'country',
      'location',p_data->>'location','remote',(p_data->>'remote')::boolean,'tags',to_jsonb(string_to_array(coalesce(p_data->>'skills',''),',')),
      'type',p_data->>'type','salary',p_data->>'salary','description',case when mode='open' then p_data->>'description' else '' end,
      'closed',mode<>'open','url','/','publishedAt',case when post.status='open' then (select data->>'publishedAt' from public.ns_jobs where id=k) else now()::text end,'updatedAt',now());
    insert into public.ns_jobs(id,data,fingerprint,eligible_countries,published_at)
      values(k,j,gen_random_uuid()::text,array[p_data->>'country'],(j->>'publishedAt')::timestamptz)
      on conflict(id) do update set data=excluded.data,fingerprint=excluded.fingerprint,eligible_countries=excluded.eligible_countries,published_at=excluded.published_at;
    insert into public.ns_postings values(k,me.id,mode,p_data) on conflict(job_id) do update set status=excluded.status,content=excluded.content;
    if mode='open' then insert into public.ns_job_events(job_id,kind) values(k,case when post.status='open' then 'updated' else 'new' end);
    elsif post.status='open' then insert into public.ns_job_events(job_id,kind) values(k,'closed'); end if;
    return jsonb_build_object('id',k);
  elsif p_action='apply' then
    if coalesce(p_data->>'consent','false')<>'true' or jsonb_typeof(p_data->'shareCv') is distinct from 'boolean' or length(coalesce(p_data->>'message',''))>2000 then
      raise sqlstate 'PT400' using message='Explicit application consent is required.'; end if;
    select * into post from public.ns_postings where job_id=p_data->>'jobId' and status='open' for update;
    if not found then raise sqlstate 'PT409' using message='This employer posting is no longer open.'; end if;
    if exists(select 1 from public.ns_submissions where job_id=post.job_id and candidate_id=me.id) then raise sqlstate 'PT409' using message='You have already applied.'; end if;
    cv:=case when (p_data->>'shareCv')::boolean then me.cv_path else null end;
    if (p_data->>'shareCv')::boolean and cv is null then raise sqlstate 'PT400' using message='Upload a CV before sharing it.'; end if;
    insert into public.ns_submissions(job_id,candidate_id,message,cv_path) values(post.job_id,me.id,coalesce(p_data->>'message',''),cv);
    insert into public.ns_applications(user_id,job_id,status) values(me.id,post.job_id,'Applied') on conflict do nothing;
  elsif p_action='consent' then
    if jsonb_typeof(p_data->'shareCv') is distinct from 'boolean' or jsonb_typeof(p_data->'withdraw') is distinct from 'boolean'
      or ((p_data->>'shareCv')::boolean and coalesce(p_data->>'consent','false')<>'true') then raise sqlstate 'PT400' using message='Confirm CV sharing or revoke it.'; end if;
    select * into app from public.ns_submissions where job_id=p_data->>'jobId' and candidate_id=me.id for update;
    if not found or app.status='Withdrawn' then raise sqlstate 'PT404' using message='Active application not found.'; end if;
    cv:=case when (p_data->>'shareCv')::boolean then me.cv_path else null end;
    if (p_data->>'shareCv')::boolean and cv is null then raise sqlstate 'PT400' using message='Upload a CV first.'; end if;
    update public.ns_submissions set cv_path=case when (p_data->>'withdraw')::boolean then null else cv end,
      status=case when (p_data->>'withdraw')::boolean then 'Withdrawn' else status end where id=app.id;
    if (p_data->>'withdraw')::boolean then update public.ns_applications set status='Withdrawn',updated_at=now() where user_id=me.id and job_id=app.job_id; end if;
  elsif p_action in ('review','cv') then
    select s.* into app from public.ns_submissions s join public.ns_postings po on po.job_id=s.job_id where s.id=(p_data->>'id')::uuid and po.user_id=me.id for update of s;
    if not found then raise sqlstate 'PT404' using message='Applicant not found.'; end if;
    if app.status='Withdrawn' then raise sqlstate 'PT409' using message='This candidate withdrew.'; end if;
    if p_action='cv' then
      select cv_path into cv from public.ns_profiles where id=app.candidate_id;
      if app.cv_path is null or cv is distinct from app.cv_path then raise sqlstate 'PT404' using message='CV sharing was revoked or the CV changed.'; end if;
      return jsonb_build_object('path',cv);
    end if;
    if coalesce(p_data->>'status','') not in ('Applied','Shortlisted','Interview','Offer','Rejected') or length(coalesce(p_data->>'notes',''))>5000 then raise sqlstate 'PT400' using message='Invalid applicant stage or notes.'; end if;
    update public.ns_submissions set status=p_data->>'status',notes=coalesce(p_data->>'notes',''),interview_at=nullif(p_data->>'interviewAt','')::timestamptz where id=app.id;
    insert into public.ns_activities(user_id,message) values(app.candidate_id,'An employer updated your application to '||(p_data->>'status')||'. Check My applications.');
  else raise sqlstate 'PT404' using message='Recruitment operation not found.';
  end if;
  return '{"ok":true}'::jsonb;
end $$;
revoke all on function public.ns_recruitment(text,jsonb) from public,anon;
grant execute on function public.ns_recruitment(text,jsonb) to authenticated;
create or replace function public.ns_cleanup() returns void
language plpgsql security definer set search_path='' as $$
begin
  delete from public.ns_sessions where expires_at<=now();
  delete from public.ns_rate_limits where until_at<now()-interval '1 day';
  delete from public.ns_telegram_pending where expires_at<=now();
  delete from public.ns_telegram_queue where status in ('sent','failed') and created_at<now()-interval '30 days';
  delete from public.ns_job_events where created_at<now()-interval '90 days';
  delete from public.ns_activities where created_at<now()-interval '90 days';
  delete from public.ns_jobs j where published_at<now()-interval '90 days'
    and not exists(select 1 from public.ns_postings p where p.job_id=j.id)
    and not exists(select 1 from public.ns_applications a where a.job_id=j.id)
    and not exists(select 1 from public.ns_saved s where s.job_id=j.id)
    and not exists(select 1 from public.ns_job_events e where e.job_id=j.id);
end $$;
revoke all on function public.ns_cleanup() from public,anon,authenticated;
grant execute on function public.ns_cleanup() to service_role;
commit;
