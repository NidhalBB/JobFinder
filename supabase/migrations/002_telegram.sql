begin;

create or replace function public.ns_telegram(p_action text,p_user uuid default null,p_data jsonb default '{}')
returns jsonb language plpgsql security definer set search_path='' as $$
declare pending public.ns_telegram_pending; link public.ns_telegram_links; item public.ns_telegram_queue;
  me public.ns_profiles; cursor_id bigint; new_match boolean; changed boolean; due boolean;
  claim uuid; result jsonb; retry_at timestamptz;
begin
  if p_action='begin' then
    insert into public.ns_telegram_pending(user_id,token_hash,expires_at)
      values(p_user,p_data->>'hash',now()+interval '10 minutes')
      on conflict(user_id) do update set token_hash=excluded.token_hash,expires_at=excluded.expires_at,
        chat_id=null,code_hash=null,attempts=0;
  elsif p_action='start' then
    update public.ns_telegram_pending set chat_id=p_data->>'chat',code_hash=p_data->>'codeHash'
      where token_hash=p_data->>'hash' and expires_at>now() and chat_id is null;
    return jsonb_build_object('claimed',found);
  elsif p_action='failed-code' then
    delete from public.ns_telegram_pending where token_hash=p_data->>'hash' and code_hash=p_data->>'codeHash';
  elsif p_action='confirm' then
    perform pg_advisory_xact_lock(hashtextextended('telegram-confirm',0));
    select * into pending from public.ns_telegram_pending where user_id=p_user for update;
    if pending.user_id is null or pending.chat_id is null or pending.expires_at<=now() then return '{"error":"Start the bot using a fresh connection link first.","status":400}'; end if;
    if pending.code_hash<>p_data->>'codeHash' then
      if pending.attempts>=4 then delete from public.ns_telegram_pending where user_id=p_user;
      else update public.ns_telegram_pending set attempts=attempts+1 where user_id=p_user; end if;
      return '{"error":"Incorrect or expired code. After five attempts, generate a fresh connection link.","status":400}';
    end if;
    if exists(select 1 from public.ns_telegram_links where chat_id=pending.chat_id and user_id<>p_user) then
      return '{"error":"This chat is already linked to another account. Disconnect it there first.","status":409}';
    end if;
    delete from public.ns_telegram_queue where user_id=p_user;
    insert into public.ns_telegram_links(user_id,chat_id,cursor,last_digest)
      values(p_user,pending.chat_id,coalesce((select max(id) from public.ns_job_events),0),now())
      on conflict(user_id) do update set chat_id=excluded.chat_id,enabled=true,cursor=excluded.cursor,last_digest=now();
    delete from public.ns_telegram_pending where user_id=p_user;
    insert into public.ns_activities(user_id,message) values(p_user,'Telegram daily alerts enabled with your consent.');
  elsif p_action in ('disconnect','stop') then
    if p_action='stop' then select user_id into p_user from public.ns_telegram_links where chat_id=p_data->>'chat'; end if;
    delete from public.ns_telegram_queue where user_id=p_user;
    delete from public.ns_telegram_links where user_id=p_user;
    delete from public.ns_telegram_pending where user_id=p_user or (p_action='stop' and chat_id=p_data->>'chat');
  elsif p_action='preferences' then
    update public.ns_telegram_links set enabled=(p_data->>'enabled')::boolean,min_score=(p_data->>'minScore')::integer,
      cursor=coalesce((select max(id) from public.ns_job_events),0),last_digest=now() where user_id=p_user;
    if not found then raise sqlstate 'PT400' using message='Connect Telegram first.'; end if;
    delete from public.ns_telegram_queue where user_id=p_user and status in ('pending','sending');
  elsif p_action='test' then
    if not exists(select 1 from public.ns_telegram_links where user_id=p_user and enabled) then
      raise sqlstate 'PT400' using message='Connect and enable Telegram first.';
    end if;
    perform pg_advisory_xact_lock(hashtextextended('telegram-test:'||p_user::text,0));
    if exists(select 1 from public.ns_telegram_queue where user_id=p_user and event_key like 'test:%' and created_at>now()-interval '15 minutes') then
      raise sqlstate 'PT429' using message='A test was already queued. Try again in 15 minutes.';
    end if;
    insert into public.ns_telegram_queue(user_id,event_key,text)
      values(p_user,'test:'||extract(epoch from now())::bigint,'Nextstep test: your private alerts are connected.'||chr(10)||(p_data->>'origin')||chr(10)||'Send /stop to unsubscribe.');
  elsif p_action='prepare' then
    if exists(select 1 from public.ns_meta where key='lastAttempt'
      and (value #>> '{}')::timestamptz>now()-interval '2 minutes'
      and (value #>> '{}')::timestamptz>coalesce((select (value #>> '{}')::timestamptz from public.ns_meta where key='lastSuccess'),'-infinity'::timestamptz)) then
      return '{"deferred":true}';
    end if;
    select coalesce(max(id),0) into cursor_id from public.ns_job_events;
    for link in select * from public.ns_telegram_links where enabled and last_digest<=now()-interval '24 hours'
      order by last_digest limit 100 for update skip locked loop
      select * into me from public.ns_profiles where id=link.user_id;
      select exists(select 1 from public.ns_job_events e join public.ns_jobs j on j.id=e.job_id
        where me.agent_enabled and e.id>link.cursor and e.id<=cursor_id and e.kind='new'
          and me.country=any(j.eligible_countries)
          and (public.ns_match(j.data,j.eligible_countries,public.ns_profile_json(me))->>'workMatch')::boolean
          and (public.ns_match(j.data,j.eligible_countries,public.ns_profile_json(me))->>'score')::integer>=link.min_score) into new_match;
      select exists(select 1 from public.ns_job_events e join public.ns_applications a on a.job_id=e.job_id
        where e.id>link.cursor and e.id<=cursor_id and e.kind='updated' and a.user_id=link.user_id) into changed;
      select exists(select 1 from public.ns_applications where user_id=link.user_id
        and follow_up<=(now() at time zone 'UTC')::date and status not in ('Offer','Rejected','Withdrawn')) into due;
      if new_match or changed or due then
        insert into public.ns_telegram_queue(user_id,event_key,text)
          values(link.user_id,'digest:'||to_char(now() at time zone 'UTC','YYYY-MM-DD'),
            'Nextstep daily update'||chr(10)||concat_ws(chr(10),
              case when new_match then 'New matching positions are available.' end,
              case when changed then 'A tracked job listing has changed.' end,
              case when due then 'An application follow-up is due.' end)||
              chr(10)||'Review details privately: '||(p_data->>'origin')||chr(10)||'Send /stop to unsubscribe.')
          on conflict(user_id,event_key) do nothing;
      end if;
      update public.ns_telegram_links set cursor=cursor_id,last_digest=now() where user_id=link.user_id;
    end loop;
  elsif p_action='claim' then
    if exists(select 1 from public.ns_meta where key='telegramBackoff' and (value #>> '{}')::timestamptz>now()) then return '[]'; end if;
    update public.ns_telegram_queue set status='failed',error='Delivery stopped after five attempts. Use Send test to retry.'
      where attempts>=5 and (status='pending' or (status='sending' and lease_expires<=now()));
    claim:=(p_data->>'lease')::uuid;
    with candidates as (
      select q.id from public.ns_telegram_queue q join public.ns_telegram_links l using(user_id)
        where l.enabled and q.attempts<5 and
          ((q.status='pending' and q.next_attempt<=now()) or (q.status='sending' and q.lease_expires<=now()))
        order by q.id limit least(5,greatest(1,coalesce((p_data->>'limit')::integer,5))) for update of q skip locked
    ), claimed as (
      update public.ns_telegram_queue q set status='sending',lease_id=claim,lease_expires=now()+interval '2 minutes',attempts=attempts+1
        from candidates c where q.id=c.id returning q.*
    )
    select coalesce(jsonb_agg(to_jsonb(c)||jsonb_build_object('chat_id',l.chat_id)),'[]')
      into result from claimed c join public.ns_telegram_links l using(user_id);
    return result;
  elsif p_action='finish' then
    select * into item from public.ns_telegram_queue where id=(p_data->>'id')::bigint and lease_id=(p_data->>'lease')::uuid for update;
    if item.id is null then return '{"cancelled":true}'; end if;
    retry_at:=now()+make_interval(secs=>least(86400,greatest(1,coalesce((p_data->>'retryAfter')::integer,60))));
    update public.ns_telegram_queue set
      status=case when p_data->>'result'='sent' then 'sent' when p_data->>'result'='blocked' or item.attempts>=5 then 'failed' else 'pending' end,
      error=p_data->>'error',next_attempt=retry_at,lease_id=null,lease_expires=null where id=item.id;
    if p_data->>'result'='blocked' then update public.ns_telegram_links set enabled=false where user_id=item.user_id; end if;
    if p_data->>'result'='limited' then insert into public.ns_meta values('telegramBackoff',to_jsonb(retry_at))
      on conflict(key) do update set value=excluded.value; end if;
  else raise sqlstate 'PT400' using message='Unknown Telegram operation.';
  end if;
  return '{"ok":true}';
end $$;
revoke all on function public.ns_telegram(text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.ns_telegram(text,uuid,jsonb) to service_role;

create or replace function public.ns_cleanup() returns void
language plpgsql security definer set search_path='' as $$
begin
  delete from public.ns_sessions where expires_at<=now();
  delete from public.ns_rate_limits where until_at<now()-interval '1 day';
  delete from public.ns_telegram_pending where expires_at<=now();
  delete from public.ns_telegram_queue where status in ('sent','failed') and created_at<now()-interval '30 days';
  delete from public.ns_job_events where created_at<now()-interval '90 days';
  delete from public.ns_activities a where created_at<now()-interval '90 days';
  delete from public.ns_jobs j where published_at<now()-interval '90 days'
    and not exists(select 1 from public.ns_applications a where a.job_id=j.id)
    and not exists(select 1 from public.ns_saved s where s.job_id=j.id)
    and not exists(select 1 from public.ns_job_events e where e.job_id=j.id);
end $$;
revoke all on function public.ns_cleanup() from public,anon,authenticated;
grant execute on function public.ns_cleanup() to service_role;

commit;
