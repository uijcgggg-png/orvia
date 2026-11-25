create extension if not exists pgcrypto with schema extensions;
create table if not exists public.devices(
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null default auth.uid() references auth.users on delete cascade,
 name text not null default 'My PC',
 platform text not null default 'windows',
 paired boolean not null default false,
 pair_code text unique, pair_expires timestamptz, secret_hash text,
 last_seen timestamptz, created_at timestamptz not null default now());
create table if not exists public.commands(
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null default auth.uid() references auth.users on delete cascade,
 device_id uuid not null references public.devices on delete cascade,
 action text not null, args jsonb not null default '{}',
 status text not null default 'pending', result text,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create index if not exists commands_dev on public.commands(device_id,status,created_at);
alter table public.devices enable row level security;
alter table public.commands enable row level security;
drop policy if exists dev_sel on public.devices; create policy dev_sel on public.devices for select to authenticated using (user_id=auth.uid());
drop policy if exists dev_del on public.devices; create policy dev_del on public.devices for delete to authenticated using (user_id=auth.uid());
drop policy if exists cmd_sel on public.commands; create policy cmd_sel on public.commands for select to authenticated using (user_id=auth.uid());
revoke all on public.devices, public.commands from anon, authenticated;
grant select(id,name,platform,paired,last_seen,created_at) on public.devices to authenticated;
grant delete on public.devices to authenticated;
grant select on public.commands to authenticated;

create or replace function public.create_pairing(p_name text default 'My PC', p_platform text default 'windows')
returns json language plpgsql security definer set search_path=public,extensions as $$
declare c text; d uuid;
begin
 if auth.uid() is null then raise exception 'auth'; end if;
 if (select count(*) from devices where user_id=auth.uid())>=5 then raise exception 'too many devices'; end if;
 delete from devices where user_id=auth.uid() and not paired and pair_expires<now();
 c:=lpad((('x'||encode(gen_random_bytes(4),'hex'))::bit(32)::bigint % 100000000)::text,8,'0');
 insert into devices(user_id,name,platform,pair_code,pair_expires) values(auth.uid(),left(coalesce(p_name,'My PC'),40),case when p_platform in ('windows','android') then p_platform else 'windows' end,c,now()+interval '10 minutes') returning id into d;
 return json_build_object('device_id',d,'code',c);
end$$;

create or replace function public.claim_pairing(p_code text)
returns json language plpgsql security definer set search_path=public,extensions as $$
declare d devices; s text;
begin
 select * into d from devices where pair_code=p_code and not paired and pair_expires>now() for update;
 if not found then raise exception 'bad code'; end if;
 s:=encode(gen_random_bytes(24),'hex');
 update devices set paired=true,pair_code=null,secret_hash=encode(digest(s,'sha256'),'hex'),last_seen=now() where id=d.id;
 return json_build_object('device_id',d.id,'secret',s,'name',d.name);
end$$;

create or replace function public.device_poll(p_device uuid, p_secret text)
returns setof public.commands language plpgsql security definer set search_path=public,extensions as $$
begin
 if not exists(select 1 from devices where id=p_device and secret_hash=encode(digest(p_secret,'sha256'),'hex')) then raise exception 'unauthorized'; end if;
 update devices set last_seen=now() where id=p_device;
 update commands set status='expired',updated_at=now() where device_id=p_device and status='pending' and created_at<now()-interval '2 minutes';
 return query update commands set status='sent',updated_at=now() where device_id=p_device and status='pending' returning *;
end$$;

create or replace function public.device_report(p_device uuid, p_secret text, p_cmd uuid, p_status text, p_result text)
returns void language plpgsql security definer set search_path=public,extensions as $$
begin
 if not exists(select 1 from devices where id=p_device and secret_hash=encode(digest(p_secret,'sha256'),'hex')) then raise exception 'unauthorized'; end if;
 if p_status not in ('done','rejected','failed') then raise exception 'bad status'; end if;
 update commands set status=p_status,result=left(p_result,900000),updated_at=now() where id=p_cmd and device_id=p_device;
end$$;

create or replace function public.send_command(p_device uuid, p_action text, p_args jsonb default '{}')
returns uuid language plpgsql security definer set search_path=public,extensions as $$
declare i uuid;
begin
 if auth.uid() is null then raise exception 'auth'; end if;
 if not exists(select 1 from devices where id=p_device and user_id=auth.uid() and paired) then raise exception 'no such device'; end if;
 if p_action not in ('open_url','open_app','volume','lock','screenshot','type_text') then raise exception 'action not allowed'; end if;
 if length(p_args::text)>4000 then raise exception 'too big'; end if;
 if (select count(*) from commands where user_id=auth.uid() and created_at>now()-interval '1 minute')>=12 then raise exception 'rate limit'; end if;
 insert into commands(user_id,device_id,action,args) values(auth.uid(),p_device,p_action,coalesce(p_args,'{}')) returning id into i;
 return i;
end$$;

revoke all on function public.create_pairing(text,text),public.claim_pairing(text),public.device_poll(uuid,text),public.device_report(uuid,text,uuid,text,text),public.send_command(uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.create_pairing(text,text),public.send_command(uuid,text,jsonb) to authenticated;
grant execute on function public.claim_pairing(text),public.device_poll(uuid,text),public.device_report(uuid,text,uuid,text,text) to anon;
-- Reverse pairing: the DEVICE makes a long random code; the signed-in user claims it (single use, 40 s).
alter table public.devices alter column user_id drop not null;
alter table public.devices alter column user_id drop default;
drop function if exists public.create_pairing(text,text);
drop function if exists public.claim_pairing(text);
create table if not exists public.claim_attempts(user_id uuid, ts timestamptz default now());
alter table public.claim_attempts enable row level security;
revoke all on public.claim_attempts from anon, authenticated;

create or replace function public.device_register(p_name text default 'My phone', p_platform text default 'android')
returns json language plpgsql security definer set search_path=public,extensions as $$
declare c text; s text; d uuid; e timestamptz;
begin
 delete from devices where not paired and pair_expires < now()-interval '2 minutes';
 if (select count(*) from devices where not paired)>3000 then raise exception 'busy'; end if;
 c:=upper(encode(gen_random_bytes(15),'hex'));
 s:=encode(gen_random_bytes(24),'hex');
 e:=now()+interval '40 seconds';
 insert into devices(user_id,name,platform,pair_code,pair_expires,secret_hash)
  values(null,left(coalesce(p_name,'My phone'),40),case when p_platform in ('windows','android') then p_platform else 'android' end,c,e,encode(digest(s,'sha256'),'hex')) returning id into d;
 return json_build_object('device_id',d,'secret',s,'code',c,'expires_at',e);
end$$;

create or replace function public.device_status(p_device uuid, p_secret text)
returns json language plpgsql security definer set search_path=public,extensions as $$
declare d devices;
begin
 select * into d from devices where id=p_device and secret_hash=encode(digest(p_secret,'sha256'),'hex');
 if not found then raise exception 'unauthorized'; end if;
 update devices set last_seen=now() where id=p_device;
 return json_build_object('paired',d.paired,'expired',(not d.paired and d.pair_expires<now()));
end$$;

create or replace function public.claim_device(p_code text)
returns json language plpgsql security definer set search_path=public,extensions as $$
declare n text; d uuid; nm text;
begin
 if auth.uid() is null then raise exception 'auth'; end if;
 insert into claim_attempts(user_id) values(auth.uid());
 delete from claim_attempts where ts<now()-interval '1 hour';
 if (select count(*) from claim_attempts where user_id=auth.uid() and ts>now()-interval '1 minute')>10 then raise exception 'too many attempts'; end if;
 if (select count(*) from devices where user_id=auth.uid())>=5 then raise exception 'too many devices'; end if;
 n:=upper(regexp_replace(coalesce(p_code,''),'[^0-9A-Za-z]','','g'));
 if left(n,3)='ORV' then n:=substr(n,4); end if;
 update devices set user_id=auth.uid(),paired=true,pair_code=null,pair_expires=null,last_seen=now()
  where pair_code=n and not paired and user_id is null and pair_expires>now() returning id,name into d,nm;
 if d is null then raise exception 'invalid or expired code'; end if;
 return json_build_object('device_id',d,'name',nm);
end$$;

create or replace function public.device_poll(p_device uuid, p_secret text)
returns setof public.commands language plpgsql security definer set search_path=public,extensions as $$
begin
 if not exists(select 1 from devices where id=p_device and secret_hash=encode(digest(p_secret,'sha256'),'hex')) then raise exception 'unauthorized'; end if;
 update devices set last_seen=now() where id=p_device;
 if not exists(select 1 from devices where id=p_device and paired) then return; end if;
 update commands set status='expired',updated_at=now() where device_id=p_device and status='pending' and created_at<now()-interval '2 minutes';
 return query update commands set status='sent',updated_at=now() where device_id=p_device and status='pending' returning *;
end$$;

create or replace function public.send_command(p_device uuid, p_action text, p_args jsonb default '{}')
returns uuid language plpgsql security definer set search_path=public,extensions as $$
declare i uuid;
begin
 if auth.uid() is null then raise exception 'auth'; end if;
 if not exists(select 1 from devices where id=p_device and user_id=auth.uid() and paired) then raise exception 'no such device'; end if;
 if p_action not in ('open_url','open_app','volume','lock','screenshot','type_text','go_home','go_back') then raise exception 'action not allowed'; end if;
 if length(p_args::text)>4000 then raise exception 'too big'; end if;
 if (select count(*) from commands where user_id=auth.uid() and created_at>now()-interval '1 minute')>=12 then raise exception 'rate limit'; end if;
 insert into commands(user_id,device_id,action,args) values(auth.uid(),p_device,p_action,coalesce(p_args,'{}')) returning id into i;
 return i;
end$$;

revoke all on function public.device_register(text,text),public.device_status(uuid,text),public.claim_device(text),public.device_poll(uuid,text),public.send_command(uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.claim_device(text),public.send_command(uuid,text,jsonb) to authenticated;
grant execute on function public.device_register(text,text),public.device_status(uuid,text),public.device_poll(uuid,text),public.device_report(uuid,text,uuid,text,text) to anon;
