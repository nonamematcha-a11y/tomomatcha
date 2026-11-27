"use client";

/* ============================================================================
 * Turno del día: apertura y cierre desde el punto de venta.
 *
 * Pedido de la dueña, al estilo de los turnos de Loyverse: al entrar al punto
 * de venta sin haber iniciado el día aparece un aviso al centro que no deja
 * vender hasta capturar con cuánto efectivo abre el cajón. Al terminar, el
 * mismo punto de venta cierra el turno (cuenta el efectivo y registra el
 * corte con `close_cash`) y enseña los resultados del día.
 *
 * El fondo se guarda en `shift_opens` (`…0014_apertura_turno.sql`). El corte
 * sigue midiendo el efectivo de ventas, sin fondo, igual que la pantalla de
 * Corte de caja: aquí se pide lo que hay en el cajón (fondo incluido) y se le
 * resta el fondo antes de registrarlo, para que ambas pantallas cuadren.
 * ========================================================================== */

import { useState } from "react";
import { closeCash, openShift } from "@/lib/actions";
import { useDerived, useStore } from "@/lib/store";
import { money, time } from "@/lib/format";
import { cx, Input, Modal, numericText } from "@/components/ui";

/* --------------------------------- Apertura --------------------------------- */

export function ShiftStartOverlay() {
  const { state, currency, submit, busy } = useStore();
  const [float, setFloat] = useState(
    state.settings.cashFloat > 0 ? String(state.settings.cashFloat) : "",
  );

  const today = new Date().toLocaleDateString("es-MX", {
    timeZone: state.settings.timezone,
    weekday: "long",
    day: "numeric",
    month: "long",
  });
  const amount = Number(float) || 0;

  const start = () =>
    submit(() => openShift(amount), {
      title: "Día iniciado",
      detail: `Fondo de caja ${money(amount, currency)}`,
    });

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="shift-start-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/60 p-4 backdrop-blur-sm"
    >
      <div className="animate-rise w-full max-w-md overflow-hidden rounded-3xl bg-white shadow-lift motion-reduce:animate-none">
        <div
          className="px-6 pb-6 pt-8 text-center text-paper"
          style={{
            background:
              "radial-gradient(120% 140% at 100% 0%, rgba(122,140,84,0.55), transparent 55%), #191a14",
          }}
        >
          <span aria-hidden className="text-5xl">
            ☀️
          </span>
          <p className="mt-3 text-[11px] font-extrabold uppercase tracking-[0.25em] text-paper/60">
            {today}
          </p>
          <h2 id="shift-start-title" className="display mt-1 text-3xl">
            Iniciar día
          </h2>
          <p className="mt-2 text-sm text-paper/70">
            Antes de vender, cuenta el efectivo con el que abre la caja.
          </p>
        </div>

        <form
          className="space-y-4 p-6"
          onSubmit={(e) => {
            e.preventDefault();
            void start();
          }}
        >
          <label className="block">
            <span className="eyebrow">Fondo de caja · ¿cuánto hay?</span>
            <span className="relative mt-2 block">
              <span
                aria-hidden
                className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-2xl font-extrabold text-muted"
              >
                $
              </span>
              <Input
                type="text"
                inputMode="decimal"
                autoComplete="off"
                autoFocus
                aria-label="Fondo de caja"
                placeholder="0"
                value={float}
                onChange={(e) => {
                  const text = numericText(e.target.value);
                  if (text !== null) setFloat(text);
                }}
                className="h-16 rounded-2xl !pl-10 text-3xl font-extrabold"
              />
            </span>
          </label>
          <button
            type="submit"
            disabled={busy}
            className="focus-ring flex h-16 w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-matcha-deep to-matcha text-lg font-extrabold text-paper shadow-pop transition hover:brightness-110 disabled:opacity-60"
          >
            {busy ? "Iniciando…" : `Iniciar día con ${money(amount, currency)}`}
          </button>
          <p className="text-center text-xs text-muted">
            Si la caja abre vacía, deja el fondo en $0.
          </p>
        </form>
      </div>
    </div>
  );
}

/* ---------------------------------- Cierre ---------------------------------- */

function Row({
  label,
  value,
  strong,
  tone,
}: {
  label: string;
  value: string;
  strong?: boolean;
  tone?: "ok" | "bad" | "warn";
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-2">
      <span className={cx("text-sm", strong ? "font-extrabold text-ink" : "text-muted")}>
        {label}
      </span>
      <span
        className={cx(
          "tabular-nums",
          strong ? "display text-2xl" : "font-bold",
          tone === "ok" && "text-matcha-deep",
          tone === "bad" && "text-danger",
          tone === "warn" && "text-amber",
          !tone && "text-ink",
        )}
      >
        {value}
      </span>
    </div>
  );
}

