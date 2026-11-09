-- Ключ восстановления. Запускать один раз в Supabase SQL Editor.
-- На сервере лежат только хэш ключа и зашифрованные ответы. Прочитать их без ключа нельзя.

create table if not exists public.ssz_keys (
  game_id text not null,
  uid uuid not null,
  key_hash text not null,
  blob text not null,
  primary key (game_id, uid),
  foreign key (game_id, uid) references public.ssz_players (game_id, uid)
    on update cascade on delete cascade
);

-- Политик нет намеренно: к таблице можно попасть только через две функции ниже.
alter table public.ssz_keys enable row level security;
revoke all on public.ssz_keys from anon, authenticated;

-- Сохранить ключ для своего места в игре.
create or replace function public.ssz_save_key(p_game text, p_key text, p_blob text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or not exists (
    select 1 from public.ssz_players where game_id = p_game and uid = auth.uid()
  ) then
    raise exception 'not_seated';
  end if;
  if length(p_key) < 32 or length(p_blob) > 60000 then
    raise exception 'bad_input';
  end if;
  insert into public.ssz_keys (game_id, uid, key_hash, blob)
  values (p_game, auth.uid(), encode(sha256(convert_to(p_key, 'UTF8')), 'hex'), p_blob)
  on conflict (game_id, uid) do update set key_hash = excluded.key_hash, blob = excluded.blob;
end $$;

-- Вернуть место по ключу: перенести его на текущего пользователя и отдать зашифрованные ответы.
create or replace function public.ssz_reclaim(p_game text, p_key text)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := auth.uid();
  v_old uuid;
  v_blob text;
begin
  if v_me is null then
    raise exception 'bad_key';
  end if;
  select uid, blob into v_old, v_blob from public.ssz_keys
  where game_id = p_game and key_hash = encode(sha256(convert_to(p_key, 'UTF8')), 'hex');
  if not found then
    raise exception 'bad_key';
  end if;
  if v_old <> v_me then
    if exists (select 1 from public.ssz_players where game_id = p_game and uid = v_me) then
      raise exception 'already_seated';
    end if;
    update public.ssz_players set uid = v_me, updated_at = now()
    where game_id = p_game and uid = v_old;
  end if;
  return v_blob;
end $$;

revoke execute on function public.ssz_save_key(text, text, text) from public, anon;
revoke execute on function public.ssz_reclaim(text, text) from public, anon;
grant execute on function public.ssz_save_key(text, text, text) to authenticated;
grant execute on function public.ssz_reclaim(text, text) to authenticated;
