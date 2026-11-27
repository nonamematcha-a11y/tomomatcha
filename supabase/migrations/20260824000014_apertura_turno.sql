-- ============================================================================
-- Apertura de turno
-- ----------------------------------------------------------------------------
-- La dueña pidió que el día arranque con una pantalla de «Iniciar día» donde
-- se captura con cuánto efectivo abre el cajón (fondo), como el turno de
-- Loyverse. Hasta ahora el fondo era un número fijo en Ajustes y el día
-- empezaba solo con la primera venta.
--
-- Un registro por día operativo, igual que `cash_closes`: abrir dos veces el
-- mismo día no tiene sentido y la llave única lo impide. `open_shift` se niega
-- si el corte de hoy ya existe (el día ya terminó). El cierre sigue siendo
-- `close_cash`; la pantalla de cierre del punto de venta usa este fondo para
-- calcular el efectivo esperado en el cajón.
--
-- La venta NO se bloquea en la base si no hay apertura: lo exige la pantalla.
-- Así un día sin apertura (por ejemplo, el primero tras publicar esto) no
-- deja la caja trabada a media operación.
-- ============================================================================

create table if not exists shift_opens (
  id             uuid primary key default gen_random_uuid(),
  date_key       date        not null unique,
  opened_at      timestamptz not null default now(),
  opening_float  numeric(12,2) not null default 0 check (opening_float >= 0),
  opened_by      uuid references staff (id) on delete set null,
  opened_by_name text        not null default ''
);
create index if not exists shift_opens_date_idx on shift_opens (date_key desc);

alter table shift_opens enable row level security;
alter table shift_opens force row level security;
revoke all on table shift_opens from anon, authenticated;

create or replace function open_shift(p_float numeric, p_staff_id uuid default null)
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
    raise exception 'El turno de hoy ya se cerró';
  end if;
  if exists (select 1 from shift_opens where date_key = v_day) then
    raise exception 'El día ya se inició';
  end if;

  select full_name into v_name from staff where id = p_staff_id;

  insert into shift_opens (date_key, opening_float, opened_by, opened_by_name)
  values (v_day, round(p_float, 2), p_staff_id, coalesce(v_name, 'Equipo'))
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function open_shift(numeric, uuid) from public;
revoke all on function open_shift(numeric, uuid) from anon, authenticated;
grant execute on function open_shift(numeric, uuid) to service_role, postgres;
