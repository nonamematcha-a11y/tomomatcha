-- ============================================================================
-- Cambio de turno sin cerrar el día
-- ----------------------------------------------------------------------------
-- En la tienda hay relevos: la dueña atiende de 7 a 12 y después entra la
-- barista. Eso no es cerrar el día (el corte es uno solo, en la noche); es
-- entregar la caja. `…0014` permitía una sola apertura por día; aquí cada día
-- puede tener varios turnos, con a lo más uno abierto a la vez.
--
-- `handover_shift` hace el relevo en una sola transacción: cierra el turno
-- abierto con lo que se contó en el cajón (y lo que debía haber: su fondo más
-- el efectivo cobrado durante su turno) y abre el siguiente con ese mismo
-- efectivo como fondo, a nombre de quien entra. El corte del día sigue siendo
-- `close_cash`, sin cambios.
-- ============================================================================

alter table shift_opens drop constraint if exists shift_opens_date_key_key;

alter table shift_opens
  add column if not exists worker_name     text not null default '',
  add column if not exists closed_at       timestamptz,
  add column if not exists closed_by_name  text,
  add column if not exists counted_drawer  numeric(12,2),
  add column if not exists expected_drawer numeric(12,2);

update shift_opens set worker_name = opened_by_name where worker_name = '';

-- A lo más un turno abierto por día.
create unique index if not exists shift_opens_one_open_per_day
  on shift_opens (date_key) where closed_at is null;
create index if not exists shift_opens_opened_idx on shift_opens (opened_at desc);

drop function if exists open_shift(numeric, uuid);

create or replace function open_shift(
  p_float numeric,
  p_staff_id uuid default null,
  p_worker text default null
)
returns uuid
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_day  date := business_day();
  v_name text;
  v_id   uuid;
begin
  if p_float is null or p_float < 0 then
    raise exception 'El fondo de caja no puede ser negativo';
  end if;
  if exists (select 1 from cash_closes where date_key = v_day) then
    raise exception 'El día de hoy ya se cerró';
  end if;
  if exists (select 1 from shift_opens where date_key = v_day and closed_at is null) then
    raise exception 'Ya hay un turno abierto; usa «Cambiar turno»';
  end if;

  select full_name into v_name from staff where id = p_staff_id;

  insert into shift_opens (date_key, opening_float, opened_by, opened_by_name, worker_name)
  values (
    v_day, round(p_float, 2), p_staff_id, coalesce(v_name, 'Equipo'),
    coalesce(nullif(trim(p_worker), ''), v_name, 'Equipo')
  )
  returning id into v_id;

  return v_id;
end;
$$;

create or replace function handover_shift(
  p_counted numeric,
  p_staff_id uuid default null,
  p_next_worker text default null
)
returns uuid
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_day      date := business_day();
  v_shift    shift_opens%rowtype;
  v_cash     numeric(12,2);
  v_name     text;
  v_id       uuid;
begin
  if p_counted is null or p_counted < 0 then
    raise exception 'El efectivo contado no puede ser negativo';
  end if;
  if exists (select 1 from cash_closes where date_key = v_day) then
    raise exception 'El día de hoy ya se cerró';
  end if;

  select * into v_shift
    from shift_opens
   where date_key = v_day and closed_at is null
   for update;
  if not found then
    raise exception 'No hay un turno abierto para entregar';
  end if;

  select coalesce(sum(total), 0) into v_cash
    from orders
   where payment = 'efectivo'
     and status <> 'cancelado'
     and created_at >= v_shift.opened_at;

  select full_name into v_name from staff where id = p_staff_id;

  update shift_opens
     set closed_at = now(),
         closed_by_name = coalesce(v_name, 'Equipo'),
         counted_drawer = round(p_counted, 2),
         expected_drawer = round(v_shift.opening_float + v_cash, 2)
   where id = v_shift.id;

  insert into shift_opens (date_key, opening_float, opened_by, opened_by_name, worker_name)
  values (
    v_day, round(p_counted, 2), p_staff_id, coalesce(v_name, 'Equipo'),
    coalesce(nullif(trim(p_next_worker), ''), 'Equipo')
  )
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function open_shift(numeric, uuid, text) from public;
revoke all on function open_shift(numeric, uuid, text) from anon, authenticated;
grant execute on function open_shift(numeric, uuid, text) to service_role, postgres;
revoke all on function handover_shift(numeric, uuid, text) from public;
revoke all on function handover_shift(numeric, uuid, text) from anon, authenticated;
grant execute on function handover_shift(numeric, uuid, text) to service_role, postgres;
