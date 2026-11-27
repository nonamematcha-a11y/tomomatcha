-- ============================================================================
-- Bitácora de tickets borrados
-- ----------------------------------------------------------------------------
-- La dueña pidió que, si un ticket se borra por error, quede rastro. Hasta
-- ahora `delete_order` eliminaba la venta sin dejar nada: se pensó para
-- limpiar ventas de prueba, pero en la operación diaria un clic equivocado
-- hacía desaparecer dinero del histórico sin explicación.
--
-- Loyverse resuelve esto no borrando nunca un recibo. Aquí se conserva el
-- borrado (hace falta para limpiar pruebas), pero antes de borrar se guarda
-- una copia completa del ticket en `order_deletions`: quién lo borró, cuándo,
-- y la foto del ticket con sus renglones. La venta sigue sin contar en caja,
-- reportes ni inventario, que es lo que se espera de un borrado; sólo queda
-- la explicación.
--
-- `delete_order` es idéntica a la de `…0012_inventario_exacto.sql` salvo el
-- bloque que inserta la copia, que va antes de cualquier cambio.
-- ============================================================================

create table if not exists order_deletions (
  id               uuid primary key default gen_random_uuid(),
  order_id         uuid        not null,
  folio            integer     not null,
  order_created_at timestamptz not null,
  status           order_status not null,
  payment          payment_method not null,
  total            numeric(12,2) not null default 0,
  snapshot         jsonb       not null,
  deleted_by       uuid references staff (id) on delete set null,
  deleted_by_name  text        not null default '',
  deleted_at       timestamptz not null default now()
);
create index if not exists order_deletions_deleted_at_idx
  on order_deletions (deleted_at desc);

alter table order_deletions enable row level security;
alter table order_deletions force row level security;
revoke all on table order_deletions from anon, authenticated;

create or replace function delete_order(p_order_id uuid, p_staff_id uuid default null)
returns integer
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_order   orders%rowtype;
  v_mov     record;
  v_name    text;
begin
  select * into v_order from orders where id = p_order_id for update;
  if not found then
    raise exception 'El ticket no existe';
  end if;

  if exists (select 1 from cash_closes where date_key = business_day(v_order.created_at)) then
    raise exception 'El corte del día de este ticket ya se cerró; borrarlo descuadraría la caja';
  end if;

  -- Copia del ticket antes de tocar nada.
  select full_name into v_name from staff where id = p_staff_id;

  insert into order_deletions (
    order_id, folio, order_created_at, status, payment, total, snapshot,
    deleted_by, deleted_by_name
  ) values (
    v_order.id, v_order.folio, v_order.created_at, v_order.status, v_order.payment,
    v_order.total,
    to_jsonb(v_order) || jsonb_build_object(
      'items',
      coalesce((
        select jsonb_agg(to_jsonb(oi) order by oi.line_no)
          from order_items oi
         where oi.order_id = p_order_id
      ), '[]'::jsonb)
    ),
    p_staff_id, coalesce(v_name, 'Equipo')
  );

  for v_mov in select * from order_net_usage(p_order_id) loop
    update ingredients
       set stock = round(stock + v_mov.qty, 3)
     where id = v_mov.ingredient_id;
  end loop;

  if v_order.status <> 'cancelado'
     and v_order.customer_id is not null
     and coalesce(v_order.points_earned, 0) <> 0 then
    update customers
       set points = greatest(0, points - v_order.points_earned),
           visits = greatest(0, visits - 1)
     where id = v_order.customer_id;
  end if;

  delete from inventory_movements where order_id = p_order_id;
  delete from loyalty_transactions where order_id = p_order_id;

  delete from orders where id = p_order_id;

  return v_order.folio;
end;
$$;

revoke all on function delete_order(uuid, uuid) from public;
revoke all on function delete_order(uuid, uuid) from anon, authenticated;
grant execute on function delete_order(uuid, uuid) to service_role, postgres;