export function ShiftCloseModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { state, currency, submit, busy, tz } = useStore();
  const { todayOrders, todayClose } = useDerived();
  const [counted, setCounted] = useState("");

  const isAdmin = state.role === "admin";
  const fondo = state.todayShift?.openingFloat ?? 0;

  const cashSales = todayOrders
    .filter((o) => o.payment === "efectivo")
    .reduce((sum, o) => sum + o.total, 0);
  const otherSales = todayOrders
    .filter((o) => o.payment !== "efectivo")
    .reduce((sum, o) => sum + o.total, 0);
  const tips = todayOrders.reduce((sum, o) => sum + o.tip, 0);
  const expectedDrawer = Math.round((fondo + cashSales) * 100) / 100;

  const countedNum = Number(counted) || 0;
  const diff = Math.round((countedNum - expectedDrawer) * 100) / 100;
  const diffTone = diff === 0 ? "ok" : diff < 0 ? "bad" : "warn";

  const close = async () => {
    // El corte guarda el efectivo de ventas: lo contado menos el fondo.
    const net = Math.max(Math.round((countedNum - fondo) * 100) / 100, 0);
    await submit(
      () =>
        closeCash(
          net,
          countedNum < fondo
            ? "En el cajón había menos que el fondo de apertura."
            : undefined,
        ),
      { title: "Turno cerrado" },
    );
    setCounted("");
  };

  const signed = (n: number) =>
    `${n > 0 ? "+" : n < 0 ? "−" : ""}${money(Math.abs(n), currency)}`;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={todayClose ? "Resultados del día" : "Terminar turno"}
    >
      {todayClose ? (
        /* ------------------------------ Resultados ------------------------------ */
        <div className="space-y-4">
          <div
            className="rounded-3xl px-6 py-6 text-center text-paper"
            style={{
              background:
                "radial-gradient(120% 140% at 100% 0%, rgba(122,140,84,0.55), transparent 55%), #191a14",
            }}
          >
            <p className="text-[11px] font-extrabold uppercase tracking-[0.25em] text-paper/60">
              Venta del día
            </p>
            <p className="display mt-2 text-5xl tabular-nums">
              {money(todayClose.expectedCash + todayClose.expectedCard, currency)}
            </p>
            <p className="mt-2 text-xs text-paper/60">
              {todayClose.orders} {todayClose.orders === 1 ? "ticket" : "tickets"} · cerró{" "}
              {todayClose.closedBy} a las {time(todayClose.closedAt, tz)}
            </p>
          </div>
          <div className="divide-y divide-line rounded-2xl border border-line px-4">
            <Row label="Efectivo de ventas" value={money(todayClose.expectedCash, currency)} />
            <Row label="Tarjeta y otros" value={money(todayClose.expectedCard, currency)} />
            {todayClose.tipsTotal > 0 ? (
              <Row label="Propinas" value={money(todayClose.tipsTotal, currency)} />
            ) : null}
            <Row label="Fondo de apertura" value={money(fondo, currency)} />
            <Row
              label="Esperado en cajón"
              value={money(fondo + todayClose.expectedCash, currency)}
            />
            <Row
              label="Contado en cajón"
              value={money(fondo + todayClose.countedCash, currency)}
            />
            <Row
              label={
                todayClose.difference === 0
                  ? "Cuadra exacto"
                  : todayClose.difference < 0
                    ? "Faltante"
                    : "Sobrante"
              }
              value={signed(todayClose.difference)}
              strong
              tone={
                todayClose.difference === 0
                  ? "ok"
                  : todayClose.difference < 0
                    ? "bad"
                    : "warn"
              }
            />
          </div>
          <button
            type="button"
            onClick={onClose}
            className="focus-ring flex h-14 w-full items-center justify-center rounded-2xl bg-ink text-base font-extrabold text-paper transition hover:bg-ink-soft"
          >
            Listo
          </button>
        </div>
      ) : (
        /* -------------------------------- Cierre -------------------------------- */
        <div className="space-y-4">
          <div className="divide-y divide-line rounded-2xl border border-line px-4">
            <Row label={`Tickets de hoy`} value={String(todayOrders.length)} />
            <Row label="Efectivo de ventas" value={money(cashSales, currency)} />
            <Row label="Tarjeta y otros" value={money(otherSales, currency)} />
            {tips > 0 ? <Row label="Propinas" value={money(tips, currency)} /> : null}
            <Row
              label={`Fondo de apertura${state.todayShift ? ` · ${state.todayShift.openedBy}` : ""}`}
              value={money(fondo, currency)}
            />
            <Row label="Debe haber en cajón" value={money(expectedDrawer, currency)} strong />
          </div>

          {isAdmin ? (
            <>
              <label className="block">
                <span className="eyebrow">¿Cuánto efectivo hay en el cajón?</span>
                <span className="relative mt-2 block">
                  <span
                    aria-hidden
                    className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-xl font-extrabold text-muted"
                  >
                    $
                  </span>
                  <Input
                    type="text"
                    inputMode="decimal"
                    autoComplete="off"
                    aria-label="Efectivo contado en el cajón"
                    placeholder="Cuenta billetes y monedas"
                    value={counted}
                    onChange={(e) => {
                      const text = numericText(e.target.value);
                      if (text !== null) setCounted(text);
                    }}
                    className="h-14 rounded-2xl !pl-9 text-xl font-extrabold"
                  />
                </span>
              </label>
              {counted !== "" ? (
                <p
                  className={cx(
                    "text-center text-sm font-extrabold",
                    diffTone === "ok" && "text-matcha-deep",
                    diffTone === "bad" && "text-danger",
                    diffTone === "warn" && "text-amber",
                  )}
                >
                  {diff === 0
                    ? "Cuadra exacto ✓"
                    : diff < 0
                      ? `Faltan ${money(-diff, currency)}`
                      : `Sobran ${money(diff, currency)}`}
                </p>
              ) : null}
              <button
                type="button"
                disabled={busy || counted === ""}
                onClick={() => void close()}
                className="focus-ring flex h-16 w-full items-center justify-center rounded-2xl bg-ink text-lg font-extrabold text-paper shadow-lift transition hover:bg-ink-soft disabled:cursor-not-allowed disabled:opacity-40"
              >
                {busy ? "Cerrando…" : "Cerrar turno y ver resultados"}
              </button>
              <p className="text-center text-xs text-muted">
                Después de cerrar ya no se puede cobrar hoy, salvo que un
                administrador reabra el turno en Corte de caja.
              </p>
            </>
          ) : (
            <p className="rounded-2xl bg-cream px-4 py-3 text-center text-sm text-muted">
              Solo un administrador puede cerrar el turno.
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}
